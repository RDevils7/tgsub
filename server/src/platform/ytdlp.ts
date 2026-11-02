import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSettings } from "../db";
import { PlatformId } from "../types";
import { ffmpegInfo } from "../tg/ffmpeg";

/**
 * yt-dlp 封装：B站 / 抖音 / 小红书都交给它。
 *
 * 为什么用 yt-dlp 而不是自己写接口：
 * 这三个平台的播放地址都要签名（B站 w_rid、抖音 a_bogus、小红书 x-s），
 * 签名算法是逆向出来的，平台一改就失效。yt-dlp 有社区持续跟，
 * 我们只负责把 Cookie 喂给它、把进度读出来。
 *
 * 二进制来源优先级：设置里手填的路径 → 镜像内置 /usr/local/bin/yt-dlp → PATH。
 * Windows 本地开发一般没装，界面会显示「未安装」，不影响 Telegram 下载。
 */

export interface YtdlpInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  /** 从哪里找到的，界面上给用户看 */
  source: "custom" | "bundled" | "path" | null;
  error: string | null;
}

const BUNDLED = "/usr/local/bin/yt-dlp";

function candidates(custom: string): Array<{ file: string; source: YtdlpInfo["source"] }> {
  const list: Array<{ file: string; source: YtdlpInfo["source"] }> = [];
  const trimmed = custom.trim();
  if (trimmed) list.push({ file: trimmed, source: "custom" });
  if (process.platform !== "win32") list.push({ file: BUNDLED, source: "bundled" });
  // PATH 里的名字：Windows 带 .exe，其余不带
  list.push({ file: process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp", source: "path" });
  return list;
}

function runOnce(file: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("执行超时"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

let cache: { at: number; info: YtdlpInfo } | null = null;
const CACHE_MS = 30_000;

/** 探测可用性与版本；30 秒内复用结果，避免设置页每次刷新都 spawn 一次 */
export async function ytdlpInfo(force = false): Promise<YtdlpInfo> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.info;

  let custom = "";
  try {
    custom = getSettings().ytdlp_path;
  } catch {
    custom = "";
  }

  let lastError = "未找到 yt-dlp 可执行文件";
  for (const item of candidates(custom)) {
    try {
      const res = await runOnce(item.file, ["--version"], 15_000);
      if (res.code === 0) {
        const info: YtdlpInfo = {
          available: true,
          path: item.file,
          version: res.out.trim().split("\n")[0] || null,
          source: item.source,
          error: null,
        };
        cache = { at: Date.now(), info };
        return info;
      }
      lastError = (res.err || res.out).trim().slice(0, 300) || `退出码 ${res.code}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const info: YtdlpInfo = { available: false, path: null, version: null, source: null, error: lastError };
  cache = { at: Date.now(), info };
  return info;
}

export function clearYtdlpCache(): void {
  cache = null;
}

/* ------------------------------------------------------------------ */
/* Cookie                                                              */
/* ------------------------------------------------------------------ */

const COOKIE_DOMAIN: Record<PlatformId, string> = {
  bilibili: ".bilibili.com",
  douyin: ".douyin.com",
  xiaohongshu: ".xiaohongshu.com",
};

/**
 * 把「k=v; k2=v2」转成 yt-dlp 要的 Netscape cookies.txt。
 *
 * yt-dlp 的很多 extractor 会检查 `self._get_cookies()`，只塞
 * `--add-header "Cookie: ..."` 不生效，必须喂文件。
 */
export function cookieToNetscape(cookie: string, platform: PlatformId): string {
  const domain = COOKIE_DOMAIN[platform];
  const lines = ["# Netscape HTTP Cookie File", "# 由 tgsub 自动生成，请勿手动编辑", ""];
  for (const raw of cookie.split(";")) {
    const item = raw.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!name) continue;
    // domain / includeSubdomains / path / secure / expiry(0=会话) / name / value
    lines.push([domain, "TRUE", "/", "TRUE", "0", name, value].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

async function withCookieFile<T>(
  cookie: string,
  platform: PlatformId,
  run: (file: string) => Promise<T>,
): Promise<T> {
  const dir = path.join(os.tmpdir(), "tgsub-cookies");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${platform}-${crypto.randomUUID()}.txt`);
  await fs.promises.writeFile(file, cookieToNetscape(cookie, platform), { encoding: "utf8", mode: 0o600 });
  try {
    return await run(file);
  } finally {
    await fs.promises.unlink(file).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* 清晰度                                                              */
/* ------------------------------------------------------------------ */

/**
 * 画质 → yt-dlp 的 -f 参数。
 *
 * 用 `bv*+ba/b`（视频+音频分开再合并）而不是 `b`，否则 B站会给一个
 * 已经混流的低码率版本，1080P 也糊。
 */
export function formatSelector(quality: string): string {
  const raw = (quality || "").trim().toLowerCase();
  if (!raw || raw === "best" || raw === "max") return "bv*+ba/b";
  const height = Number(raw.replace(/p$/, ""));
  if (!Number.isFinite(height) || height <= 0) return "bv*+ba/b";
  return `bv*[height<=${height}]+ba/b[height<=${height}]/b`;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

export interface PlatformProbe {
  platform: PlatformId;
  id: string;
  title: string;
  uploader: string;
  duration: number | null;
  thumbnail: string | null;
  description: string;
  /** yt-dlp 给的是 YYYYMMDD，这里统一成毫秒时间戳 */
  uploadedAt: number | null;
  webpageUrl: string;
  /** 预估大小，界面显示用 */
  filesize: number | null;
}

interface YtdlpJson {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  description?: string;
  upload_date?: string;
  webpage_url?: string;
  filesize?: number;
  filesize_approx?: number;
  _type?: string;
  entries?: YtdlpJson[];
}

function uploadDateToTs(raw: string | undefined): number | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const ts = new Date(year, month - 1, day, 12, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function toProbe(platform: PlatformId, json: YtdlpJson, fallbackUrl: string): PlatformProbe {
  return {
    platform,
    id: String(json.id ?? ""),
    title: (json.title ?? "").trim() || "未命名视频",
    uploader: (json.uploader ?? json.channel ?? "").trim(),
    duration: typeof json.duration === "number" && json.duration > 0 ? Math.round(json.duration) : null,
    thumbnail: json.thumbnail ?? null,
    description: (json.description ?? "").trim(),
    uploadedAt: uploadDateToTs(json.upload_date),
    webpageUrl: json.webpage_url ?? fallbackUrl,
    filesize: json.filesize ?? json.filesize_approx ?? null,
  };
}

/** 解析一条链接，只取信息不下载 */
export async function probePlatform(
  url: string,
  platform: PlatformId,
  cookie: string,
): Promise<PlatformProbe> {
  const info = await ytdlpInfo();
  if (!info.available || !info.path) {
    throw new Error("yt-dlp 不可用：请确认镜像是 1.0.5 以上，或在设置里填写 yt-dlp 路径");
  }

  const args = [
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "20",
    url,
  ];

  const exec = async (cookieFile?: string): Promise<{ code: number; out: string; err: string }> => {
    const full = cookieFile ? [...args.slice(0, -1), "--cookies", cookieFile, url] : args;
    return runOnce(info.path as string, full, 90_000);
  };

  const res = cookie.trim() ? await withCookieFile(cookie, platform, (file) => exec(file)) : await exec();
  if (res.code !== 0) {
    throw new Error(explainYtdlpError(res.err || res.out, platform));
  }

  let json: YtdlpJson;
  try {
    json = JSON.parse(res.out) as YtdlpJson;
  } catch {
    throw new Error("yt-dlp 返回的内容不是有效 JSON，链接可能已失效");
  }
  // 万一是合集，取第一条，避免把整个播放列表拉下来
  if (json._type === "playlist" && Array.isArray(json.entries) && json.entries.length > 0) {
    json = json.entries[0];
  }
  return toProbe(platform, json, url);
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

export interface PlatformDownloadOptions {
  platform: PlatformId;
  cookie: string;
  dir: string;
  quality: string;
  /** 收到进度：已下载字节 / 总字节（可能为 0）/ 速度 */
  onProgress?: (downloaded: number, total: number, speed: number) => void;
  /** 中断：暂停 / 停止都走它 */
  signal?: AbortSignal;
}

export interface PlatformDownloadResult {
  file: string;
  size: number;
}

const PROGRESS_TAG = "@@TGSUB";

/**
 * 下载一条链接到 dir，返回最终文件绝对路径。
 *
 * 进度靠 `--progress-template`：yt-dlp 默认那套进度条格式随版本变，
 * 自定义模板才能稳定解析。
 */
export async function downloadPlatform(
  url: string,
  opts: PlatformDownloadOptions,
): Promise<PlatformDownloadResult> {
  const info = await ytdlpInfo();
  if (!info.available || !info.path) {
    throw new Error("yt-dlp 不可用：请确认镜像是 1.0.5 以上，或在设置里填写 yt-dlp 路径");
  }

  const ffmpeg = await ffmpegInfo().catch(() => null);
  await fs.promises.mkdir(opts.dir, { recursive: true });

  const marker = path.join(os.tmpdir(), `tgsub-filepath-${crypto.randomUUID()}.txt`);
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--no-mtime",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--socket-timeout",
    "20",
    "-f",
    formatSelector(opts.quality),
    "--merge-output-format",
    "mp4",
    "-P",
    opts.dir,
    // 标题里可能有 / 和表情：只截断长度，交给 yt-dlp 自己清理非法字符
    "-o",
    "%(title).80s [%(id)s].%(ext)s",
    "--progress-template",
    `download:${PROGRESS_TAG} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s`,
    "--print-to-file",
    "after_move:filepath",
    marker,
  ];
  if (ffmpeg?.available && ffmpeg.ffmpeg) args.push("--ffmpeg-location", ffmpeg.ffmpeg);
  if (opts.cookie.trim()) args.push("--cookies");
  args.push(url);

  const run = async (cookieFile?: string): Promise<void> => {
    const finalArgs = [...args];
    if (cookieFile) finalArgs.splice(finalArgs.length - 1, 0, cookieFile);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(info.path as string, finalArgs, { windowsHide: true });
      let stderr = "";
      const tail: string[] = [];

      const onAbort = (): void => {
        child.kill("SIGTERM");
        // 有些平台的分片下载不响应 SIGTERM，2 秒后强杀
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith(PROGRESS_TAG)) continue;
          const [, downloaded, total, estimate, speed] = line.split(/\s+/);
          opts.onProgress?.(
            Number(downloaded) || 0,
            Number(total) || Number(estimate) || 0,
            Number(speed) || 0,
          );
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        tail.push(String(chunk));
        if (tail.length > 40) tail.shift();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) {
          reject(new Error("已中断"));
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(explainYtdlpError(tail.join("") || stderr, opts.platform)));
      });
    });
  };

  try {
    if (opts.cookie.trim()) {
      await withCookieFile(opts.cookie, opts.platform, (file) => run(file));
    } else {
      await run();
    }

    let file = "";
    try {
      file = (await fs.promises.readFile(marker, "utf8")).trim().split("\n").filter(Boolean).pop() ?? "";
    } catch {
      file = "";
    }
    if (!file || !fs.existsSync(file)) {
      // 兜底：目录里找最新写入的视频文件（--print-to-file 偶发不落盘）
      file = newestVideo(opts.dir) ?? "";
    }
    if (!file) throw new Error("下载结束但没找到输出文件");
    const stat = await fs.promises.stat(file);
    if (stat.size === 0) throw new Error("下载完成但文件为空（0 字节）");
    return { file, size: stat.size };
  } finally {
    await fs.promises.unlink(marker).catch(() => undefined);
  }
}

function newestVideo(dir: string): string | null {
  let best: { file: string; at: number } | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mp4|mkv|webm|mov|flv)$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      const at = fs.statSync(full).mtimeMs;
      if (!best || at > best.at) best = { file: full, at };
    } catch {
      /* ignore */
    }
  }
  return best?.file ?? null;
}

