import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSettings } from "../db";
import { env } from "../env";
import { PlatformId, PLATFORM_LABEL } from "../types";
import { ffmpegInfo } from "../tg/ffmpeg";
import { normalizeProxyUrl, parseProxy } from "../lib/netprobe";

/**
 * yt-dlp 封装：B站 / 抖音 / 小红书 / YouTube 都交给它。
 *
 * 为什么用 yt-dlp 而不是自己写接口：
 * 这些平台的播放地址都要签名（B站 w_rid、抖音 a_bogus、小红书 x-s、
 * YouTube nsig），签名算法是逆向出来的，平台一改就失效。yt-dlp 有社区持续跟，
 * 我们只负责把 Cookie 喂给它、把进度读出来。
 *
 * 二进制来源优先级：设置里手填 → data/bin（自动更新下来的）→ 镜像内置
 * /usr/local/bin/yt-dlp → PATH。Windows 本地开发一般没装，界面会显示
 * 「不可用」，不影响 Telegram 下载（可在设置页点「检查更新」自动下载）。
 */

export interface YtdlpInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  /** 从哪里找到的，界面上给用户看 */
  source: "custom" | "local" | "bundled" | "path" | null;
  error: string | null;
}

const BUNDLED = "/usr/local/bin/yt-dlp";

