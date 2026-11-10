/**
 * 机器人入站消息的「原始留痕」。
 *
 * 以前只有真正解析成功的消息才会产生日志：认不出的分享口令、纯图片、
 * 只发了个表情、权限被拒、群消息……全都静默返回。出问题时翻日志只能看到
 * 「什么都没发生」，根本不知道用户当时到底发了什么，也就没法补解析规则。
 *
 * 现在任何一条入站消息都会先整理成结构化摘要并落一条 info 日志：
 *   - 原文（文本 / 媒体 caption）按上限截断，超长时标出原始长度；
 *   - 富文本实体、媒体类型、文件名 / MIME / 大小、转发来源、相册 ID、
 *     回复目标、网页预览地址一并带上；
 *   - 所有 ID 都按「gramjs long 是 big-integer 对象」处理，不能只认 bigint。
 *
 * 这个模块不 import telegram / db / logger：喂普通对象就能自检。
 */

export const BOT_LOG_TEXT_LIMIT = 2000;
const MAX_ENTITIES = 30;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return value !== null && typeof value === "object" ? (value as Rec) : {};
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 把 gramjs 的 long / Peer* / 普通数字统一成十进制字符串。
 *
 * big-integer 的 BigInteger 实例 `typeof === "object"`，只有 `toString()`
 * 能拿到数字；容器对象则先往里钻一层。这里**保留负号与 -100 前缀**，
 * 日志里要能区分频道 ID 和用户 ID。
 */
export function botIdText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return /^-?\d+$/.test(value.trim()) ? value.trim() : null;
  if (typeof value === "object") {
    const obj = value as Rec;
    const nested = obj.channelId ?? obj.chatId ?? obj.userId ?? obj.id;
    if (nested !== undefined && nested !== null) return botIdText(nested);
    try {
      const text = String(obj).trim();
      return /^-?\d+$/.test(text) ? text : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // gramjs 的 date 是 Unix 秒；毫秒时间戳也兼容一下
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 40);
  return null;
}

export interface BotEntityLog {
  type: string;
  offset: number | null;
  length: number | null;
  url?: string;
}

export interface BotInboundLog {
  botEvent: "bot-in";
  messageId: string | null;
  chatId: string | null;
  senderId: string | null;
  /** @username 或「名 姓」，认不出来就是 null */
  from: string | null;
  isPrivate: boolean | null;
  date: string | null;
  /** 原文 / 媒体 caption；超过上限截断 */
  text: string;
  textLength: number;
  textTruncated: boolean;
  /** MessageMedia* 的 className，纯文字消息为 null */
  media: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  entities: BotEntityLog[];
  fwdFrom: {
    channelId: string | null;
    channelPost: string | null;
    fromName: string | null;
    date: string | null;
  } | null;
  groupedId: string | null;
  replyToId: string | null;
  webPageUrl: string | null;
  viaBotId: string | null;
}

/** 从任意 gramjs 消息对象里安全地抠出日志摘要；字段缺失一律给 null，绝不抛错 */
export function summarizeInbound(raw: unknown, maxText = BOT_LOG_TEXT_LIMIT): BotInboundLog {
  const msg = rec(raw);
  const rawText = typeof msg.message === "string" ? msg.message : "";
  const textLength = rawText.length;
  const text = rawText.slice(0, Math.max(0, maxText));

  const sender = rec(msg.sender ?? msg.fromId);
  const username = shortText(sender.username, 64);
  const displayName = shortText(
    [sender.firstName, sender.lastName, sender.title].filter((v) => typeof v === "string").join(" "),
    64,
  );
  const from = username ? `@${username}` : displayName;

  const media = rec(msg.media);
  const mediaType = shortText(media.className, 80);
  const document = rec(media.document ?? msg.document);
  const attributes = Array.isArray(document.attributes) ? document.attributes : [];
  let fileName: string | null = null;
  for (const item of attributes) {
    const name = shortText(rec(item).fileName, 160);
    if (name) {
      fileName = name;
      break;
    }
  }

  const entityList = Array.isArray(msg.entities) ? msg.entities.slice(0, MAX_ENTITIES) : [];
  const entities: BotEntityLog[] = entityList.map((item) => {
    const entity = rec(item);
    const className = shortText(entity.className, 80) ?? "unknown";
    const url = shortText(entity.url, 300);
    return {
      type: className.replace(/^MessageEntity/, "") || className,
      offset: toNumber(entity.offset),
      length: toNumber(entity.length),
      ...(url ? { url } : {}),
    };
  });

  const fwd = rec(msg.fwdFrom);
  const fwdFrom = Object.keys(fwd).length
    ? {
        channelId: botIdText(fwd.fromId),
        channelPost: botIdText(fwd.channelPost),
        fromName: shortText(fwd.fromName, 120),
        date: isoDate(fwd.date),
      }
    : null;

  const webpage = rec(media.webpage);
  const replyTo = rec(msg.replyTo);

  return {
    botEvent: "bot-in",
    messageId: botIdText(msg.id),
    chatId: botIdText(msg.chatId ?? msg.peerId),
    senderId: botIdText(msg.senderId ?? sender.id),
    from,
    isPrivate: typeof msg.isPrivate === "boolean" ? msg.isPrivate : null,
    date: isoDate(msg.date),
    text,
    textLength,
    textTruncated: textLength > text.length,
    media: mediaType,
    fileName,
    mimeType: shortText(document.mimeType, 120),
    fileSize: toNumber(document.size),
    entities,
    fwdFrom,
    groupedId: botIdText(msg.groupedId ?? media.groupedId),
    replyToId: botIdText(msg.replyToMsgId ?? replyTo.replyToMsgId),
    webPageUrl: mediaType === "MessageMediaWebPage" ? shortText(webpage.url, 500) : null,
    viaBotId: botIdText(msg.viaBotId),
  };
}