/**
 * 把 yt-dlp 的英文报错翻成能照做的中文。
 *
 * 这三个平台最常见的失败只有两类：Cookie 没了、平台改版了。
 */
export function explainYtdlpError(raw: string, platform: PlatformId): string {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  const label = platform === "bilibili" ? "B站" : platform === "douyin" ? "抖音" : "小红书";
  if (/Fresh cookies|login required|Sign in|需要登录|cookies are needed|account/i.test(text)) {
    return `${label}要求登录：请在设置 → 第三方平台里填入新鲜 Cookie（浏览器登录后复制整串）`;
  }
  if (/HTTP Error 412|Precondition Failed|风控|risk/i.test(text)) {
    return `${label}风控拦截（412）：Cookie 可能过期，或短时间请求过多，稍后再试`;
  }
  if (/Unsupported URL|No suitable|not a valid URL/i.test(text)) {
    return `yt-dlp 认不出这个链接，可能不支持该页面类型（试试视频详情页链接，而不是主页）`;
  }
  if (/format is not available|Requested format/i.test(text)) {
    return `该链接没有所选清晰度，把画质改成「最高」再试`;
  }
  if (/Unable to download|urlopen error|timed out|Connection/i.test(text)) {
    return `网络连接失败：确认容器能直连 ${label}（大陆网络不需要代理）`;
  }
  const firstError = text.split("ERROR:").pop()?.trim() || text;
  return firstLine(firstError) || `${label}解析失败`;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

/** 日志里给用户看的平台名 */
export function platformName(platform: PlatformId): string {
  return platform === "bilibili" ? "B站" : platform === "douyin" ? "抖音" : "小红书";
}
