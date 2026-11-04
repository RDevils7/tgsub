/**
 * 概览页数据聚合。
 *
 * 界面要「一眼看清现在到底在用什么」：工具的版本、状态、可执行文件在哪，
 * 服务有没有连上，磁盘还剩多少。这些信息原本散落在 /health、/scan/state、
 * /ffmpeg、/platform/status、/network、/emby/status 六七个接口里，
 * 概览页若逐个去调，既慢又要处理各自的失败。这里一次性收齐，前端只调一个接口。
 *
 * 设计取舍：
 * - 慢的探测（ffmpeg --version、yt-dlp --version、chromium --version）都有缓存，
 *   整个报告默认缓存 30 秒，?refresh=1 才重新 spawn；
 * - 不为了展示去启动浏览器 / 连 Telegram，只读取现有状态（getAuthState 自带 8 秒缓存）；
 * - 采集失败一律降级成一条 warn/error 记录，绝不让概览页 500。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { env, isDirWritable } from "../env";
import { db, getEmbyKeyHint, getPlatformCookieHint, getSessionMeta, getSettings } from "../db";
import { APP_VERSION } from "../version";
import { ffmpegInfo } from "../tg/ffmpeg";
import { ytdlpInfo, clearYtdlpCache } from "../platform/ytdlp";
import { engineState } from "../platform/updater";
import { loadSharp } from "../tg/sharp";
import { browserStatus } from "../tg/m3u8Browser";
import { getSchedulerState } from "../tg/scanner";
import { downloader } from "../tg/downloader";
import { getAuthState, sdkLoaded, type AuthState } from "../tg/client";
import { getBotState } from "../tg/bot";
import { getEmbyNotifyState } from "../tg/embyapi";
import { explainProxyProblem, parseProxy, telegramProxyUnsupported } from "../lib/netprobe";
import { DIR_KEYS, DIR_LABEL, parseDirSetting, type DirKey } from "../tg/mediadir";
import { routeMode } from "../tg/m3u8";
import { PLATFORM_IDS } from "../types";
import { getAccount, activeSessionCount } from "../auth/service";
import { diskLevel, summarizeProbes, toolStatus, type OverviewSummary, type ProbeStatus } from "./overviewFormat";

/* ------------------------------------------------------------------ */
/* 对外的数据结构（前端 types.ts 有一份镜像）                          */
/* ------------------------------------------------------------------ */

export interface ToolProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  /** 版本号；拿不到就是 null */
  version: string | null;
  /** 可执行文件 / 模块 / 数据文件的绝对路径 */
  path: string | null;
  /** 这个二进制是从哪找来的 */
  source: string | null;
  /** 补充说明或异常原因 */
  note: string | null;
  /** 影响哪些功能，鼠标悬停时能看到 */
  usedBy: string;
}

export interface ServiceProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  value: string;
  note: string | null;
  /** 点击后跳哪个页面 */
  page: "settings" | "channels" | "downloads" | "logs" | "manual" | "metadata" | null;
}

export interface StorageDirProbe {
  id: DirKey;
  label: string;
  /** 相对下载根；空字符串表示直接放下载根 */
  rel: string;
  absolute: string;
  exists: boolean;
  writable: boolean;
  error: string | null;
}

