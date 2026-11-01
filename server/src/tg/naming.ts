import crypto from "node:crypto";
import path from "node:path";
import { sanitizeSegment } from "../utils";
import { guessExtension, type MediaInfo } from "./media";

/**
 * 剧集命名。
 *
 * 频道里的短剧通常把剧名和集数写在正文（caption）或原始文件名里，例如：
 *   《美人局》第4集 连载中 全系列完整版 简介：……
 *   《欲女梦工厂》第1-7集 连载中 ……
 *   妈妈我爱你 EP1-10                       ← 没有书名号，集数靠正文里的标记
 *   2048真实故事改编 - 妈妈我爱你 第1集 - AI短剧.mp4   ← 集数在文件名里
 * 下载后的文件按解析结果命名：
 *   美人局/美人局S01E04.mp4
 *   欲女梦工厂/欲女梦工厂S01E01.mp4 ~ 欲女梦工厂S01E07.mp4
 *   妈妈我爱你/妈妈我爱你S01E01.mp4 ~ 妈妈我爱你S01E10.mp4
 *   妈妈我爱你/妈妈我爱你S01E01-E10.mp4    ← 单个文件本身就是 1-10 集的合集
 * 同一剧名始终落在同一个文件夹，后续更新会自动续进去。
 */

export interface SeriesInfo {
  /** 规范化后的剧名，直接用作文件夹名 */
  series: string;
  season: number;
  /** 正文里声明的集数（升序去重）；识别不到时为空数组 */
  episodes: number[];
  /** 正文里声明的集数区间（如「EP1-10」「第1-10集」），没有则为 null */
  range: { from: number; to: number } | null;
}

const SERIES_RES = [/《([^》\n]{1,60})》/, /[「【]([^」】\n]{1,60})[」】]/];
const SEASON_RE = /第\s*([0-9]{1,3}|[零一二两三四五六七八九十]{1,3})\s*季/;
/** 正文里的“简介：”之后是剧情描述，可能混进别的“第X集”，截断掉再解析 */
const PLOT_SPLIT_RE = /(?:简介|剧情|内容简介|文案)\s*[:：]/;
/** 兜底文件夹名的长度上限：太长在文件管理器里看不全 */
const LOOSE_NAME_MAX = 50;

/* ------------------------------------------------------------------ *
 * 集数标记
 * ------------------------------------------------------------------ */

/** 标记在文本中的位置与长度：用来把剧名从标记前后切出来 */
interface MarkMatch {
  season: number | null;
  episode: number | null;
  range: { from: number; to: number } | null;
  list: number[] | null;
  index: number;
  length: number;
}

/** S01E01 */
const MARK_SE = /\bS(\d{1,2})\s*[._-]?\s*E(?:P)?\s*(\d{1,4})\b/i;
/** S01E01-E10（一个文件里含多集） */
const MARK_SE_RANGE = /\bS(\d{1,2})\s*[._-]?\s*E(?:P)?\s*(\d{1,4})\s*[-~—–]\s*E?(?:P)?\s*(\d{1,4})\b/i;
/** 第1-10集 */
const MARK_CN_RANGE = /第\s*([0-9]{1,4})\s*[-~—–－至到]\s*([0-9]{1,4})\s*[集话話期]/;
/** 第1集 / 第1、2集 */
const MARK_CN_LIST = /第\s*([0-9]{1,4}(?:\s*[,，、和及/]\s*[0-9]{1,4})*)\s*[集话話期]/;
/** EP1-10 */
const MARK_EP_RANGE = /\bEP?\s*(\d{1,4})\s*[-~—–]\s*(\d{1,4})\b/i;
/** EP1 / E1 */
const MARK_EP = /\b(?:EP|E)\s*(\d{1,4})\b/i;

/** 抹掉文本里的集数标记，只留下剧名候选 */
const STRIP_SE =
  /\bS\d{1,2}\s*[._-]?\s*E(?:P)?\s*\d{1,4}(?:\s*[-~—–]\s*E?(?:P)?\s*\d{1,4})?/gi;
const STRIP_CN =
  /第\s*[0-9]{1,4}\s*(?:[-~—–－至到]\s*[0-9]{1,4})?(?:\s*[,，、和及/]\s*[0-9]{1,4})*\s*[集话話期]/g;
