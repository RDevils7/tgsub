/**
 * 机器人「自己收到文件」这条链路的纯逻辑层。
 *
 * 背景（1.3.18）：有些资源机器人（例如 t.me/epan?start=… 那种文件夹分享）不是发一条
 * 「频道消息链接」，而是分三条把内容推进私聊：
 *   ① 📁 标题 + 内容统计 + 分享链接 + 「开始发送内容」
 *   ② 一条**没有文字、但自带 MessageMediaDocument** 的视频
 *   ③ ✅ 文件夹内容发送完成
 * 转发给 tgsub 机器人后，`fwd_from` 只有 channelId、没有 channelPost（不是频道帖子），
 * 原来的 forward 分支定位不到原消息；而 ② 又因为「没有文字」被 empty-text 直接丢掉，
 * 于是文件根本没进队列，①③ 还各刷一条 bot-unparsed warn。
 *
 * 这里不 import telegram / db / downloader：
 *   - 消息对象缓存 + 「重启后按 id 重取」的 resolver 用注册的方式注入，避免 bot.ts 与
 *     downloader.ts 互相 import 形成循环；
 *   - 分享状态识别、命名规划都是纯函数，自检可以直接喂普通对象。
 *
 * 落库入队在 direct.ts::enqueueBotMedia，取消息下载在 downloader.ts 的 source='bot' 分支。
 */
import path from "node:path";
import { sanitizeSegment } from "../utils";
import { fallbackFolderName, planFileNames, type MediaLike } from "./naming";
import { joinRel } from "./mediadir";

/* ------------------------------------------------------------------ */
/* 消息定位                                                            */
/* ------------------------------------------------------------------ */

export interface BotMediaRef {
  /** 机器人私聊的 peer id（十进制字符串，gramjs 的 long 要先转文本） */
  chatId: string;
  /** 这条消息在机器人会话里的 id */
  messageId: number;
}

/** 存进 downloads.source_url：重启后仍能把这条媒体从 bot 会话里捞回来 */
export function botSourceUrl(ref: BotMediaRef): string {
  return `tgbot:${ref.chatId}:${ref.messageId}`;
}

