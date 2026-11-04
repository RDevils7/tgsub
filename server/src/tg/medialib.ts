import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getSettings } from "../db";
import { env } from "../env";
import { captureStill, probeVideo, type VideoProbe } from "./ffmpeg";
import { DEFAULT_SOURCE_DIRS, DIR_KEYS, DIR_LABEL, parseDirSetting, type DirKey } from "./mediadir";
import { isVideoFile } from "./mediapath";
import {
  collectSeriesDirs,
  deriveEpisodeInfo,
  findDownloadByPath,
  isAllowedPath,
  listSources,
  scanVideoFiles,
} from "./mediatree";
import { fieldsFromNfo, parseNfo, readText } from "./nfo";

/**
 * 本地媒体库。
 *
 * 和「元数据」页的区别：那边是管理（改名、删、隐藏），这边只负责「看和播」——
 * 把下载目录（或用户选的任意已登记目录）当成一个媒体库，
 * 目录里的每个剧集文件夹是一部剧，点进去看分集，点某一集直接播。
 *
 * 数据全部来自磁盘：NFO 提供标题 / 简介 / 年份，封面用 Emby 认的固定槽位名，
 * 没有封面就退回第一集的缩略图。不依赖 Emby，Emby 没配也照样能用。
 */

/* ------------------------------------------------------------------ */
/* 封面                                                                */
/* ------------------------------------------------------------------ */

/** Emby / Kodi 认的剧集级海报槽位，按优先级排 */
const POSTER_SLOTS = ["poster", "folder", "cover", "show"];
/** 横向图（详情页顶部背景）槽位 */
const LANDSCAPE_SLOTS = ["landscape", "fanart", "backdrop", "banner", "thumb"];
const ART_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function firstExisting(dir: string, slots: readonly string[]): string | null {
  for (const slot of slots) {
    for (const ext of ART_EXTS) {
      for (const name of [slot + ext, slot + ext.toUpperCase()]) {
        const full = path.join(dir, name);
        if (isFile(full)) return full;
      }
    }
  }
  return null;
}

/**
 * 找一部剧的封面。
 *
 * 1. 目录里的固定槽位（poster / folder / cover …）
 * 2. 第一集的单集缩略图 `<base>-thumb.jpg` 或 `<base>.jpg`
 *    —— 下载时生成的就是这个，所以没有海报的剧也有图可看
 */
export function findSeriesArt(dir: string, firstVideo?: string | null): { poster: string | null; landscape: string | null } {
  let poster = firstExisting(dir, POSTER_SLOTS);
  const landscape = firstExisting(dir, LANDSCAPE_SLOTS);
  if (!poster && firstVideo) {
    const base = path.join(path.dirname(firstVideo), path.basename(firstVideo, path.extname(firstVideo)));
    const candidates = [`${base}-thumb.jpg`, `${base}-thumb.jpeg`, `${base}-thumb.png`, `${base}.jpg`, `${base}.png`];
    poster = candidates.find(isFile) ?? null;
  }
  if (!poster && landscape) poster = landscape;
  return { poster, landscape };
}

/* ------------------------------------------------------------------ */
/* 播放方式                                                            */
/* ------------------------------------------------------------------ */

/** 浏览器能直接当 <video src> 播的容器 */
const DIRECT_EXT = new Set([".mp4", ".m4v", ".webm", ".ogv"]);
/** 浏览器能解的编码（容器对了还要编码对） */
const DIRECT_CODEC = new Set(["h264", "vp8", "vp9", "av1", "theora"]);
/** 包一层 fMP4 就能播的编码（mkv / ts 里装 h264 很常见） */
const REMUX_CODEC = new Set(["h264", "vp9", "av1", "mpeg4"]);

export type PlayMode = "direct" | "remux" | "unsupported";

/**
 * 浏览器**普遍**不认、但个别环境真能解的编码。
 *
 * HEVC / H.265 就是这样：Safari、装了 HEVC 扩展的 Edge、带硬解的系统都能播，
 * Chrome 在多数 Windows 上不行。所以默认拦下来（标灰 + 提示），
 * 用户在媒体库里打开「强制尝试」后才放行 —— 能不能放由他那台浏览器说了算。
 */
const TRIAL_CODEC = new Set(["hevc", "h265"]);