const STRIP_EP = /\bEP?\s*\d{1,4}(?:\s*[-~—–]\s*\d{1,4})?/gi;
const STRIP_SEASON = /第\s*[0-9一二三四五六七八九十]{1,3}\s*季/g;

/** 文件名里分隔剧名与标签的符号 */
const NAME_SEP_RE = /[-–—_·|｜]+/;

/**
 * 这些词出现在剧名候选里，说明抓到的是「宣传语」而不是剧名，
 * 这时候宁可退回「一链接一文件夹」的兜底命名。
 */
const SERIES_BLOCK_WORDS =
  /(连载|完结|全集|全系列|完整版|未删减|无删减|蓝光|高清|资源|分享|速看|合集|简介|剧情|更新|正版|首发|短剧)/;

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

/** 剧名清洗：去掉包裹符号、空白与路径非法字符，限制长度。 */
function normalizeSeriesName(raw: string): string {
  const base = raw
    .replace(/[《》「」【】]/g, "")
    .replace(/\s*第\s*[0-9一二三四五六七八九十]{1,3}\s*季\s*$/, "")
    .trim();
  const cleaned = sanitizeSegment(base || raw.trim(), 40);
  return cleaned === "untitled" ? "" : cleaned;
}

/** 去掉链接、@提及、#标签与首尾的杂符号 */
function cleanupSeriesText(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/@[A-Za-z0-9_]{2,}/g, " ")
    .replace(/#[^\s#]+/g, " ")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s|｜·•\-—:,，。、!！?？~～+]+/, "")
    .replace(/[\s|｜·•\-—:,，。、!！?？~～+]+$/, "")
    .trim();
}

/** 剧名候选是否像剧名：太短、太长、带宣传词或纯数字都不算 */
function isPlausibleSeries(text: string): boolean {
  if (!text) return false;
  if (text.length < 2 || text.length > 40) return false;
  if (SERIES_BLOCK_WORDS.test(text)) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  if (/^[0-9\s|｜·•\-—:：,，。、]+$/.test(text)) return false;
  return true;
}

/** 从一段文字里解析集数标记（只取第一个命中的） */
function parseMarks(text: string): MarkMatch | null {
  const seRange = MARK_SE_RANGE.exec(text);
  if (seRange) {
    const from = Number(seRange[2]);
    const to = Number(seRange[3]);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
      return {
        season: Number(seRange[1]) || 1,
        episode: null,
        range: { from, to },
        list: null,
        index: seRange.index,
        length: seRange[0].length,
      };
    }
  }

  const se = MARK_SE.exec(text);
  if (se) {
    const episode = Number(se[2]);
    if (Number.isFinite(episode) && episode > 0) {
      return {
        season: Number(se[1]) || 1,
        episode,
        range: null,
        list: null,
        index: se.index,
        length: se[0].length,
      };
    }
  }

  const cnRange = MARK_CN_RANGE.exec(text);
  if (cnRange) {
    const from = Number(cnRange[1]);
    const to = Number(cnRange[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= 500) {
      return {
        season: null,
        episode: null,
        range: { from, to },
        list: null,
        index: cnRange.index,
        length: cnRange[0].length,
      };
    }
  }

  const cnList = MARK_CN_LIST.exec(text);
  if (cnList) {
    const list = cnList[1]
      .split(/[,，、和及/]+/)
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (list.length === 1) {
      // 「第1集」这种单集写法走这里，跟 EP1 / S01E01 一样当成单集
      return {
        season: null,
        episode: list[0],
        range: null,
        list: null,
        index: cnList.index,
        length: cnList[0].length,
      };
    }
    if (list.length) {
      return {
        season: null,
        episode: null,
        range: null,
        list,
        index: cnList.index,
        length: cnList[0].length,
      };
    }
  }

  const epRange = MARK_EP_RANGE.exec(text);
  if (epRange) {
    const from = Number(epRange[1]);
    const to = Number(epRange[2]);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= 500) {
      return {
        season: null,
        episode: null,
        range: { from, to },
        list: null,
        index: epRange.index,
        length: epRange[0].length,
      };
    }
  }

  const ep = MARK_EP.exec(text);
  if (ep) {
    const episode = Number(ep[1]);
    if (Number.isFinite(episode) && episode > 0) {
      return {
        season: null,
        episode,
        range: null,
        list: null,
        index: ep.index,
        length: ep[0].length,
      };
    }
  }

  return null;
}