export function parseBotSource(raw: string | null | undefined): BotMediaRef | null {
  const matched = /^tgbot:(-?\d+):(\d+)$/.exec(String(raw ?? "").trim());
  if (!matched) return null;
  const messageId = Number(matched[2]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  return { chatId: matched[1], messageId };
}

/* ------------------------------------------------------------------ */
/* 原始消息缓存：下载当下直接用内存里的对象，最可靠                     */
/* ------------------------------------------------------------------ */

const MESSAGE_TTL = 30 * 60_000;
const MAX_CACHED = 200;
const cachedMessages = new Map<string, { at: number; message: unknown }>();

function cacheKey(ref: BotMediaRef): string {
  return `${ref.chatId}:${ref.messageId}`;
}

function sweepMessages(now: number): void {
  for (const [key, item] of cachedMessages) {
    if (now - item.at > MESSAGE_TTL) cachedMessages.delete(key);
  }
  while (cachedMessages.size > MAX_CACHED) {
    const oldest = cachedMessages.keys().next().value;
    if (oldest === undefined) break;
    cachedMessages.delete(oldest);
  }
}

export function rememberBotMessage(ref: BotMediaRef, message: unknown): void {
  const now = Date.now();
  sweepMessages(now);
  cachedMessages.set(cacheKey(ref), { at: now, message });
}

export function cachedBotMessage(ref: BotMediaRef): unknown | null {
  const item = cachedMessages.get(cacheKey(ref));
  if (!item) return null;
  if (Date.now() - item.at > MESSAGE_TTL) {
    cachedMessages.delete(cacheKey(ref));
    return null;
  }
  return item.message;
}

export function forgetBotMessage(ref: BotMediaRef): void {
  cachedMessages.delete(cacheKey(ref));
}

/* ------------------------------------------------------------------ */
/* bot 客户端 / 回源取消息的注册器                                      */
/* ------------------------------------------------------------------ */

export interface BotMediaResolution {
  /** TelegramClient（由 bot.ts 提供，类型在这里保持 unknown 以免反向依赖） */
  client: unknown;
  /** 带 media 的 gramjs Message */
  message: unknown;
}

export type BotClientProvider = () => unknown | null;
/** 缓存没命中（例如进程重启后队列里还有任务）时按 id 回源取消息 */
export type BotMessageResolver = (ref: BotMediaRef) => Promise<unknown | null>;

let clientProvider: BotClientProvider | null = null;
let messageResolver: BotMessageResolver | null = null;

export function setBotMediaClientProvider(fn: BotClientProvider | null): void {
  clientProvider = fn;
}

export function setBotMessageResolver(fn: BotMessageResolver | null): void {
  messageResolver = fn;
}

export async function resolveBotMedia(ref: BotMediaRef): Promise<BotMediaResolution | null> {
  const client = clientProvider?.() ?? null;
  if (!client) return null;
  let message = cachedBotMessage(ref);
  if (!message && messageResolver) {
    message = await messageResolver(ref).catch(() => null);
  }
  if (!message) return null;
  return { client, message };
}

/* ------------------------------------------------------------------ */
/* 分享机器人的状态卡片                                                */
/* ------------------------------------------------------------------ */

export type ShareNoticeKind = "share-header" | "share-footer";

export interface ShareNotice {
  kind: ShareNoticeKind;
  /** 从「📁 xxx」第一行抠出来的文件夹标题；认不出为 null */
  title: string | null;
}

const EMOJI_PREFIX = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+/u;

/**
 * 识别文件夹分享机器人发的「状态消息」。
 * 这些不是用户要下载的内容，也不该被当成解析失败刷 warn、更不该回一串 /help。
 */
export function classifyShareNotice(raw: string): ShareNotice | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const isFooter =
    /文件夹内容发送完成|内容发送完成|文件发送完成/.test(text) ||
    /共发送\s*\d+\s*条(?:消息|文件)/.test(text);
  if (isFooter) return { kind: "share-footer", title: null };

  const isHeader =
    /内容统计/.test(text) &&
    (/分享链接/.test(text) || /开始发送/.test(text) || /消息数/.test(text));
  if (!isHeader) return null;

  const first = text.split(/\r?\n/)[0]?.trim() ?? "";
  const title = first
    .replace(EMOJI_PREFIX, "")
    .replace(/[*_`~]/g, "")
    .trim()
    .slice(0, 80);
  return { kind: "share-header", title: title || null };
}

/* ------------------------------------------------------------------ */
/* 标题缓存：① 的标题给随后 ② 的文件命名                               */
/* ------------------------------------------------------------------ */

const TITLE_TTL = 15 * 60_000;
const shareTitles = new Map<string, { title: string; at: number }>();

export function rememberShareTitle(chatId: string, title: string): void {
  const now = Date.now();
  for (const [key, item] of shareTitles) {
    if (now - item.at > TITLE_TTL) shareTitles.delete(key);
  }
  const clean = sanitizeSegment(title, 80);
  if (clean && clean !== "untitled") shareTitles.set(chatId, { title: clean, at: now });
}

/** 读取但不删除：同一个文件夹可能连着推好几个文件，标题要一直用到 footer */
export function takeShareTitle(chatId: string): string | null {
  const item = shareTitles.get(chatId);
  if (!item) return null;
  if (Date.now() - item.at > TITLE_TTL) {
    shareTitles.delete(chatId);
    return null;
  }
  return item.title;
}

export function clearShareTitle(chatId: string): void {
  shareTitles.delete(chatId);
}

/* ------------------------------------------------------------------ */
/* 命名：与频道下载共用 planFileNames，认不出剧名时按分享标题归档        */
/* ------------------------------------------------------------------ */

export interface BotSavePlan {
  /** 相对下载根的完整目录（含 telegram/ 来源前缀） */
  saveDir: string;
  /** 最终文件名（含扩展名） */
  saveName: string;
  /** 纯剧名（NFO 的 showtitle / series 用这个，不带来源前缀） */
  series: string;
  season: number;
  episode: number | null;
}

export function planBotSaveName(
  caption: string,
  info: MediaLike,
  options: { sourceDir: string; looseFolder: boolean },
): BotSavePlan {
  const text = String(caption ?? "").trim();
  const stem = path.parse(info.fileName).name;
  const rawName = sanitizeSegment(info.fileName, 150);

  // 没有标题（用户直接丢了个文件、或分享卡片没被认出来）时别把裸文件名喂给
  // planFileNames：它是按「正文 + 媒体列表」设计的，把 `美人局S01E04.mp4` 当正文
  // 会解析出 `美人局 .mp4` 这种夹着扩展名的假剧名。直接用文件名本身归档最稳。
  if (!text) {
    const series = sanitizeSegment(stem, 60);
    return {
      saveDir: joinRel(options.sourceDir, series) || series,
      saveName: rawName,
      series,
      season: 1,
      episode: null,
    };
  }

  const planned = planFileNames(text, [info], {
    messageCount: 1,
    looseFolder: options.looseFolder,
    skipAttachments: false,
  })[0];
  const series = String(planned?.dir ?? "").trim() || fallbackFolderName(text) || sanitizeSegment(stem, 60);
  const saveName = String(planned?.name ?? "").trim() || rawName;
  return {
    saveDir: joinRel(options.sourceDir, series) || series,
    saveName,
    series,
    season: planned?.season ?? 1,
    episode: planned?.episode ?? null,
  };
}
