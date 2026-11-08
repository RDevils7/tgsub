import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getSetting, getSettings, setSetting } from "../db";
import { logger } from "../logger";
import { downloadFile, httpRequest, parseProxy } from "../lib/netprobe";
import { nextCheckAt as planNextCheckAt, nextCheckDelayMs } from "./updateplan";
import { clearYtdlpCache, localBinaryPath, versionRank, ytdlpInfo } from "./ytdlp";

/**
 * yt-dlp 自更新。
 *
 * 为什么需要：三个国内平台 + YouTube 的解析规则几乎每月都在变，
 * 镜像内置的二进制会随着时间慢慢失效。这里定时去 GitHub 看最新版，
 * 有就下到 data/bin（挂载卷，容器重建不丢），下次调用自动优先用它。
 *
 * 检查与下载都走「第三方平台代理」：GitHub 在大陆直连不通，
 * 而这台机器上唯一确定可用的代理就是用户为 YouTube 配的那个。
 */

const RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const RELEASE_DL = "https://github.com/yt-dlp/yt-dlp/releases/download";

/** 上次检查时间（无论成败）——界面显示，也是本轮排期的起点 */
const K_CHECK_AT = "ytdlp_check_at";
/** 排好的「下次自动检查」绝对时间戳：定时器直接睡到这一刻 */
const K_NEXT_AT = "ytdlp_next_at";
const K_LATEST = "ytdlp_latest";
const K_UPDATED_AT = "ytdlp_updated_at";
const K_ERROR = "ytdlp_check_error";
/** 旧版遗留的「失败重试时间」：只用于兼容存量数据，新排期一律写 K_NEXT_AT */
const K_RETRY_AT = "ytdlp_retry_at";
/** 连续失败次数：用来做指数退避，避免被 GitHub 限流时每小时刷一次日志 */
const K_FAIL_COUNT = "ytdlp_fail_count";

export interface EngineUpdateState {
  /** 当前生效的版本 */
  current: string | null;
  /** 远端最新版本 */
  latest: string | null;
  updateAvailable: boolean;
  /** 上次检查的时间（成功或失败都记） */
  checkedAt: number | null;
  /** 下次自动检查的时间；关掉自动更新时为 null */
  nextCheckAt: number | null;
  /** 上次成功更新的时间 */
  updatedAt: number | null;
  lastError: string | null;
  /** 正在检查或下载 */
  busy: boolean;
  /** 下载进度 0–1；-1 表示正在检查 */
  progress: number;
  autoUpdate: boolean;
  checkHours: number;
}

let busy = false;
let progress = -1;
let running: Promise<UpdateOutcome> | null = null;
/** 由启动器注入：检查结束 / 设置变更后立刻按新周期重排定时器 */
let rearm: (() => void) | null = null;

function readNumber(key: string): number | null {
  const raw = Number(getSetting(key) ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** 按当前平台挑官方发布的文件名 */
export function assetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (arch === "arm64") return "yt-dlp_linux_aarch64";
  if (arch === "arm") return "yt-dlp_linux_armv7l";
  return "yt-dlp";
}

/** GitHub 的 tag 是 `2025.11.12`，偶尔带 v 前缀 */
export function normalizeTag(tag: string): string {
  return String(tag ?? "").trim().replace(/^v/i, "");
}

export interface UpdateOutcome {
  ok: boolean;
  /** 是否真的换了新版本 */
  updated: boolean;
  from: string | null;
  to: string | null;
  error: string | null;
}

async function fetchLatest(): Promise<string> {
  const settings = getSettings();
  const proxy = parseProxy(settings.platform_proxy);
  const res = await httpRequest(RELEASE_API, {
    proxy,
    method: "GET",
    timeoutMs: 20_000,
    verifyTls: true,
    maxBody: 256 * 1024,
  });
  if (res.status === 403) {
    throw new Error("GitHub API 达到匿名请求频率上限，过一小时再试");
  }
  if (res.status !== 200) {
    throw new Error(`GitHub 返回 HTTP ${res.status || "无响应"}`);
  }
  let tag = "";
  try {
    const json = JSON.parse(res.body) as { tag_name?: string };
    tag = json.tag_name ?? "";
  } catch {
    // 被中间设备插了广告页之类的：退化成正则，仍可能捞到
    tag = /"tag_name"\s*:\s*"([^"]+)"/.exec(res.body)?.[1] ?? "";
  }
  const version = normalizeTag(tag);
  if (!version || !versionRank(version)) {
    throw new Error("GitHub 返回的版本号无法识别");
  }
  return version;
}

function probeVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(file, ["--version"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim().split("\n")[0] || null : null));
    setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
  });
}