/**
 * 从正文里推剧名：正文没有书名号，但写了集数时（如「妈妈我爱你 EP1-10」），
 * 把集数标记抹掉，剩下的就是剧名。抹完还像宣传语的直接放弃，交给兜底命名。
 */
export function deriveSeriesFromText(raw: string): string {
  const text = (raw || "").replace(/\r\n?/g, "\n");
  const firstLine = text.split("\n")[0] ?? "";
  const head = firstLine.split(PLOT_SPLIT_RE)[0] ?? firstLine;
  // 正文里没有集数/季数标记时，不能据此判断剧名：
  // 「今天的照片」这种内容走原来的兜底命名，不能凭空造一个剧集文件夹
  if (!parseMarks(head) && !SEASON_RE.test(head)) return "";
  const stripped = head
    .replace(STRIP_SE, " ")
    .replace(STRIP_CN, " ")
    .replace(STRIP_EP, " ")
    .replace(STRIP_SEASON, " ");
  const cleaned = cleanupSeriesText(stripped);
  if (!isPlausibleSeries(cleaned)) return "";
  return normalizeSeriesName(cleaned);
}

/**
 * 从消息正文解析剧集信息。
 *
 * 剧名优先取《》/「」/【】里的名字；没有书名号时，正文里的集数标记也能反推出剧名。
 * 识别不到剧名时返回 null，此时保持原有的文件名（文档、音乐、普通图片等不应被改名）。
 */
export function parseSeriesCaption(raw: string): SeriesInfo | null {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, " ").trim();

  let series = "";
  for (const re of SERIES_RES) {
    const match = text.match(re);
    if (match) {
      series = normalizeSeriesName(match[1]);
      break;
    }
  }
  if (!series) series = deriveSeriesFromText(raw);
  if (!series) return null;

  // 只看“简介：”之前的部分，避免剧情里出现的“第X集”干扰
  const head = text.split(PLOT_SPLIT_RE)[0] ?? text;

  const seasonCn = toEpisodeNumber(SEASON_RE.exec(head)?.[1] ?? "");
  let season = seasonCn && seasonCn >= 1 ? seasonCn : 1;

  let episodes: number[] = [];
  let range: { from: number; to: number } | null = null;

  const marks = parseMarks(head);
  if (marks) {
    if (marks.season) season = marks.season;
    if (marks.range) {
      range = marks.range;
      episodes = Array.from({ length: range.to - range.from + 1 }, (_, i) => range!.from + i);
    } else if (marks.episode !== null) {
      episodes = [marks.episode];
    } else if (marks.list) {
      episodes = marks.list;
    }
  }

  episodes = [...new Set(episodes)].sort((a, b) => a - b);
  return { series, season, episodes, range };
}

/** 原始文件名里解析出来的剧集信息 */
export interface FileNameMarks {
  /** 剧名候选（可能为空） */
  series: string;
  season: number | null;
  episode: number | null;
  range: { from: number; to: number } | null;
}

/**
 * 从原始文件名里解析剧名与集数。
 *
 * 频道给的原始文件名常常带集数，甚至带剧名：
 *   2048真实故事改编 - 妈妈我爱你 第1集 - AI短剧.mp4
 * 集数标记前面的那一段（按 - _ 等符号切开后取最后一段）就是剧名。
 */
export function parseFileNameMarks(fileName: string): FileNameMarks {
  const empty: FileNameMarks = { series: "", season: null, episode: null, range: null };
  const raw = String(fileName ?? "").trim();
  if (!raw) return empty;

  const ext = path.extname(raw);
  const stem = ext && /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? raw.slice(0, -ext.length) : raw;
  const marks = parseMarks(stem);
  if (!marks) return empty;

  const before = stem.slice(0, marks.index);
  const after = stem.slice(marks.index + marks.length);
  const series = pickSeriesChunk(before, "before") || pickSeriesChunk(after, "after");

  return {
    series,
    season: marks.season,
    episode: marks.episode,
    range: marks.range,
  };
}

