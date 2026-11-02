import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getSetting, getSettings, setSetting } from "../db";
import { logger } from "../logger";
import { downloadFile, httpRequest, parseProxy } from "../lib/netprobe";
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

/** 上次检查结果存这里，进程重启后界面上还能看到时间与版本 */
const K_CHECK_AT = "ytdlp_check_at";
const K_LATEST = "ytdlp_latest";
const K_UPDATED_AT = "ytdlp_updated_at";
const K_ERROR = "ytdlp_check_error";
/** 上次失败后的重试时间：失败不该把整个检查周期等满 24 小时 */
const K_RETRY_AT = "ytdlp_retry_at";

const RETRY_DELAY_MS = 30 * 60_000;

export interface EngineUpdateState {
  /** 当前生效的版本 */
  current: string | null;
  /** 远端最新版本 */
  latest: string | null;
  updateAvailable: boolean;
  /** 上次成功检查的时间 */
  checkedAt: number | null;
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
    const before = await ytdlpInfo(true);
    const from = before.version;
    try {
      const latest = await fetchLatest();
      setSetting(K_CHECK_AT, String(Date.now()));
      setSetting(K_LATEST, latest);
      setSetting(K_ERROR, "");
      setSetting(K_RETRY_AT, "");

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
      const message = (err as Error).message || String(err);
      // 两类常见失败：连不上 GitHub（没配代理），和 data/bin 不可写（属主不对）
      let hint = message;
      if (/EACCES|EPERM|permission denied/i.test(message)) {
        hint = `${message}（data/bin 不可写：容器内运行用户的 uid 需与 data 目录属主一致，见 README 的 PUID/PGID）`;
      } else if (/连接|超时|解析|TLS|拒绝|不可达|ETIMEDOUT|ENOTFOUND/i.test(message)) {
        hint = `${message}（检查更新需要访问 GitHub，可在「第三方平台代理」里填代理后重试）`;
      }
      setSetting(K_ERROR, hint);
      setSetting(K_RETRY_AT, String(Date.now() + RETRY_DELAY_MS));
      logger.warn({ err: message }, "yt-dlp 检查更新失败");
      return { ok: false, updated: false, from, to: null, error: hint };
    } finally {
      busy = false;
      progress = -1;
      running = null;
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
  return {
    info,
    update: {
      current: info.version,
      latest,
      updateAvailable: Boolean(latestRank && currentRank && latestRank > currentRank),
      checkedAt: readNumber(K_CHECK_AT),
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

const TICK_MS = 60 * 60 * 1000; // 每小时醒一次，实际间隔看设置

function dueForCheck(): boolean {
  const settings = getSettings();
  if (!settings.ytdlp_auto_update) return false;
  // 上次失败了：等重试时间到了就再试，不用把整个周期等满
  const retryAt = readNumber(K_RETRY_AT);
  if (retryAt && Date.now() < retryAt) return false;
  const at = readNumber(K_CHECK_AT);
  if (!at) return true;
  if (retryAt) return true;
  const hours = Math.max(1, settings.ytdlp_check_hours || 24);
  return Date.now() - at >= hours * 3600_000;
}

/**
 * 启动定时检查。返回停止函数。
 *
 * 首检延迟 90 秒：刚启动时下载队列和 Telegram 都在重连，
 * 别在这时候去抢网络和 CPU。
 */
export function startYtdlpAutoUpdate(): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!dueForCheck()) return;
    try {
      await updateYtdlp();
    } catch (err) {
      logger.debug({ err: (err as Error).message }, "自动检查 yt-dlp 更新失败");
    }
  };
  const first = setTimeout(() => void tick(), 90_000);
  first.unref();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