/** 这个编码是不是「默认拦、可强制尝试」的那一类 */
export function isTrialCodec(codec: string | null | undefined): boolean {
  return TRIAL_CODEC.has((codec ?? "").toLowerCase());
}

export interface PlayOptions {
  /** 用户在自己浏览器里打开了「强制尝试 HEVC」，不再把它判成 unsupported */
  allowHevc?: boolean;
}

/**
 * 判断一个文件怎么播。
 *
 * - `direct`：mp4/webm + 浏览器能解的编码，走 Range 直出，能拖进度条
 * - `remux`：容器不对但编码能解（mkv/ts/avi 里的 h264），ffmpeg 换封装成 fMP4 再吐给浏览器
 * - `unsupported`：HEVC / H.265 这类浏览器普遍不支持的编码，如实告诉用户，别假装能播。
 *   开了 `allowHevc` 之后 HEVC 也按容器走 direct / remux —— 播不播得出来交给浏览器判，
 *   前端会兜住 `<video>` 的解码错误。
 */
export function playModeOf(file: string, probe: VideoProbe | null, opts: PlayOptions = {}): PlayMode {
  const ext = path.extname(file).toLowerCase();
  const codec = (probe?.videoCodec ?? "").toLowerCase();
  if (codec && !DIRECT_CODEC.has(codec) && !REMUX_CODEC.has(codec)) {
    if (!(opts.allowHevc && TRIAL_CODEC.has(codec))) return "unsupported";
    // 强制尝试：容器对就直出，mkv/ts 这类还得先换封装（换封装只换壳，不改编码）
    return DIRECT_EXT.has(ext) ? "direct" : "remux";
  }
  // 探测不到编码时按容器赌一把：mp4/webm 多半没问题
  if (DIRECT_EXT.has(ext)) return "direct";
  return "remux";
}

/* ------------------------------------------------------------------ */
/* 探测缓存                                                            */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  size: number;
  mtimeMs: number;
  probe: VideoProbe | null;
}

const PROBE_CACHE = new Map<string, CacheEntry>();
const PROBE_CACHE_MAX = 800;
/** 一次探测几十毫秒，但一季几十集并发会拖爆机器，限个道 */
const PROBE_CONCURRENCY = 4;
let probeRunning = 0;
const probeQueue: Array<() => void> = [];

async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (probeRunning >= PROBE_CONCURRENCY) await new Promise<void>((resolve) => probeQueue.push(resolve));
  probeRunning += 1;
  try {
    return await fn();
  } finally {
    probeRunning -= 1;
    probeQueue.shift()?.();
  }
}

/** 按 路径 + 大小 + mtime 缓存探测结果：文件没变就不用再探一次 */
export async function probeFile(file: string): Promise<VideoProbe | null> {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st) return null;
  const hit = PROBE_CACHE.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.probe;
  const probe = await withProbeSlot(() => probeVideo(file)).catch(() => null);
  if (!hit && PROBE_CACHE.size >= PROBE_CACHE_MAX) {
    const oldest = PROBE_CACHE.keys().next().value;
    if (oldest) PROBE_CACHE.delete(oldest);
  }
  PROBE_CACHE.set(file, { size: st.size, mtimeMs: st.mtimeMs, probe });
  return probe;
}

/* ------------------------------------------------------------------ */
/* 媒体库目录                                                          */
/* ------------------------------------------------------------------ */

export interface LibraryRoot {
  path: string;
  label: string;
  /** 相对下载根的路径，空串代表下载根自己 */
  rel: string;
  kind: "root" | "platform" | "source";
}

/**
 * 可以切换的库位置。
 *
 * 第一项永远是下载根；接着是设置里那 5 个来源目录（存在才算）；
 * 最后是手动登记过的外部来源目录 —— 用户想把别的盘也当媒体库看，走这条。
 */