/** 从标记前（或后）的一段文字里切出剧名候选 */
function pickSeriesChunk(text: string, side: "before" | "after"): string {
  const cleaned = cleanupSeriesText(text);
  if (!cleaned) return "";
  const chunks = cleaned
    .split(NAME_SEP_RE)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  if (!chunks.length) return "";
  const candidate = side === "before" ? chunks[chunks.length - 1] : chunks[0];
  if (!isPlausibleSeries(candidate)) return "";
  return normalizeSeriesName(candidate);
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

/** 集数标签：单集是 S01E04，一个文件含多集是 S01E01-E10 */
export function episodeTag(season: number, episode: number | null, range: { from: number; to: number } | null): string {
  const s = pad2(season || 1);
  if (episode !== null && episode !== undefined) return `S${s}E${pad2(episode)}`;
  if (range) return `S${s}E${pad2(range.from)}-E${pad2(range.to)}`;
  return "";
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

/**
 * 旧版命名会带一截序号：「美人局S01E04-04.mp4」。
 * 新规则只要「美人局S01E04.mp4」，历史数据靠这个函数纠正。
 * 认不出来（不是 SxxExx 形态）时返回 null，表示不用改。
 */
const LEGACY_INDEX_RE = /^(.*S\d{2}E\d{2})-(\d{2})$/;

export function stripLegacyIndex(fileName: string): string | null {
  const text = String(fileName ?? "").trim();
  if (!text) return null;
  const ext = path.extname(text);
  const stem = ext ? text.slice(0, -ext.length) : text;
  if (!LEGACY_INDEX_RE.test(stem)) return null;
  return `${stem.replace(LEGACY_INDEX_RE, "$1")}${ext}`;
}

/**
 * 剧集命名（解析到剧名）或兜底命名（一链接一文件夹）共用的视频文件名。
 *
 * 已经带出 SxxExx 集号时不再追加序号：剧名S01E05.mp4 就够了，
 * 多一个「-05」既冗余又和集号重复。
 * 只有在认不出集号（一条消息里多个视频）时才用序号区分：剧名-01.mp4。
 */
function videoFileName(dir: string, tag: string, order: number, count: number, ext: string): string {
  if (tag) return `${dir}${tag}${ext}`;
  if (count > 1) return `${dir}-${pad2(order + 1)}${ext}`;
  return `${dir}${ext}`;
}

/** 从所有视频文件名里挑出出现最多的剧名候选 */
function pickSeriesFromFiles(fileMarks: FileNameMarks[]): string {
  const tally = new Map<string, number>();
  for (const marks of fileMarks) {
    if (!marks.series) continue;
    tally.set(marks.series, (tally.get(marks.series) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [name, count] of tally) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** 一条视频最终用哪个集号 */
interface VideoSlot {
  season: number;
  episode: number | null;
  range: { from: number; to: number } | null;
}

/**
 * 集号优先级：
 * 1. 文件名里自带的集号（第X集 / EP X / S01E01）最准；
 * 2. 正文声明的范围与视频数对得上时按顺序一一对应；
 * 3. 正文声明了范围但视频数对不上，从首集顺延；
 * 4. 都认不出就没有集号（走「剧名-01」序号兜底）。
 */
function resolveSlots(
  fileMarks: FileNameMarks[],
  videoCount: number,
  groupEpisodes: number[],
  groupSeason: number,
  groupRange: { from: number; to: number } | null,
  singleMessage: boolean,
): VideoSlot[] {
  return fileMarks.map((marks, order) => {
    const season = marks.season ?? groupSeason;
    // 只有一条消息、一个视频，正文又写了集数区间：
    // 说明这个文件本身就是合集，用 S01E01-E10 这种范围名，Emby 才认得出
    if (singleMessage && videoCount === 1 && groupRange) {
      return { season, episode: null, range: groupRange };
    }
    if (marks.episode !== null) {
      return { season, episode: marks.episode, range: null };
    }
    if (marks.range) {
      return { season, episode: null, range: marks.range };
    }
    if (!groupEpisodes.length) {
      return { season, episode: null, range: null };
    }
    // 集数列表与视频数对得上就一一对应，否则从首集顺延
    if (groupEpisodes.length === videoCount) {
      return { season, episode: groupEpisodes[order], range: null };
    }
    return { season, episode: groupEpisodes[0] + order, range: null };
  });
}

/**
 * 为一条消息内的所有文件规划最终落盘名。
 *
 * - 视频：`剧名S01E04.mp4`，同一条消息里的多个视频按顺序对应第 1-7 集
 * - 单个视频本身含多集：`剧名S01E01-E10.mp4`（Emby 会认成第 1-10 集）
 * - 解析不到剧名但有视频：一个链接一个文件夹，文件夹与文件同名（正文首行），
 *   同一条消息里的多个视频加 `-01` 后缀区分
 * - 有视频时的图片：默认整条跳过（`skipAttachments`），封面改由视频截帧生成；
 *   没有视频的消息（纯图集）保持原来的 `剧名S01E04-p1.jpg` 全量下载
 * - 需要沿用「消息图片当封面」时传 `artCount`，挑 N 张命名成 `.art-*`
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
    /** 有视频时把非视频附件全部标记 skip（封面改由视频截帧生成） */
    skipAttachments?: boolean;
    /** 是否启用「无法识别标题 → 一个链接一个文件夹」的兜底命名 */
    looseFolder?: boolean;
    /** 兜底文件夹名重名时改名（同一个链接重下要保持原名） */
    uniqueLooseDir?: (base: string) => string;
    /** 这批文件来自几条消息：一条=单文件，多条=相册 */
    messageCount?: number;
  } = {},
): NamedFile[] {
  const captionInfo = parseSeriesCaption(text);
  const fileMarks = media.map((item) => parseFileNameMarks(item.fileName));

  // 剧名：正文优先，正文认不出就从原始文件名里找
  const series = captionInfo?.series || pickSeriesFromFiles(fileMarks);

  const looseBase = series ? "" : fallbackFolderName(text);
  const loose = !series && (options.looseFolder ?? true) && Boolean(looseBase) && media.some(isVideoLike);
  if (!series && !loose) return media.map(() => ({ dir: null, name: null }));

  const looseDir = loose ? (options.uniqueLooseDir?.(looseBase) ?? looseBase) : "";
  const dir = series || looseDir;

  const plan: NamedFile[] = media.map(() => ({ dir, name: null }));
  const videoIndexes = media
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isVideoLike(item));
  const videoCount = videoIndexes.length;

  const groupEpisodes = captionInfo?.episodes ?? [];
  const groupSeason = captionInfo?.season ?? 1;
  const groupRange = captionInfo?.range ?? null;
  // 消息条数：一条消息里通常就是一个文件，多条消息就是相册
  const singleMessage = (options.messageCount ?? media.length) <= 1;
  const slots = resolveSlots(
    videoIndexes.map(({ index }) => fileMarks[index]),
    videoCount,
    groupEpisodes,
    groupSeason,
    groupRange,
    singleMessage,
  );

  videoIndexes.forEach(({ item, index }, order) => {
    const slot = slots[order];
    const tag = series ? episodeTag(slot.season, slot.episode, slot.range) : "";
    const ext = extensionOf(item);
    plan[index] = {
      dir,
      // 没有集数时退化为「剧名-01」/「剧名」，保证同一条消息内不重名
      name: videoFileName(dir, tag, order, videoCount, ext),
      episode: slot.episode,
      season: slot.season,
      isVideo: true,
      loose: loose || undefined,
    };
  });

  const attachmentIndexes = media
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !isVideoLike(item));

  // 有视频 = 这是一集短剧。新版本封面全部由视频截帧生成，
  // 消息里的图片（台词截图、集数水印图）不再下载，连下载记录都不建
  if (videoIndexes.length > 0 && options.skipAttachments) {
    for (const { index } of attachmentIndexes) plan[index] = { dir, name: null, skip: true };
    return plan;
  }

  // 需要沿用「消息图片当封面」时：只留 N 张，其余不下载
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
  const anchor = slots[0];
  const anchorEpisode = anchor?.episode ?? captionInfo?.episodes[0] ?? null;
  const anchorSeason = anchor?.season ?? groupSeason;
  const anchorTag = series ? episodeTag(anchorSeason, anchorEpisode, anchor?.range ?? null) : "";
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
      season: anchorSeason,
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
