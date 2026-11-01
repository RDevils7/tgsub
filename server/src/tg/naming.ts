import crypto from "node:crypto";
import path from "node:path";
import { sanitizeSegment } from "../utils";
import { guessExtension, type MediaInfo } from "./media";

/**
 * 剧集命名。
 *
 * 频道里的短剧通常把剧名和集数写在正文（caption）里，例如：
 *   《美人局》第4集 连载中 全系列完整版 简介：……
 *   《欲女梦工厂》第1-7集 连载中 ……
 * 下载后的文件按正文命名：
 *   美人局/美人局S01E04.mp4
 *   欲女梦工厂/欲女梦工厂S01E01.mp4 ~ 欲女梦工厂S01E07.mp4
 * 同一剧名始终落在同一个文件夹，后续更新会自动续进去。
 */

export interface SeriesInfo {
  /** 规范化后的剧名，直接用作文件夹名 */
  series: string;
  season: number;
  /** 正文里声明的集数（升序去重）；识别不到时为空数组 */
  episodes: number[];
}

const SERIES_RES = [/《([^》\n]{1,60})》/, /[「【]([^」】\n]{1,60})[」】]/];
const SEASON_RE = /第\s*([0-9]{1,3}|[零一二两三四五六七八九十]{1,3})\s*季/;
const RANGE_RE = /第\s*([0-9]{1,4})\s*[-~—–－至到]\s*([0-9]{1,4})\s*[集话話期]/;
const LIST_RE = /第\s*([0-9]{1,4}(?:\s*[,，、和及/]\s*[0-9]{1,4})*)\s*[集话話期]/;
const SEASON_EPISODE_RE = /\bS(\d{1,2})\s*[._-]?\s*E(?:P)?\s*(\d{1,4})\b/i;
const EPISODE_RE = /\b(?:EP|E)\s*(\d{1,4})\b/i;
/** 正文里的“简介：”之后是剧情描述，可能混进别的“第X集”，截断掉再解析 */
const PLOT_SPLIT_RE = /(?:简介|剧情|内容简介|文案)\s*[:：]/;
/** 兜底文件夹名的长度上限：太长在文件管理器里看不全 */
const LOOSE_NAME_MAX = 50;

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 阿拉伯数字或中文数字（一 ~ 九十九）转 number */
function toEpisodeNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  const chars = [...text];
  if (chars.length === 1) return CN_DIGITS[chars[0]] ?? null;
  const tenIndex = chars.indexOf("十");
  if (tenIndex === -1) return null;
  const tens = tenIndex === 0 ? 1 : (CN_DIGITS[chars[0]] ?? 0);
  const rest = chars.slice(tenIndex + 1);
  const ones = rest.length ? (CN_DIGITS[rest[0]] ?? 0) : 0;
  return tens * 10 + ones;
}

/**
 * 剧名清洗：去掉包裹符号、空白与路径非法字符，限制长度。
 * 结尾的「第X季」不参与文件夹名——《芙蓉 第一季》与后续的《芙蓉》应落进同一个目录，
 * 季数已经体现在文件名的 Sxx 里。
 */
function normalizeSeriesName(raw: string): string {
  const base = raw
    .replace(/[《》「」【】]/g, "")
    .replace(/\s*第\s*[0-9一二三四五六七八九十]{1,3}\s*季\s*$/, "")
    .trim();
  const cleaned = sanitizeSegment(base || raw.trim(), 40);
  return cleaned === "untitled" ? "" : cleaned;
}

/**
 * 从消息正文解析剧集信息。识别不到《剧名》时返回 null，
 * 此时保持原有的文件名（文档、音乐、普通图片等不应被改名）。
 */
export function parseSeriesCaption(raw: string): SeriesInfo | null {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, " ").trim();

  let match: RegExpMatchArray | null = null;
  for (const re of SERIES_RES) {
    match = text.match(re);
    if (match) break;
  }
  if (!match) return null;
  const series = normalizeSeriesName(match[1]);
  if (!series) return null;

  // 只看“简介：”之前的部分，避免剧情里出现的“第X集”干扰
  const head = text.split(PLOT_SPLIT_RE)[0] ?? text;

  let season = toEpisodeNumber(SEASON_RE.exec(head)?.[1] ?? "") ?? 1;
  if (!Number.isFinite(season) || season < 1) season = 1;

  let episodes: number[] = [];

  const se = SEASON_EPISODE_RE.exec(head);
  if (se) {
    season = Number(se[1]) || season;
    const ep = Number(se[2]);
    if (Number.isFinite(ep) && ep > 0) episodes = [ep];
  }

  if (!episodes.length) {
    const range = RANGE_RE.exec(head);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= 500) {
        episodes = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      }
    }
  }

  if (!episodes.length) {
    const list = LIST_RE.exec(head);
    if (list) {
      episodes = list[1]
        .split(/[,，、和及/]+/)
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  }

  if (!episodes.length) {
    const ep = EPISODE_RE.exec(head);
    if (ep) {
      const n = Number(ep[1]);
      if (Number.isFinite(n) && n > 0) episodes = [n];
    }
  }

  episodes = [...new Set(episodes)].sort((a, b) => a - b);
  return { series, season, episodes };
}