export interface OverviewReport {
  at: number;
  elapsedMs: number;
  /** 本次是缓存命中还是重新采集 */
  cached: boolean;
  runtime: {
    version: string;
    node: string;
    platform: string;
    arch: string;
    os: string;
    cpus: number;
    totalMemory: number;
    workDir: string;
    pid: number;
    uptime: number;
    startedAt: number;
    timezone: string;
    resolvedTimezone: string;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
    inContainer: boolean;
  };
  storage: {
    dataDir: string;
    downloadDir: string;
    dbFile: string;
    dbSize: number;
    dbTables: number;
    dbRows: number;
    cacheLimitMb: number;
    writable: { data: boolean; downloads: boolean };
    disk: { total: number; free: number; used: number; percent: number; status: ProbeStatus } | null;
    dirs: StorageDirProbe[];
  };
  tools: ToolProbe[];
  services: ServiceProbe[];
  summary: OverviewSummary;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const CACHE_MS = 30_000;

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 目录不存在时看它最近一个存在的祖先能不能写，比直接返回 false 有用 */
function writableDir(dir: string): boolean {
  let cur = path.resolve(dir);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(cur)) return isDirWritable(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

/** 从包入口向上找 package.json，返回版本与包目录（exports 限制的模块也能找到） */
function readPackage(name: string): { version: string | null; dir: string | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const entry = require.resolve(name);
    let dir = path.dirname(entry);
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
          if (pkg.version && (!pkg.name || pkg.name === name)) return { version: pkg.version, dir };
        } catch {
          /* 读到别的包的 package.json，继续往上 */
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 包没装：状态层会标成 warn */
  }
  return { version: null, dir: null };
}

function clip(text: string | null | undefined, max = 140): string | null {
  const value = String(text ?? "").trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clockTime(ts: number | null): string | null {
  if (!ts) return null;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: env.timezone,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString("zh-CN");
  }
}

/* ------------------------------------------------------------------ */
/* Chromium 探测                                                       */
/* ------------------------------------------------------------------ */

interface ChromiumProbe {
  available: boolean;
  version: string | null;
  path: string | null;
  packageVersion: string | null;
  /** playwright-core/browsers.json 里的 chromium revision */
  revision: string | null;
  running: boolean;
  error: string | null;
}

/**
 * 浏览器版本最可靠的来源是 playwright-core/browsers.json：
 * 它直接写了这次发版对应的 Chromium 版本，跨平台、不用 spawn。
 * Windows 上 `chrome.exe --version` 常只吐 crashpad 日志，只能当最后兜底。
 */
function bundledChromium(): { version: string | null; revision: string | null } {
  try {
    const core = readPackage("playwright-core");
    if (!core.dir) return { version: null, revision: null };
    const raw = JSON.parse(fs.readFileSync(path.join(core.dir, "browsers.json"), "utf8")) as {
      browsers?: Array<{ name?: string; revision?: string; browserVersion?: string }>;
    };
    const entry = raw.browsers?.find((b) => b.name === "chromium");
    return { version: entry?.browserVersion ?? null, revision: entry?.revision ?? null };
  } catch {
    return { version: null, revision: null };
  }
}

let chromeVersionCache: { at: number; value: string | null } | null = null;
const CHROME_VERSION_TTL = 10 * 60 * 1000;

/**
 * chromium --version 的输出在 Windows 上会混进 crashpad 的 ERROR 行，
 * 而且这些行还排在版本号前面。所以这里返回全文，由调用方用正则去捞版本号，
 * 绝不能想当然地取第一行。
 */
function chromeBanner(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, ["--version"], { timeout: 2500, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      const text = `${String(stdout || "")}\n${String(stderr || "")}`.trim();
      if (err && !text) {
        resolve(null);
        return;
      }
      resolve(text || null);
    });
  });
}

async function probeChromium(force: boolean): Promise<ChromiumProbe> {
  const status = browserStatus();
  const pkg = readPackage("playwright");
  let exe: string | null = null;
  let packageVersion = pkg.version;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pw = require("playwright") as { chromium?: { executablePath?: () => string } };
    exe = pw.chromium?.executablePath?.() ?? null;
  } catch {
    /* playwright 没装，下面会给出明确提示 */
  }
  if (!packageVersion) packageVersion = readPackage("playwright-core").version;

  const exists = Boolean(exe && fs.existsSync(exe));
  const bundled = bundledChromium();
  // 运行中的实例报的版本最准；其次用 browsers.json；两者都没有才去 spawn --version
  let version: string | null = status.version || bundled.version || null;
  if (!version && exists && (force || !chromeVersionCache || Date.now() - chromeVersionCache.at > CHROME_VERSION_TTL)) {
    const banner = await chromeBanner(exe!);
    // 从全文里捞 "Chromium 130.0.6723.31"；只有错误日志时宁可显示未知
    version = banner ? /(?:Chromium|Chrome)\s+(\d+\.\d+\.\d+\.\d+)/i.exec(banner)?.[1] ?? null : null;
    chromeVersionCache = { at: Date.now(), value: version };
  } else if (!version && exists) {
    version = chromeVersionCache?.value ?? null;
  }
  if (!version && exists && packageVersion) version = `随 Playwright ${packageVersion}`;

  return {
    available: exists || status.running,
    version,
    path: exe,
    packageVersion,
    revision: bundled.revision,
    running: status.running,
    error: exists
      ? null
      : status.disabled
        ? "上次启动失败，需要检查 Chromium 安装"
        : "未找到 Chromium，网页 / m3u8 的动态解析不可用（可在镜像内安装 Playwright 浏览器）",
  };
}

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */

const FFMPEG_SOURCE: Record<string, string> = {
  settings: "设置里指定",
  env: "环境变量 FFMPEG_PATH",
  bundled: "内置 npm 包",
  path: "系统 PATH",
};
const YTDLP_SOURCE: Record<string, string> = {
  custom: "设置里指定",
  local: "自动更新下载（data/bin）",
  bundled: "镜像内置",
  path: "系统 PATH",
};
const ROUTE_LABEL: Record<string, string> = {
  auto: "直连优先（失败自动走代理）",
  always: "强制代理",
  off: "只直连",
};

function storageReport(settings: ReturnType<typeof getSettings>): OverviewReport["storage"] {
  const dbSize = fileSize(env.dbFile) + fileSize(`${env.dbFile}-wal`) + fileSize(`${env.dbFile}-shm`);
  let dbTables = 0;
  let dbRows = 0;
  try {
    dbTables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
    dbRows = (db.prepare("SELECT count(*) AS n FROM downloads").get() as { n: number }).n;
  } catch {
    /* 老库缺表也要能出报告 */
  }

  const dirs: StorageDirProbe[] = DIR_KEYS.map((key) => {
    const parsed = parseDirSetting(settings[key], env.downloadDir);
    const absolute = parsed.dir
      ? path.join(env.downloadDir, ...parsed.dir.split("/").filter(Boolean))
      : env.downloadDir;
    const exists = fs.existsSync(absolute);
    return {
      id: key,
      label: DIR_LABEL[key],
      rel: parsed.dir || "（下载根）",
      absolute,
      exists,
      writable: parsed.error ? false : writableDir(absolute),
      error: parsed.error,
    };
  });

  let disk: OverviewReport["storage"]["disk"] = null;
  try {
    const st = fs.statfsSync(env.downloadDir);
    const total = Number(st.blocks) * Number(st.bsize);
    // 某些平台（Windows / 网络挂载）bavail 为 0，退回 bfree
    const free = Number(st.bavail || st.bfree) * Number(st.bsize);
    if (total > 0 && free >= 0) {
      const percent = Math.min(100, Math.round(((total - free) / total) * 100));
      disk = { total, free, used: Math.max(0, total - free), percent, status: diskLevel(percent) };
    }
  } catch {
    /* statfs 不可用时就不显示磁盘条 */
  }

  return {
    dataDir: env.dataDir,
    downloadDir: env.downloadDir,
    dbFile: env.dbFile,
    dbSize,
    dbTables,
    dbRows,
    cacheLimitMb: settings.cache_limit_mb,
    writable: { data: isDirWritable(env.dataDir), downloads: isDirWritable(env.downloadDir) },
    disk,
    dirs,
  };
}