export function libraryRoots(): LibraryRoot[] {
  const root = path.resolve(env.downloadDir);
  const settings = getSettings();
  const out: LibraryRoot[] = [{ path: root, label: "下载目录", rel: "", kind: "root" }];
  const seen = new Set<string>([root]);

  for (const key of DIR_KEYS) {
    const parsed = parseDirSetting(settings[key as DirKey], root);
    if (parsed.error || !parsed.dir) continue;
    const abs = path.resolve(root, parsed.dir);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    out.push({ path: abs, label: DIR_LABEL[key], rel: parsed.dir, kind: "platform" });
  }

  for (const source of listSources()) {
    if (source.kind !== "dir") continue;
    const abs = path.resolve(source.path);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    const rel = path.relative(root, abs);
    out.push({
      path: abs,
      label: source.title || path.basename(abs) || abs,
      rel: rel.startsWith("..") || path.isAbsolute(rel) ? "" : rel,
      kind: "source",
    });
  }
  return out;
}

/** 目录里的路径转成界面用的展示名 */
function displayName(dir: string, title: string): string {
  const t = title.trim();
  return t || path.basename(dir) || dir;
}

export interface LibrarySeries {
  /** 目录绝对路径，前端当 key 用 */
  dir: string;
  /** 目录名 */
  name: string;
  /** 展示标题（NFO title / showtitle，回退目录名） */
  title: string;
  year: number | null;
  overview: string;
  genres: string[];
  rating: number | null;
  episodeCount: number;
  totalSize: number;
  /** 最近更新时间（毫秒） */
  updatedAt: number;
  /** 有无 tvshow.nfo */
  hasNfo: boolean;
  /** 归档来源（telegram / B站 / …），没查到就是 other */
  origin: string;
  /** 第一集（用来找缩略图当封面；前端用不到但带上无妨） */
  firstVideo: string | null;
}

export interface LibraryEpisode {
  /** 文件绝对路径 */
  path: string;
  name: string;
  title: string;
  /** 本集简介（单集 NFO 的 plot；没有就空串） */
  plot: string;
  season: number | null;
  episode: number | null;
  size: number;
  updatedAt: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** 编码名（h264 / hevc …），界面用来解释「为什么播不了」 */
  videoCodec: string | null;
  playMode: PlayMode;
}

/** 剧集目录的 NFO 信息（标题 / 简介 / 年份 …） */
async function readShowFields(dir: string) {
  const raw = await readText(path.join(dir, "tvshow.nfo"));
  const fields = raw ? fieldsFromNfo(parseNfo(raw)) : null;
  return { hasNfo: Boolean(raw), fields };
}

/** 单集 NFO 里的标题和简介（标题用于「第1集 · 自定义标题」里的自定义部分） */
async function readEpisodeMeta(file: string): Promise<{ title: string; plot: string }> {
  const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
  const raw = await readText(`${base}.nfo`);
  if (!raw) return { title: "", plot: "" };
  const fields = fieldsFromNfo(parseNfo(raw));
  return {
    title: (fields.title || "").trim(),
    plot: (fields.plot || fields.outline || "").trim(),
  };
}

function statOf(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function originOfDir(dir: string): string {
  // 用第一集反查下载记录，能拿到是哪个平台来的；查不到就归到「外部」
  const first = scanVideoFiles(dir)[0];
  if (!first) return "other";
  const row = findDownloadByPath(first);
  return row?.source ?? "manual";
}

/** 目录是不是一个剧集（自己直接装了视频，而不是只有子目录） */
function hasDirectVideos(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && !e.name.startsWith(".") && isVideoFile(e.name));
}

async function buildSeries(dir: string): Promise<LibrarySeries> {
  const files = scanVideoFiles(dir);
  const { hasNfo, fields } = await readShowFields(dir);
  let totalSize = 0;
  let updatedAt = Math.round(statOf(dir)?.mtimeMs ?? 0);
  let first = files[0] ?? null;
  for (const file of files) {
    const st = statOf(file);
    totalSize += st?.size ?? 0;
    if (st && st.mtimeMs > updatedAt) updatedAt = st.mtimeMs;
    if (first === null) first = file;
  }
  const title = displayName(dir, fields?.title || fields?.showtitle || "");
  const year = Number((fields?.year || fields?.premiered || "").slice(0, 4)) || null;
  const rating = Number(fields?.rating) || null;
  return {
    dir,
    name: path.basename(dir) || dir,
    title,
    year: Number.isFinite(year) ? year : null,
    overview: (fields?.plot || fields?.outline || "").trim(),
    genres: fields?.genres ?? [],
    rating: Number.isFinite(rating) ? rating : null,
    episodeCount: files.length,
    totalSize,
    updatedAt,
    hasNfo,
    origin: originOfDir(dir),
    firstVideo: first,
  };
}