async function replaceBinary(tmp: string, target: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const backup = `${target}.bak`;
  const hadOld = fs.existsSync(target);
  if (hadOld) await fs.promises.rm(backup, { force: true });
  try {
    if (hadOld) await fs.promises.rename(target, backup);
    await fs.promises.rename(tmp, target);
    await fs.promises.chmod(target, 0o755).catch(() => undefined);
    if (hadOld) await fs.promises.rm(backup, { force: true });
  } catch (err) {
    // 换失败了就把旧版本放回去，别把能用的引擎搞没
    if (fs.existsSync(backup) && !fs.existsSync(target)) {
      await fs.promises.rename(backup, target).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * 检查并下载最新版。同一时间只跑一个（定时任务与手动点击撞上时共用同一次结果）。
 *
 * 只要远端不比本地新就不下载 —— 用户点「检查更新」的预期是「看看有没有新版」，
 * 而不是重新拉一遍 20MB。本地版本探测失败（current 为 null）时会照常下载。
 */
export async function updateYtdlp(): Promise<UpdateOutcome> {
  if (running) return running;
  running = (async (): Promise<UpdateOutcome> => {
    busy = true;
    progress = -1;
    // 检查一开始就记时间：失败也算「查过一次」，下一轮周期从这次算起。
    // 以前只有 fetchLatest() 成功才写，失败时 checkAt 停在很久以前，
    // 重试点一过就同时满足「周期已到」，于是永远回不到用户设的 15 天。
    let failed = false;
    let failReason = "";
    const before = await ytdlpInfo(true);
    const from = before.version;
    try {
      setSetting(K_CHECK_AT, String(Date.now()));
      const latest = await fetchLatest();
      setSetting(K_LATEST, latest);
      setSetting(K_ERROR, "");
      setSetting(K_RETRY_AT, "");
      setSetting(K_FAIL_COUNT, "0");

      const currentRank = versionRank(from);
      const latestRank = versionRank(latest);
      if (currentRank && latestRank <= currentRank) {
        return { ok: true, updated: false, from, to: latest, error: null };
      }

      const target = localBinaryPath();
      const tmp = `${target}.download`;
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      // 上次被强杀留下的半截文件：先删掉，免得占着空间还让人误会
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      progress = 0;
      const url = `${RELEASE_DL}/${latest}/${assetName()}`;
      logger.info({ from, to: latest, url }, "开始下载新版 yt-dlp");
      await downloadFile(url, tmp, {
        proxy: parseProxy(getSettings().platform_proxy),
        timeoutMs: 45_000,
        maxBytes: 128 * 1024 * 1024,
        verifyTls: true,
        onProgress: (got, total) => {
          progress = total > 0 ? Math.min(1, got / total) : 0;
        },
      });

      const verified = await probeVersion(tmp);
      if (!verified) {
        await fs.promises.rm(tmp, { force: true });
        throw new Error("下载的文件无法执行，已保留原版本");
      }
      await replaceBinary(tmp, target);
      await fs.promises.chmod(target, 0o755).catch(() => undefined);
      clearYtdlpCache();
      const after = await ytdlpInfo(true);
      setSetting(K_UPDATED_AT, String(Date.now()));
      setSetting(K_LATEST, verified);
      logger.info({ from, to: after.version ?? verified }, "yt-dlp 已更新");
      return { ok: true, updated: true, from, to: after.version ?? verified, error: null };
    } catch (err) {
      failed = true;
      const message = (err as Error).message || String(err);
      failReason = message;
      // 两类常见失败：连不上 GitHub（没配代理），和 data/bin 不可写（属主不对）
      let hint = message;
      if (/EACCES|EPERM|permission denied/i.test(message)) {
        hint = `${message} · data/bin 不可写，容器运行用户的 uid 需与 data 目录属主一致`;
      } else if (/代理/.test(message)) {
        // 代理层已经说清是谁不通了，这里只补一句「为什么需要它」
        hint = `${message} · 检查更新要访问 GitHub，请换一个可用代理`;
      } else if (/连接|超时|解析|TLS|拒绝|不可达|ETIMEDOUT|ENOTFOUND/i.test(message)) {
        hint = `${message} · 检查更新要访问 GitHub，可在「第三方平台代理」里填代理后重试`;
      }
      setSetting(K_ERROR, hint);
      // 连续失败只用来决定「还插不插队短重试」。GitHub 匿名配额是每小时 60 次，
      // 403 之后再撞一次只会撞在限流窗口里，所以限流直接等满整个周期。
      const fails = (readNumber(K_FAIL_COUNT) || 0) + 1;
      setSetting(K_FAIL_COUNT, String(fails));
      logger.warn({ err: message, fails }, "yt-dlp 检查更新失败");
      return { ok: false, updated: false, from, to: null, error: hint };
    } finally {
      // 不管成功失败都把「下次自动检查」算成绝对时间落库。
      // 这是唯一的排期来源：定时器睡到它，界面也直接显示它。
      const settings = getSettings();
      const delay = nextCheckDelayMs({
        ok: !failed,
        failCount: failed ? readNumber(K_FAIL_COUNT) || 1 : 0,
        checkHours: settings.ytdlp_check_hours,
        rateLimited: /403|频率上限|rate.?limit|quota|限流/i.test(failReason),
      });
      setSetting(K_NEXT_AT, String(Date.now() + delay));
      // 旧字段会让排期绕过 checkHours，新逻辑不再写它，存量值也一并作废
      setSetting(K_RETRY_AT, "");
      logger.debug({ nextInHours: Math.round(delay / 3600_000) }, "yt-dlp 下次自动检查已排期");
      busy = false;
      progress = -1;
      running = null;
      rearm?.();
    }
  })();
  return running;
}

/** 给设置页的状态快照 */
export async function engineState(): Promise<{ info: Awaited<ReturnType<typeof ytdlpInfo>>; update: EngineUpdateState }> {
  const settings = getSettings();
  const info = await ytdlpInfo();
  const latest = getSetting(K_LATEST) || null;
  const currentRank = versionRank(info.version);
  const latestRank = versionRank(latest);
  const scheduled = planNextCheckAt({
    autoUpdate: settings.ytdlp_auto_update,
    checkHours: settings.ytdlp_check_hours,
    checkAt: readNumber(K_CHECK_AT),
    nextAt: readNumber(K_NEXT_AT),
    now: Date.now(),
  });
  return {
    info,
    update: {
      current: info.version,
      latest,
      updateAvailable: Boolean(latestRank && currentRank && latestRank > currentRank),
      checkedAt: readNumber(K_CHECK_AT),
      nextCheckAt: scheduled,
      updatedAt: readNumber(K_UPDATED_AT),
      lastError: getSetting(K_ERROR) || null,
      busy,
      progress,
      autoUpdate: settings.ytdlp_auto_update,
      checkHours: settings.ytdlp_check_hours,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 定时检查                                                            */
/* ------------------------------------------------------------------ */

/** Node 的 setTimeout 上限略小于 2^31 ms；设成 30 天时要分段睡 */
const MAX_TIMER_MS = 2_147_000_000;
/** 进程刚起来时下载队列和 Telegram 都在重连，别在那一刻去抢网络和 CPU */
const STARTUP_GRACE_MS = 90_000;

function scheduledCheckAt(): number | null {
  const settings = getSettings();
  return planNextCheckAt({
    autoUpdate: settings.ytdlp_auto_update,
    checkHours: settings.ytdlp_check_hours,
    checkAt: readNumber(K_CHECK_AT),
    nextAt: readNumber(K_NEXT_AT),
    now: Date.now(),
  });
}

function dueForCheck(): boolean {
  const at = scheduledCheckAt();
  return at !== null && at <= Date.now();
}

/** 设置页改了开关 / 周期，或手动点过「检查更新」后，立刻按新时间重排 */
export function rescheduleYtdlpAutoUpdate(opts: { fromSettingsChange?: boolean } = {}): void {
  if (opts.fromSettingsChange) {
    // 忽略旧排期，按新周期从「上次检查」重算一次，避免改大周期后仍按旧的短周期跑
    const settings = getSettings();
    const at = planNextCheckAt({
      autoUpdate: settings.ytdlp_auto_update,
      checkHours: settings.ytdlp_check_hours,
      checkAt: readNumber(K_CHECK_AT),
      now: Date.now(),
    });
    setSetting(K_NEXT_AT, at === null ? "" : String(at));
    setSetting(K_RETRY_AT, "");
  }
  rearm?.();
}

/**
 * 启动定时检查。返回停止函数。
 *
 * 以前是 `setInterval(1 小时)` + `dueForCheck()` 轮询：即使设了 15 天，
 * 进程每小时也会醒一次，失败过之后更是整个周期都被 retryAt 顶掉。
 * 现在直接算出「下次检查」的绝对时间，setTimeout 睡到那一刻；
 * 检查完 / 设置变更后重新算一次。中间 15 天里一次定时器唤醒、一次网络请求都没有。
 */
export function startYtdlpAutoUpdate(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let first = true;

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const at = scheduledCheckAt();
    if (at === null) return; // 自动更新关了：不排任何定时器
    const minDelay = first ? STARTUP_GRACE_MS : 1_000;
    first = false;
    const delay = Math.max(minDelay, Math.min(at - Date.now(), MAX_TIMER_MS));
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // 时钟被回拨 / 外部改了库：没到点就重新睡，绝不提前联网
    if (!dueForCheck()) {
      schedule();
      return;
    }
    try {
      await updateYtdlp();
    } catch (err) {
      logger.debug({ err: (err as Error).message }, "自动检查 yt-dlp 更新失败");
    }
    schedule();
  };

  rearm = schedule;
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (rearm === schedule) rearm = null;
  };
}