async function toolReport(
  force: boolean,
  settings: ReturnType<typeof getSettings>,
  dbTables: number,
): Promise<ToolProbe[]> {
  // 三个慢探测并行；其余都是同步读文件 / 读内存
  if (force) clearYtdlpCache();
  const [ffmpeg, engine, chromium, sharpOk] = await Promise.all([
    ffmpegInfo(force),
    engineState(),
    probeChromium(force),
    loadSharp().then(Boolean).catch(() => false),
  ]);
  const ytdlp = engine.info;
  const update = engine.update;
  const sharpPkg = readPackage("sharp");
  const sqlitePkg = readPackage("better-sqlite3");
  const gramPkg = readPackage("telegram");
  let sqliteVersion: string | null = null;
  try {
    sqliteVersion = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  } catch {
    /* ignore */
  }

  const tools: ToolProbe[] = [
    {
      id: "node",
      label: "Node.js",
      status: "ok",
      version: `v${process.versions.node}`,
      path: process.execPath,
      source: "当前进程",
      note: `${process.platform}/${process.arch} · ${os.cpus().length} 核 · 已运行 ${Math.round(process.uptime() / 60)} 分钟`,
      usedBy: "整个服务 / yt-dlp 解密 YouTube nsig",
    },
    {
      id: "ffmpeg",
      label: "ffmpeg",
      status: toolStatus({ available: ffmpeg.available }),
      version: ffmpeg.version ? `ffmpeg ${ffmpeg.version}` : null,
      path: ffmpeg.ffmpeg,
      source: ffmpeg.source ? FFMPEG_SOURCE[ffmpeg.source] ?? ffmpeg.source : null,
      note: ffmpeg.available ? null : clip(ffmpeg.error) ?? "未找到 ffmpeg",
      usedBy: "m3u8 下载 / 视频截帧 / 封面生成",
    },
    {
      id: "ytdlp",
      label: "yt-dlp",
      status: toolStatus({
        available: ytdlp.available,
        optional: !settings.platform_enabled,
        outdated: update.updateAvailable,
      }),
      version: ytdlp.version,
      path: ytdlp.path,
      source: ytdlp.source ? YTDLP_SOURCE[ytdlp.source] ?? ytdlp.source : null,
      note: !ytdlp.available
        ? clip(ytdlp.error) ?? "未找到 yt-dlp"
        : update.updateAvailable
          ? `有新版本 ${update.latest}，可在设置页点「检查更新」`
          : update.autoUpdate
            ? `自动更新：每 ${update.checkHours} 小时检查`
            : "自动更新已关闭",
      usedBy: "B站 / 小红书 / YouTube 下载",
    },
    {
      id: "chromium",
      label: "Chromium（Playwright）",
      status: toolStatus({ available: chromium.available, optional: true }),
      version: chromium.version,
      path: chromium.path,
      source:
        [chromium.packageVersion ? `playwright ${chromium.packageVersion}` : null, chromium.revision ? `r${chromium.revision}` : null]
          .filter(Boolean)
          .join(" · ") || "npm 依赖",
      note: chromium.running
        ? `浏览器实例运行中，空闲 ${browserStatus().idleCloseMinutes} 分钟自动关闭`
        : chromium.available
          ? "按需启动，空闲后自动释放（约 150MB 内存）"
          : chromium.error,
      usedBy: "网页 / m3u8 动态解析、Cloudflare 人机验证",
    },
    {
      id: "sharp",
      label: "sharp",
      status: toolStatus({ available: sharpOk, optional: true }),
      version: sharpPkg.version,
      path: sharpPkg.dir,
      source: "npm 依赖（可选）",
      note: sharpOk ? null : "未加载；封面缩放 / 裁切会退化为原图处理",
      usedBy: "封面缩放、裁切、模糊填充",
    },
    {
      id: "sqlite",
      label: "SQLite / better-sqlite3",
      status: "ok",
      version: `SQLite ${sqliteVersion ?? "未知"} · 驱动 ${sqlitePkg.version ?? "未知"}`,
      path: env.dbFile,
      source: "数据目录",
      note: `${dbTables} 张表`,
      usedBy: "设置 / 下载记录 / 元数据 / 提交历史",
    },
    {
      id: "gramjs",
      label: "Telegram SDK（GramJS）",
      status: sdkLoaded() ? "ok" : "warn",
      version: gramPkg.version,
      path: gramPkg.dir,
      source: "npm 依赖",
      note: sdkLoaded() ? null : "SDK 尚未加载，Telegram 功能不可用（通常重启可恢复）",
      usedBy: "Telegram 账号连接与机器人",
    },
  ];
  return tools;
}

/**
 * Telegram 登录状态：正常走 getAuthState（自带 8 秒探测缓存），
 * 但网络卡住时不能让整个概览页陪着等 —— 2.5 秒还没回来就退回本地 session 状态。
 * 探测本身在后台继续，下一轮大概率就命中缓存了。
 */