export interface NamedFile {
  /** 相对下载根目录的文件夹；null 表示沿用 file_template */
  dir: string | null;
  /** 最终文件名（含扩展名）；null 表示沿用原始文件名 */
  name: string | null;
  /** true = 这条消息里用不到的图片（只留 3 张做封面），不下载 */
  skip?: boolean;
  /** 本条文件是剧本集数中的第几集（视频专用） */
  episode?: number | null;
  season?: number;
  isVideo?: boolean;
  /** true = 正文里没解析出剧名，这个文件夹是按「一链接一文件夹」兜底起的名 */
  loose?: boolean;
}

export interface MediaLike {
  kind: MediaInfo["kind"];
  fileName: string;
  mimeType: string | null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function extensionOf(media: MediaLike): string {
  const ext = path.extname(media.fileName);
  if (ext && ext.length <= 8) return ext.toLowerCase();
  return guessExtension(media.mimeType, media.kind);
}

/** 第 order 个视频对应第几集：集数列表与视频数对得上就一一对应，否则从首集顺延 */
function episodeAt(info: SeriesInfo, order: number, videoCount: number): number | null {
  if (!info.episodes.length) return null;
  if (info.episodes.length === videoCount) return info.episodes[order];
  return info.episodes[0] + order;
}

function episodeTag(info: SeriesInfo, episode: number | null): string {
  if (episode === null) return "";
  return `S${pad2(info.season)}E${pad2(episode)}`;
}

export interface CaptionMeta {
  /** 正文首行，作为标题的补充信息 */
  firstLine: string;
  /** 「简介：」之后的剧情描述；没有标记时退化为去掉标签的全文 */
  plot: string;
  /** #标签 */
  tags: string[];
}

/** 从正文里取剧情简介与标签，供 Emby 的 nfo 使用 */
export function parseCaptionMeta(raw: string): CaptionMeta {
  const text = (raw || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { firstLine: "", plot: "", tags: [] };

  const tags = [...text.matchAll(/#([^\s#,,，。:：]+)/g)].map((m) => m[1].trim()).filter(Boolean);

  const firstLine = text.split("\n")[0].replace(/#[^\s#]+/g, "").trim();

  const marker = text.split(PLOT_SPLIT_RE);
  let plotSource = marker.length > 1 ? marker.slice(1).join("") : text;
  plotSource = plotSource
    .replace(/#[^\s#]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const plot = plotSource.length > 1200 ? `${plotSource.slice(0, 1200)}…` : plotSource;

  return { firstLine, plot, tags: [...new Set(tags)] };
}

/**
 * 正文里解析不出剧名时，用「一个链接一个文件夹」兜底：
 * 文件夹名取正文首行（去掉链接、@提及、#标签），太长就截断。
 * 首行太短（如「01/12」这种序号行）时继续往下找，实在没有就用全文。
 */
export function fallbackFolderName(raw: string): string {
  const text = (raw || "").replace(/\r\n?/g, "\n");
  const clean = (value: string): string =>
    value
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\bwww\.\S+/gi, " ")
      .replace(/@[A-Za-z0-9_]{2,}/g, " ")
      .replace(/#[^\s#]+/g, " ")
      .replace(/[|｜]{2,}/g, " | ")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s|｜·•\-—:,，。]+|[\s|｜·•\-—:,，。]+$/g, "")
      .trim();

  let name = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const candidate = clean(line);
    if (candidate.length >= 3) {
      name = candidate;
      break;
    }
  }
  if (!name) name = clean(text);
  if (!name) return "";

  const cut = name.length > LOOSE_NAME_MAX ? name.slice(0, LOOSE_NAME_MAX) : name;
  const safe = sanitizeSegment(cut, LOOSE_NAME_MAX);
  return safe === "untitled" ? "" : safe;
}

const isVideoLike = (item: MediaLike): boolean => item.kind === "video" || item.kind === "gif";

/** 剧集命名（解析到剧名）或兜底命名（一链接一文件夹）共用的视频文件名 */
function videoFileName(dir: string, tag: string, order: number, count: number, ext: string): string {
  if (count > 1) return `${dir}${tag}-${pad2(order + 1)}${ext}`;
  return `${dir}${tag}${ext}`;
}

/**
 * 为一条消息内的所有文件规划最终落盘名。
 *
 * - 视频：`剧名S01E04.mp4`，同一条消息里的多个视频按顺序对应第 1-7 集
 * - 解析不到剧名但有视频：一个链接一个文件夹，文件夹与文件同名（正文首行），
 *   同一条消息里的多个视频加 `-01` 后缀区分
 * - 图片：只挑 3 张当封面（Emby 的 poster / landscape / fanart），其余标记 skip 不下载；
 *   没有视频的消息（纯图集）保持原来的 `剧名S01E04-p1.jpg` 全量下载
 * - 一条消息里有多个文件时，都放进同一个文件夹
 *
 * 解析不到剧名且没有视频（文档、音乐、纯图片）时全部返回 null，走原有命名逻辑。
 */
export function planFileNames(
  text: string,
  media: MediaLike[],
  options: {
    artCount?: number;
    artPrefix?: string;
    artPrefer?: number[];
    /** 是否启用「无法识别标题 → 一个链接一个文件夹」的兜底命名 */
    looseFolder?: boolean;
    /** 兜底文件夹名重名时改名（同一个链接重下要保持原名） */
    uniqueLooseDir?: (base: string) => string;
  } = {},
): NamedFile[] {
  const info = parseSeriesCaption(text);
  const looseBase = info ? "" : fallbackFolderName(text);
  const loose = !info && (options.looseFolder ?? true) && Boolean(looseBase) && media.some(isVideoLike);
  if (!info && !loose) return media.map(() => ({ dir: null, name: null }));

  const looseDir = loose ? (options.uniqueLooseDir?.(looseBase) ?? looseBase) : "";
  const dir = info ? info.series : looseDir;

  const plan: NamedFile[] = media.map(() => ({ dir, name: null }));
  const videoIndexes = media
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isVideoLike(item));

  const episodesPerVideo: Array<number | null> = videoIndexes.map((_entry, order) =>
    info ? episodeAt(info, order, videoIndexes.length) : null,
  );

  videoIndexes.forEach(({ item, index }, order) => {
    const episode = episodesPerVideo[order];
    const tag = info ? episodeTag(info, episode) : "";
    const ext = extensionOf(item);
    plan[index] = {
      dir,
      // 没有集数时退化为「剧名-01」/「剧名」，保证同一条消息内不重名
      name: videoFileName(dir, tag, order, videoIndexes.length, ext),
      episode,
      season: info?.season ?? 1,
      isVideo: true,
      loose: loose || undefined,
    };
  });

  const attachmentIndexes = media
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !isVideoLike(item));

  // 有视频 = 这是一集短剧：图片只留 3 张做封面，其余不下载
  const artCount = Math.max(0, options.artCount ?? 0);
  if (videoIndexes.length > 0 && artCount > 0) {
    // 监控历史里预览过这条消息的话，沿用当时给用户看的那几张图，
    // 别让「预览 3 张」和「下载做封面的 3 张」对不上
    const preferred = pickPreferred(attachmentIndexes, options.artPrefer);
    const rest = attachmentIndexes.filter((entry) => !preferred.includes(entry));
    const chosen = [
      ...preferred,
      ...pickRandom(rest, Math.max(0, artCount - preferred.length)),
    ].slice(0, artCount);
    const chosenSet = new Set(chosen.map((entry) => entry.index));
    let artNo = 0;
    for (const { item, index } of attachmentIndexes) {
      if (!chosenSet.has(index)) {
        plan[index] = { dir, name: null, skip: true };
        continue;
      }
      artNo += 1;
      // 名字带上消息 id：同一集的不同图片、以及不同集之间都不会撞名
      const prefix = options.artPrefix ? `${options.artPrefix}-` : "";
      plan[index] = { dir, name: `.art-${prefix}${artNo}${extensionOf(item)}` };
    }
    return plan;
  }

  // 附属文件（剧照/封面/文档）挂到这条消息第一集的编号下
  const anchorEpisode = episodesPerVideo.length ? episodesPerVideo[0] : (info?.episodes[0] ?? null);
  const anchorTag = info ? episodeTag(info, anchorEpisode) : "";
  let attachmentNo = 0;
  for (const { item, index } of attachmentIndexes) {
    attachmentNo += 1;
    const ext = extensionOf(item);
    plan[index] = {
      dir,
      name: anchorTag
        ? `${dir}${anchorTag}-p${attachmentNo}${ext}`
        : `${dir}-p${attachmentNo}${ext}`,
      episode: anchorEpisode,
      season: info?.season ?? 1,
      loose: loose || undefined,
    };
  }

  return plan;
}

/**
 * 按「相册里第几张图」挑出用户预览过的那些。
 * 序号只数图片（photo），跟封面预览接口的编号方式保持一致，
 * 中间夹着文档/音频也不会错位。
 */
function pickPreferred<T extends { item: MediaLike }>(list: T[], prefer: number[] | undefined): T[] {
  if (!prefer || prefer.length === 0) return [];
  const wanted = new Set(prefer);
  const picked: T[] = [];
  let ordinal = 0;
  for (const entry of list) {
    if (entry.item.kind !== "photo") continue;
    if (wanted.has(ordinal)) picked.push(entry);
    ordinal += 1;
  }
  return picked;
}

/** 从附件里随机挑 n 个（消息里的图片顺序即相册顺序，随机取保证每集封面不重样） */
function pickRandom<T>(list: T[], n: number): T[] {
  const pool = [...list];
  const picked: T[] = [];
  while (pool.length > 0 && picked.length < n) {
    const index = randomInt(pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

function randomInt(max: number): number {
  if (max <= 0) return 0;
  return crypto.randomInt(max);
}