/** 自动更新下载到这里：data 目录是挂载卷，容器重建后不会丢 */
export function localBinaryPath(): string {
  return path.join(env.dataDir, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

function candidates(custom: string): Array<{ file: string; source: YtdlpInfo["source"] }> {
  const list: Array<{ file: string; source: YtdlpInfo["source"] }> = [];
  const trimmed = custom.trim();
  if (trimmed) list.push({ file: trimmed, source: "custom" });
  // 自动更新下来的版本要盖过镜像内置的那个
  const local = localBinaryPath();
  if (fs.existsSync(local)) list.push({ file: local, source: "local" });
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

/* ------------------------------------------------------------------ */
/* 代理与 YouTube 的 JS 运行时                                          */
/* ------------------------------------------------------------------ */

/**
 * yt-dlp 专用代理参数。
 *
 * 和 Telegram 的 `proxy_url` 分开：B站 / 抖音 / 小红书 在墙内直连最快，
 * 混用一个代理反而绕远路；只有 YouTube 必须挂代理。
 * 地址解析复用 netprobe 的 parseProxy，免得两套规则。
 */
export function platformProxyArg(raw = getSettings().platform_proxy): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  if (!parseProxy(text)) return [];
  return ["--proxy", normalizeProxyUrl(text)];
}

/** yt-dlp 从 2025.10.22 起才有 --js-runtimes；老版本传了会直接报未知参数 */
const JS_RUNTIME_SINCE = 20251022;

export function versionRank(version: string | null): number {
  const m = /(\d{4})\.(\d{2})\.(\d{2})/.exec(version ?? "");
  if (!m) return 0;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/**
 * YouTube 现在要靠 JS 运行时解密 nsig，否则拿不到高清格式。
 * 镜像里自带 node，版本够就显式告诉 yt-dlp 用哪个。
 */
export function supportsJsRuntime(version: string | null): boolean {
  return versionRank(version) >= JS_RUNTIME_SINCE;
}

/** 平台相关的通用参数 */
function platformArgs(platform: PlatformId, version: string | null): string[] {
  const args = platformProxyArg();
  if (platform === "youtube" && supportsJsRuntime(version)) args.push("--js-runtimes", "node");
  return args;
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
  youtube: ".youtube.com",
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

/** 合集里的一条（flat 模式只有这些字段，够入队和命名用了） */
export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  uploader: string;
  duration: number | null;
  thumbnail: string | null;
}

export interface PlatformPlaylist {
  /** 探测到的条目数（可能被 PLAYLIST_LIMIT 截断，见 capped） */
  count: number;
  /** 超过上限、只拿到了前 N 条 */
  capped: boolean;
  entries: PlaylistEntry[];
}

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
  /** 播放量 / 点赞；Emby 没有对应字段，写进简介尾部 */
  viewCount: number | null;
  likeCount: number | null;
  /** 分区 / 分类，写进 Emby 的 genre */
  categories: string[];
  /** 合集 / 多P 才有；单条视频为 null */
  playlist: PlatformPlaylist | null;
}

interface YtdlpJson {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string; preference?: number }>;
  description?: string;
  upload_date?: string;
  webpage_url?: string;
  url?: string;
  filesize?: number;
  filesize_approx?: number;
  view_count?: number;
  like_count?: number;
  categories?: string[];
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

/** 有的站点只给 thumbnails 数组，取最后一张（yt-dlp 按从大到小排） */
function pickThumbnail(json: YtdlpJson): string | null {
  if (json.thumbnail) return json.thumbnail;
  const list = (json.thumbnails ?? []).filter((item) => typeof item?.url === "string");
  const last = list[list.length - 1]?.url;
  return last ?? null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toProbe(platform: PlatformId, json: YtdlpJson, fallbackUrl: string): PlatformProbe {
  return {
    platform,
    id: String(json.id ?? ""),
    title: (json.title ?? "").trim() || "未命名视频",
    uploader: (json.uploader ?? json.channel ?? "").trim(),
    duration: typeof json.duration === "number" && json.duration > 0 ? Math.round(json.duration) : null,
    thumbnail: pickThumbnail(json),
    description: (json.description ?? "").trim(),
    uploadedAt: uploadDateToTs(json.upload_date),
    webpageUrl: json.webpage_url ?? fallbackUrl,
    filesize: json.filesize ?? json.filesize_approx ?? null,
    viewCount: num(json.view_count),
    likeCount: num(json.like_count),
    categories: Array.isArray(json.categories) ? json.categories.filter((c): c is string => Boolean(c)) : [],
    playlist: null,
  };
}

/** flat 条目 → 入队用的最小信息；拿不到可下载链接就丢掉（宁可少下也别下错） */
function toEntry(json: YtdlpJson): PlaylistEntry | null {
  const url = [json.webpage_url, json.url].find(
    (value): value is string => typeof value === "string" && /^https?:\/\//i.test(value),
  );
  if (!url) return null;
  return {
    id: String(json.id ?? ""),
    title: (json.title ?? "").trim() || "未命名视频",
    url,
    uploader: (json.uploader ?? json.channel ?? "").trim(),
    duration: typeof json.duration === "number" && json.duration > 0 ? Math.round(json.duration) : null,
    thumbnail: pickThumbnail(json),
  };
}

/** 合集条目列表（导出是为了自检能覆盖，不依赖 yt-dlp 二进制） */
export function playlistEntries(raw: unknown[]): PlaylistEntry[] {
  const out: PlaylistEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = toEntry(item as YtdlpJson);
    if (entry) out.push(entry);
  }
  return out;
}

/** 一次最多展开多少条：既防止 5000 个视频的播放列表把队列撑爆，也不至于卡住解析 */
const PLAYLIST_LIMIT = 200;

/**
 * 从 `--flat-playlist` 的 JSON 判断这是不是合集。
 *
 * yt-dlp 对多P / 播放列表有时报 `playlist`，有时报 `multi_video`，两种都算；
 * 单条视频即使带了 `entries` 也不该被当成合集，所以必须先看 `_type`。
 */
export function readPlaylist(json: { _type?: string; entries?: unknown[] }): PlatformPlaylist | null {
  if (json._type !== "playlist" && json._type !== "multi_video") return null;
  if (!Array.isArray(json.entries)) return null;
  const entries = playlistEntries(json.entries);
  if (!entries.length) return null;
  return { count: entries.length, capped: entries.length >= PLAYLIST_LIMIT, entries };
}

const PROBE_CACHE_MS = 60_000;
const probeCache = new Map<string, { at: number; probe: PlatformProbe }>();

export function clearProbeCache(): void {
  probeCache.clear();
}

/** 跑一次 --dump-single-json；extra 决定是「整条视频」还是「合集目录」 */
async function dumpJson(
  binary: { path: string | null; version: string | null },
  platform: PlatformId,
  cookie: string,
  extra: string[],
  url: string,
): Promise<YtdlpJson> {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    ...platformArgs(platform, binary.version),
    "--socket-timeout",
    "20",
    ...extra,
    url,
  ];

  const exec = async (cookieFile?: string): Promise<{ code: number; out: string; err: string }> => {
    const full = cookieFile ? [...args.slice(0, -1), "--cookies", cookieFile, url] : args;
    // 合集链接要展开条目，比单条慢，超时给宽一点
    return runOnce(binary.path as string, full, 120_000);
  };

  const res = cookie.trim() ? await withCookieFile(cookie, platform, (file) => exec(file)) : await exec();
  if (res.code !== 0) throw new Error(explainYtdlpError(res.err || res.out, platform));
  try {
    return JSON.parse(res.out) as YtdlpJson;
  } catch {
    throw new Error("yt-dlp 返回的内容不是有效 JSON，链接可能已失效");
  }
}

/**
 * 解析一条链接，只取信息不下载。
 *
 * 先按「合集」问一次（`--flat-playlist`）：单条视频时它不影响结果，
 * 只有多P / 播放列表才会返回 `_type: playlist`。这样一次请求就能判断
 * 「要不要让用户选只下第一个还是全下」，不必先下再发现。
 */
export async function probePlatform(
  url: string,
  platform: PlatformId,
  cookie: string,
  opts: { fresh?: boolean } = {},
): Promise<PlatformProbe> {
  const key = `${platform}|${url}`;
  if (!opts.fresh) {
    const hit = probeCache.get(key);
    // 界面点「开始下载」时通常会先 probe 一次再 task 一次，缓存省掉一次解析
    if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.probe;
  }

  const info = await ytdlpInfo();
  if (!info.available || !info.path) {
    throw new Error("yt-dlp 不可用：请确认镜像是 1.1.0 以上，或在设置里填写 yt-dlp 路径");
  }

  const first = await dumpJson(info, platform, cookie, ["--flat-playlist", "--playlist-end", String(PLAYLIST_LIMIT)], url);

  let json = first;
  let target = url;

  const playlist = readPlaylist(first);
  if (playlist) {
    // flat 条目没有简介和精确封面，第一条再单独问一次完整信息
    target = playlist.entries[0].url;
    json = await dumpJson(info, platform, cookie, ["--no-playlist"], target);
    // 有的站点即使带了 --no-playlist 还是回整个播放列表，这里再兜一次
    if (Array.isArray(json.entries) && json.entries.length > 0) {
      if (json._type === "playlist" || json._type === "multi_video") json = json.entries[0];
    }
  }

  const probe: PlatformProbe = { ...toProbe(platform, json, target), playlist };
  probeCache.set(key, { at: Date.now(), probe });
  if (probeCache.size > 100) {
    const oldest = probeCache.keys().next().value;
    if (oldest) probeCache.delete(oldest);
  }
  return probe;
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
    throw new Error("yt-dlp 不可用：请确认镜像是 1.1.0 以上，或在设置里填写 yt-dlp 路径");
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
    ...platformArgs(opts.platform, info.version),
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
  const label = PLATFORM_LABEL[platform] ?? platform;
  const youtube = platform === "youtube";
  if (/Sign in to confirm|not a bot|confirm your age|age-restricted/i.test(text)) {
    return youtube
      ? "YouTube 判定为机器人/需要年龄验证：请填入已登录的 Cookie，并确认代理 IP 不是被标记的机房 IP"
      : `${label}要求登录：请在设置 → 第三方平台里填入新鲜 Cookie（浏览器登录后复制整串）`;
  }
  if (
    /not available in your country|not made this video available|blocked it in your country|geo.?restrict/i.test(
      text,
    )
  ) {
    return "该视频在当前地区不可用：把「第三方平台代理」换到其他地区节点再试";
  }
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
  if (/Unable to download|urlopen error|timed out|Connection|Tunnel connection failed/i.test(text)) {
    return youtube
      ? "连不上 YouTube：请在「第三方平台代理」里填一个可用代理（大陆网络必须走代理）"
      : `网络连接失败：确认容器能直连 ${label}（大陆网络不需要代理）`;
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
  return PLATFORM_LABEL[platform] ?? platform;
}