function localAuthState(): AuthState {
  const meta = getSessionMeta();
  return {
    configured: true,
    connected: false,
    authorized: meta.state === "ok",
    me: null,
    pendingCode: false,
    error: meta.state === "dead" ? (meta.error ?? "登录状态已失效，请重新登录") : null,
    sessionSavedAt: meta.savedAt,
    sessionState: meta.state,
    sessionPersisted: meta.state === "ok",
    sessionErrorCode: null,
    sessionRecoverable: false,
    riskSuspect: false,
  };
}

async function safeAuthState(): Promise<AuthState> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      getAuthState(),
      new Promise<AuthState>((resolve) => {
        timer = setTimeout(() => resolve(localAuthState()), 2500);
        timer.unref?.();
      }),
    ]);
  } catch {
    return localAuthState();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function serviceReport(settings: ReturnType<typeof getSettings>): Promise<ServiceProbe[]> {
  const auth = await safeAuthState();
  const bot = getBotState();
  const scheduler = getSchedulerState();
  const queue = downloader.stats();
  const embyKey = getEmbyKeyHint();
  const embyState = getEmbyNotifyState();
  const account = getAccount();
  const proxyRaw = String(settings.proxy_url ?? "").trim();
  const proxy = parseProxy(proxyRaw);
  const proxyUnsupported = telegramProxyUnsupported(proxyRaw);
  const cookies = PLATFORM_IDS.map((id) => getPlatformCookieHint(id));
  const mode = routeMode();
  const embyConfigured = Boolean(settings.emby_notify && settings.emby_url && embyKey.set);

  const services: ServiceProbe[] = [
    {
      id: "telegram",
      label: "Telegram 账号",
      status: auth.authorized ? (auth.connected ? "ok" : "warn") : auth.sessionState === "dead" ? "error" : "warn",
      value: auth.authorized
        ? auth.me?.username
          ? `@${auth.me.username}`
          : auth.me?.firstName || "已登录"
        : auth.sessionState === "dead"
          ? "会话已失效"
          : "未登录",
      note:
        clip(auth.error) ??
        (auth.sessionPersisted ? `session 已加密落盘${auth.sessionSavedAt ? ` · ${clockTime(auth.sessionSavedAt)}` : ""}` : "登录后会自动保存 session，重启免扫码"),
      page: "settings",
    },
    {
      id: "bot",
      label: "Telegram 机器人",
      status: !bot.enabled ? "off" : bot.running ? "ok" : "error",
      value: !bot.enabled ? "未启用" : bot.running ? bot.username ? `@${bot.username}` : "运行中" : "未连接",
      note: clip(bot.error) ?? (bot.enabled ? `白名单 ${bot.allowCount} 人` : "在设置页开启后可用手机遥控下载"),
      page: "settings",
    },
    {
      id: "scan",
      label: "自动扫描",
      status: scheduler.autoScan ? (auth.authorized ? "ok" : "warn") : "off",
      value: scheduler.autoScan ? `每 ${scheduler.intervalMinutes} 分钟` : "已关闭",
      note: scheduler.scanning
        ? "正在扫描频道"
        : scheduler.autoScan && scheduler.nextRunAt
          ? `下次 ${clockTime(scheduler.nextRunAt)}`
          : auth.authorized
            ? null
            : "登录 Telegram 后才会开始扫描",
      page: "channels",
    },
    {
      id: "queue",
      label: "下载队列",
      status: queue.waiting > 0 && queue.active === 0 ? "warn" : "ok",
      value: `${queue.active} 进行中 / ${queue.waiting} 等待`,
      note: queue.waiting > 0 && queue.active === 0 ? `有排队任务未开始（并发上限 ${settings.concurrency}）` : `并发上限 ${settings.concurrency}`,
      page: "downloads",
    },
    {
      id: "emby",
      label: "Emby 入库",
      status: !settings.emby_notify ? "off" : embyConfigured ? "ok" : "warn",
      value: !settings.emby_notify ? "未启用" : embyConfigured ? "已配置" : "配置不完整",
      note: !settings.emby_notify
        ? "开启后下载完成会通知 Emby 刷新媒体库"
        : !embyKey.set
          ? "缺 API Key"
          : !settings.emby_url
            ? "缺服务地址"
            : embyState.lastNotifiedAt
              ? `最近通知 ${clockTime(embyState.lastNotifiedAt)}`
              : "尚未推送过通知",
      // Emby 的配置项 1.3.5 起统一在设置页，点卡片去那里改
      page: "settings",
    },
    {
      id: "proxy",
      label: "网络代理",
      status: !proxyRaw ? "ok" : proxy ? (proxyUnsupported ? "warn" : "ok") : "error",
      value: !proxyRaw ? "直连" : proxy ? `${proxy.scheme}://${proxy.host}:${proxy.port}` : "格式错误",
      note: !proxyRaw
        ? "未配置代理，Telegram 走直连"
        : !proxy
          ? clip(explainProxyProblem(proxyRaw)) ?? "代理地址解析失败"
          : proxyUnsupported
            ? "HTTP 代理不能用于 Telegram 的 MTProto，请改用 SOCKS5"
            : proxy.username
              ? "带账号密码"
              : null,
      page: "settings",
    },
    {
      id: "route",
      label: "网页下载线路",
      status: "ok",
      value: ROUTE_LABEL[mode] ?? mode,
      note: settings.m3u8_proxy ? `代理 ${clip(settings.m3u8_proxy, 60)}` : "代理取环境变量，未设置时不走代理",
      page: "settings",
    },
    {
      id: "login",
      label: "管理界面登录",
      status: env.authDisabled ? "warn" : account ? "ok" : "warn",
      value: env.authDisabled ? "已临时关闭" : account ? "已启用" : "未初始化",
      note: env.authDisabled
        ? "任何人都能访问界面与接口，改完密码请立刻去掉该环境变量"
        : account
          ? `账号 ${account.username} · 当前 ${activeSessionCount()} 个会话`
          : "首次访问会要求设置账号密码",
      page: "settings",
    },
    {
      id: "platform",
      label: "第三方平台",
      status: !settings.platform_enabled
        ? "off"
        : cookies.some((c) => c.missing)
          ? "warn"
          : "ok",
      value: !settings.platform_enabled ? "未启用" : `${cookies.filter((c) => c.set).length}/3 已配 Cookie`,
      note: !settings.platform_enabled
        ? "在设置页开启后可下载 B站 / 小红书 / YouTube"
        : `画质 ${settings.platform_quality}${cookies.some((c) => c.missing) ? " · 有平台缺 Cookie，部分视频会受限" : ""}`,
      page: "manual",
    },
  ];
  return services;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

let cached: { at: number; report: OverviewReport } | null = null;
let inflight: Promise<OverviewReport> | null = null;

async function collect(force: boolean): Promise<OverviewReport> {
  const started = Date.now();
  const settings = getSettings();
  const storage = storageReport(settings);
  const [tools, services] = await Promise.all([
    toolReport(force, settings, storage.dbTables),
    serviceReport(settings),
  ]);
  const mem = process.memoryUsage();
  const uptime = Math.round(process.uptime());

  const report: OverviewReport = {
    at: Date.now(),
    elapsedMs: Date.now() - started,
    cached: false,
    runtime: {
      version: APP_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      os: `${os.type()} ${os.release()}`,
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      workDir: process.cwd(),
      pid: process.pid,
      uptime,
      startedAt: Date.now() - uptime * 1000,
      timezone: env.timezone,
      resolvedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      inContainer: fs.existsSync("/.dockerenv") || (() => {
        try {
          return /docker|containerd|kubepods/.test(fs.readFileSync("/proc/1/cgroup", "utf8"));
        } catch {
          return false;
        }
      })(),
    },
    storage,
    tools,
    services,
    summary: summarizeProbes([tools, services]),
  };
  return report;
}

/**
 * 取概览报告。默认 30 秒内复用；refresh=1 时强制重新探测所有工具。
 * 并发请求复用同一个 inflight，避免多个标签页同时 spawn 一堆 --version。
 */
export async function getOverview(refresh = false): Promise<OverviewReport> {
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.report, cached: true };
  }
  if (inflight) return inflight;
  inflight = collect(refresh)
    .then((report) => {
      cached = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