/** 分集按 季 → 集 → 自然序 排，认不出集号的（花絮、预告）垫底 */
function compareEpisodes(a: LibraryEpisode, b: LibraryEpisode): number {
  const sa = a.season ?? 1;
  const sb = b.season ?? 1;
  if (sa !== sb) return sa - sb;
  const ea = a.episode;
  const eb = b.episode;
  if (ea !== null && eb === null) return -1;
  if (ea === null && eb !== null) return 1;
  if (ea !== null && eb !== null && ea !== eb) return ea - eb;
  return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
}

export interface LibraryListing {
  dir: string;
  parent: string | null;
  roots: LibraryRoot[];
  /** 这个目录自己就是一部剧（用户点了某部剧进来） */
  isSeries: boolean;
  /** 目录直接放的视频（没归进任何剧集文件夹） */
  loose: LibraryEpisode[];
  series: LibrarySeries[];
  /** 本目录或上级是否已经越过允许范围（面包屑判断用） */
  home: string;
}

/** 列一个目录里的剧集 */
export async function listLibrary(dir: string, opts: PlayOptions = {}): Promise<LibraryListing> {
  const abs = path.resolve(dir);
  const roots = libraryRoots();
  const entries = collectSeriesDirs(abs);
  const selfFiles = entries.filter((item) => path.resolve(item.dir) === abs);

  const series: LibrarySeries[] = [];
  for (const item of entries) {
    if (path.resolve(item.dir) === abs) continue;
    series.push(await buildSeries(item.dir));
  }

  /**
   * 目录自己算不算「一部剧」。
   *
   * 光看「有没有视频」不够：下载根里常有人直接扔一两个视频，
   * 这时候整个下载根会被当成一部剧，海报墙就打不开了。
   * 所以只有「自己没有子剧集」时才算剧集，否则一律当列表，
   * 里面直接放的视频作为「散装视频」卡片展示。
   */
  const isSeries = selfFiles.length > 0 && series.length === 0;

  // 剧集模式下分集由 /media/series 提供，这里不用再算一遍（免得同一个目录扫两次）
  const loose: LibraryEpisode[] = [];
  if (!isSeries && selfFiles.length > 0) {
    for (const file of selfFiles[0].files) loose.push(await buildEpisode(file, opts));
    loose.sort(compareEpisodes);
  }

  series.sort((a, b) => a.title.localeCompare(b.title, "zh-CN", { numeric: true }));
  // 上级目录：只要还在可操作范围内就给，方便「上一层」；到顶了就不给
  const parent = path.dirname(abs);
  return {
    dir: abs,
    parent: parent === abs || !isAllowedPath(parent) ? null : parent,
    roots,
    isSeries,
    loose,
    series,
    home: path.resolve(env.downloadDir),
  };
}

async function buildEpisode(file: string, opts: PlayOptions = {}): Promise<LibraryEpisode> {
  const dir = path.dirname(file);
  const info = deriveEpisodeInfo(path.basename(file), path.basename(dir));
  const st = statOf(file);
  const probe = await probeFile(file).catch(() => null);
  const meta = await readEpisodeMeta(file);
  const ep = info.episode;
  const fallback = ep !== null ? `第 ${ep} 集` : path.basename(file, path.extname(file));
  return {
    path: file,
    name: path.basename(file),
    title: meta.title || fallback,
    plot: meta.plot,
    season: info.season,
    episode: ep,
    size: st?.size ?? 0,
    updatedAt: Math.round(st?.mtimeMs ?? 0),
    durationSec: probe?.duration ?? null,
    width: probe?.width ?? null,
    height: probe?.height ?? null,
    videoCodec: probe?.videoCodec ?? null,
    playMode: playModeOf(file, probe, opts),
  };
}

export interface SeriesDetail {
  series: LibrarySeries;
  episodes: LibraryEpisode[];
}

/** 一部剧的详情 + 全部分集 */
export async function seriesDetail(dir: string, opts: PlayOptions = {}): Promise<SeriesDetail> {
  const abs = path.resolve(dir);
  const files = scanVideoFiles(abs);
  const episodes: LibraryEpisode[] = [];
  for (const file of files) episodes.push(await buildEpisode(file, opts));
  episodes.sort(compareEpisodes);
  return { series: await buildSeries(abs), episodes };
}

/* ------------------------------------------------------------------ */
/* 图片 / 播放地址                                                     */
/* ------------------------------------------------------------------ */

/** 封面地址：带上 mtime 当版本号，换海报后浏览器不用手动清缓存 */
export function artUrl(dir: string, kind: "poster" | "landscape", firstVideo?: string | null): string | null {
  const first = firstVideo ?? scanVideoFiles(dir)[0] ?? null;
  const art = findSeriesArt(dir, first);
  const file = kind === "poster" ? art.poster : art.landscape;
  if (!file) return null;
  const version = Math.round(statOf(file)?.mtimeMs ?? 0);
  return `/api/media/art?dir=${encodeURIComponent(dir)}&kind=${kind}&v=${version}`;
}

/** 找封面文件本身（art 路由用，避免前端传任意文件路径） */
export function resolveArtFile(dir: string, kind: "poster" | "landscape"): string | null {
  const first = scanVideoFiles(dir)[0] ?? null;
  const art = findSeriesArt(dir, first);
  return kind === "poster" ? art.poster : art.landscape;
}

/** 播放地址：direct 走 Range 直出，remux 走 ffmpeg 换封装 */
export function streamUrl(file: string, mode: PlayMode): string {
  const query = mode === "remux" ? "&mode=remux" : "";
  return `/api/media/stream?path=${encodeURIComponent(file)}${query}`;
}

/* ------------------------------------------------------------------ */
/* 单集缩略图                                                          */
/* ------------------------------------------------------------------ */

/**
 * 单集缩略图。
 *
 * 三个来源，按成本从低到高：
 *   1. 下载时已经生成好的 `<base>-thumb.jpg` —— 封面就是它，最省事
 *   2. 之前抽过帧的缓存（data/cache/episode-thumbs）—— 同一文件不会重复抽
 *   3. 现场用 ffmpeg 抽一帧（跳过片头），抽完落缓存
 *
 * 缓存 key 里带 size + mtime：文件被改名/替换后自动失效，不会串图。
 */

/** 下载时生成好的单集图片，有就直接用 */
export function existingEpisodeThumb(file: string): string | null {
  const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
  const candidates = [
    `${base}-thumb.jpg`,
    `${base}-thumb.jpeg`,
    `${base}-thumb.png`,
    `${base}-thumb.webp`,
    `${base}.jpg`,
    `${base}.jpeg`,
    `${base}.png`,
    `${base}.webp`,
  ];
  return candidates.find(isFile) ?? null;
}

/** 抽帧位置：跳过片头，取 12% 处；太短的视频退回第 0 秒 */
export function thumbTimeFor(durationSec: number | null | undefined): number {
  const duration = Number(durationSec) || 0;
  if (duration <= 0) return 6;
  if (duration < 5) return 0;
  // 大片片头通常在前面几十秒，12% 基本落在正片里；同时限制不超过「结尾前 1 秒」
  return Math.min(Math.max(duration * 0.12, 3), Math.max(duration - 1, 0));
}

/** 抽帧缓存文件路径（按 路径+大小+mtime 派生，天然带失效） */
export function thumbCachePath(file: string, stat: { size: number; mtimeMs: number }): string {
  const key = crypto
    .createHash("sha1")
    .update(`${file}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(env.dataDir, "cache", "episode-thumbs", `${key}.jpg`);
}

/** 抽一帧当缩略图；首选时间点取不到画面时退回第一帧 */
export async function generateEpisodeThumb(
  file: string,
  out: string,
  durationSec: number | null | undefined,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const at = thumbTimeFor(durationSec);
  try {
    await captureStill(file, at, out, 480);
  } catch (err) {
    if (at === 0) throw err;
    await captureStill(file, 0, out, 480);
  }
}

/** 缩略图地址：version 用视频 mtime，抽帧缓存命中和换文件都能正确刷新 */
export function thumbUrl(file: string, version?: number): string {
  const v = version ? `&v=${Math.round(version)}` : "";
  return `/api/media/thumb?path=${encodeURIComponent(file)}${v}`;
}
