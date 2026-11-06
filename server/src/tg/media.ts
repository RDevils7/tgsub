import path from "node:path";
import bigInt from "big-integer";
import { Api } from "telegram";
import { toNumber } from "../utils";
import { logger } from "../logger";
import { getClient } from "./client";
import { normalizeEntityKey } from "./entity";

export interface MediaInfo {
  kind: "photo" | "video" | "audio" | "voice" | "document" | "gif";
  fileName: string;
  size: number;
  mimeType: string | null;
}

type AnyRecord = Record<string, unknown>;

function documentAttributes(doc: AnyRecord): AnyRecord[] {
  return Array.isArray(doc.attributes) ? (doc.attributes as AnyRecord[]) : [];
}

function attrValue(doc: AnyRecord, key: string): string | null {
  const attr = documentAttributes(doc).find((a) => a.className === key);
  return (attr?.fileName as string) || (attr?.title as string) || null;
}

function hasAttr(doc: AnyRecord, key: string): boolean {
  return documentAttributes(doc).some((a) => a.className === key);
}

function photoSize(photo: AnyRecord | undefined): number {
  const sizes = (photo?.sizes as AnyRecord[]) || [];
  let max = 0;
  for (const s of sizes) {
    const size = toNumber(s.size);
    if (size > max) max = size;
    // PhotoSizeProgressive 用 sizes 数组
    const progressive = s.sizes as unknown[] | undefined;
    if (Array.isArray(progressive)) {
      const last = toNumber(progressive[progressive.length - 1]);
      if (last > max) max = last;
    }
  }
  return max;
}

/** 从 Telegram 消息中提取可下载的媒体信息；无可下载媒体返回 null */
export function extractMedia(message: unknown): MediaInfo | null {
  const msg = message as AnyRecord;
  const media = msg.media as AnyRecord | undefined;
  if (!media) return null;

  const className = media.className as string;

  if (className === "MessageMediaPhoto") {
    const photo = media.photo as AnyRecord | undefined;
    const size = photoSize(photo || undefined);
    // 注意：photo.id 是超过 2^53 的 BigInteger，转 Number 会精度塌缩，
    // 导致相册里多张不同照片算出同一个文件名。改用 message id —— 频道内唯一且是安全整数。
    const id = toNumber(msg.id);
    return { kind: "photo", fileName: `photo-${id}.jpg`, size, mimeType: "image/jpeg" };
  }

  if (className === "MessageMediaDocument") {
    const doc = media.document as AnyRecord | undefined;
    if (!doc || doc.className === "DocumentEmpty") return null;

    const mimeType = (doc.mimeType as string) || null;
    const size = toNumber(doc.size);
    const original = attrValue(doc, "DocumentAttributeFilename");
    // 同理，document id 也是 BigInteger，用 message id 作兜底命名
    const docId = toNumber(msg.id);

    let kind: MediaInfo["kind"] = "document";
    if (hasAttr(doc, "DocumentAttributeVideo")) {
      kind = hasAttr(doc, "DocumentAttributeAnimated") ? "gif" : "video";
    } else if (hasAttr(doc, "DocumentAttributeAudio")) {
      const audioAttr = documentAttributes(doc).find((a) => a.className === "DocumentAttributeAudio");
      kind = audioAttr?.voice ? "voice" : "audio";
    } else if (mimeType === "image/gif") {
      kind = "gif";
    }

    const fallbackExt = guessExtension(mimeType, kind);
    const fileName = original || `${kind}-${docId}${fallbackExt}`;

    return { kind, fileName, size, mimeType };
  }

  return null;
}

export function guessExtension(mime: string | null, kind: MediaInfo["kind"]): string {
  if (mime) {
    const map: Record<string, string> = {
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "video/quicktime": ".mov",
      "audio/mpeg": ".mp3",
      "audio/ogg": ".ogg",
      "audio/x-wav": ".wav",
      "audio/mp4": ".m4a",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/x-rar-compressed": ".rar",
      "application/epub+zip": ".epub",
    };
    if (map[mime]) return map[mime];
  }
  switch (kind) {
    case "video":
      return ".mp4";
    case "audio":
      return ".mp3";
    case "voice":
      return ".ogg";
    case "gif":
      return ".gif";
    case "photo":
      return ".jpg";
    default:
      return ".bin";
  }
}

/** 取消息的可读文本（正文 + 文件名 + 媒体标题），用于关键词匹配 */
export function messageText(message: unknown): string {
  const msg = message as AnyRecord;
  const parts: string[] = [];
  if (typeof msg.message === "string" && msg.message.trim()) parts.push(msg.message);
  const info = extractMedia(msg);
  if (info) {
    parts.push(info.fileName);
    const media = msg.media as AnyRecord | undefined;
    const doc = media?.document as AnyRecord | undefined;
    if (doc) {
      const title = attrValue(doc, "DocumentAttributeAudio");
      if (title) parts.push(title);
    }
  }
  return parts.join("\n");
}

/** 提取相册（grouped_id）标识 */
export function groupIdOf(message: unknown): string | null {
  const msg = message as AnyRecord;
  const gid = msg.groupedId ?? (msg.media as AnyRecord | undefined)?.groupedId;
  if (!gid) return null;
  const asStr = gid.toString();
  return asStr === "0" ? null : asStr;
}

/**
 * 频道引用 → InputChannel / InputPeerChannel。
 *
 * 评论区的讨论组大多是**私密 megagroup**，没有 username；光有 `-100<id>`
 * 拼不出 InputChannel（gramjs 会报 Could not find the input entity），
 * 必须补上 access_hash。这枚 hash 从 `messages.getDiscussionMessage`
 * 的返回里就能拿到，拿它取消息**不需要加入群组**。
 *
 * 拿不到合法 hash（或 key 是 username）时返回 null，调用方退回 getEntity 老路。
 */
function peerParts(
  key: string,
  accessHash?: string | null,
): { channelId: ReturnType<typeof bigInt>; accessHash: ReturnType<typeof bigInt> } | null {
  const normalized = normalizeEntityKey(key);
  const internal = normalized.startsWith("-100") ? normalized.slice(4) : "";
  const hash = String(accessHash ?? "").trim();
  if (!/^\d+$/.test(internal) || !/^-?\d+$/.test(hash)) return null;
  try {
    return { channelId: bigInt(internal), accessHash: bigInt(hash) };
  } catch {
    return null;
  }
}

/** channels.* 方法用的 InputChannel */
export function inputChannelOf(key: string, accessHash?: string | null): Api.InputChannel | null {
  const parts = peerParts(key, accessHash);
  return parts ? new Api.InputChannel(parts) : null;
}

/** messages.* 方法用的 InputPeerChannel */
export function inputPeerOf(key: string, accessHash?: string | null): Api.InputPeerChannel | null {
  const parts = peerParts(key, accessHash);
  return parts ? new Api.InputPeerChannel(parts) : null;
}

/** RPC 错误文本（去掉堆栈，只留 errorMessage 那一段） */
function errText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return text.slice(0, 160);
}

/** 各种 messages.* / channels.* 返回里把 messages 数组掏出来 */
function messagesOf(payload: unknown): Array<Record<string, unknown>> {
  const list = (payload as { messages?: unknown } | null)?.messages;
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

/**
 * 按消息 ID 取消息。
 *
 * 有 access_hash 时走 `channels.getMessages(InputChannel)`：
 * 这条路不需要 username、也不需要加入群组，是评论区下载的关键。
 * 没有 hash（公开频道有 username）时退回 getEntity + getMessages。
 */
export async function fetchMessagesById(
  key: string,
  accessHash: string | null | undefined,
  ids: number[],
): Promise<Array<Record<string, unknown>>> {
  const client = await getClient();
  const channel = inputChannelOf(key, accessHash);
  if (channel) {
    try {
      const res = await client.invoke(
        new Api.channels.GetMessages({
          channel,
          id: ids.map((id) => new Api.InputMessageID({ id })),
        }),
      );
      return messagesOf(res);
    } catch (err) {
      // hash 会失效（换过账号、被移出、服务器轮换）：能靠 username 解析就再试一次，
      // 别让一条过期 hash 把整个下载卡死。
      const text = errText(err);
      if (!/CHANNEL_INVALID|ACCESS_HASH_INVALID|CHANNEL_PRIVATE/.test(text)) throw err;
      logger.warn({ key, err: text }, "用 access_hash 取消息失败，退回实体解析再试一次");
    }
  }
  const entity = await client.getEntity(normalizeEntityKey(key) as never);
  return (await client.getMessages(entity as never, { ids })) as unknown as Array<Record<string, unknown>>;
}

/** 取一个消息 ID 区间（相册整组用） */
async function fetchRange(
  key: string,
  accessHash: string | null | undefined,
  minId: number,
  maxId: number,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const client = await getClient();
  const peer = inputPeerOf(key, accessHash);
  if (peer) {
    try {
      const res = await client.invoke(
        new Api.messages.GetHistory({
          peer,
          // offset_id 是「游标位置」：给 0 服务器会从**最新一条**开始取，
          // 我们想要的区间就被整个跳过去了（相册只下来一条就是这个原因）。
          // 给它窗口上界，游标正好落在区间顶部，再靠 maxId / minId 收口。
          offsetId: maxId,
          offsetDate: 0,
          addOffset: 0,
          limit,
          maxId,
          minId,
          hash: bigInt(0),
        }),
      );
      return messagesOf(res);
    } catch (err) {
      const text = errText(err);
      if (!/CHANNEL_INVALID|ACCESS_HASH_INVALID|CHANNEL_PRIVATE/.test(text)) throw err;
      logger.warn({ key, err: text }, "用 access_hash 取相册区间失败，退回实体解析再试一次");
    }
  }
  const entity = await client.getEntity(normalizeEntityKey(key) as never);
  return (await client.getMessages(entity as never, { minId, maxId, limit })) as unknown as Array<
    Record<string, unknown>
  >;
}

/**
 * 相册窗口的 ID 列表。
 *
 * 相册（media group）的每一条都是**独立的连续消息**，一条相册最多 10 条，
 * 所以 messageId ± 9 一定能覆盖整组；中间被删掉的 ID 会以 MessageEmpty 返回，
 * 调用方过滤即可。用「点名取一批 ID」而不是区间查询，是因为后者的
 * offset_id / max_id / min_id 语义容易踩空（见 fetchRange 的注释）。
 */
export function albumIdWindow(messageId: number, span = 9): number[] {
  const ids: number[] = [];
  for (let id = messageId - span; id <= messageId + span; id += 1) {
    if (id > 0) ids.push(id);
  }
  return ids;
}

/**
 * 取一条消息及其相册整组（按消息 id 升序）。
 *
 * 相册里点开任意一张，都只带回来那一条；直接下载、封面预览都需要整组，
 * 所以统一用 minId/maxId 取一个窗口再按 grouped_id 过滤。
 *
 * `accessHash` 是评论区（讨论组）场景的关键参数：没有 username 的讨论组
 * 只能靠它取消息，且**不需要加入群组**。
 */
export async function fetchMessageGroup(
  entityKey: string,
  messageId: number,
  accessHash?: string | null,
): Promise<Array<Record<string, unknown>>> {
  const list = await fetchMessagesById(entityKey, accessHash, [messageId]);
  const first = list?.[0];
  if (!first || first.className === "MessageEmpty") throw new Error(`消息不存在或已删除（#${messageId}）`);

  const groupId = groupIdOf(first);
  if (!groupId) return [first];

  const sameGroupOf = (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    rows
      .filter((m) => m && m.className !== "MessageEmpty" && groupIdOf(m) === groupId)
      .sort((a, b) => Number((a as { id: number }).id) - Number((b as { id: number }).id));

  // 1) 点名取窗口：相册条目在同一个 peer 里 ID 连续（最多 10 条），
  //    直接把 messageId ± 9 这些 ID 一起要回来，比区间查询稳得多。
  //    1.3.12 之前只走 messages.getHistory，而 offset_id 给 0 时服务器从
  //    最新一条开始取，窗口被跳过 —— 6 个视频只下来 1 个就是这么来的。
  let sameGroup: Array<Record<string, unknown>> = [];
  try {
    sameGroup = sameGroupOf(await fetchMessagesById(entityKey, accessHash, albumIdWindow(messageId)));
  } catch (err) {
    logger.warn({ entityKey, messageId, err: errText(err) }, "按 ID 取相册窗口失败，改用区间查询");
  }

  // 2) 区间查询兜底（offsetId 已按窗口上界修正）
  if (sameGroup.length <= 1) {
    try {
      const around = await fetchRange(entityKey, accessHash, Math.max(0, messageId - 9), messageId + 10, 20);
      const fromRange = sameGroupOf(around);
      if (fromRange.length > sameGroup.length) sameGroup = fromRange;
    } catch (err) {
      logger.warn({ entityKey, messageId, err: errText(err) }, "区间取相册失败");
    }
  }

  if (sameGroup.length > 1) {
    logger.info(
      { entityKey, messageId, groupedId: groupId, count: sameGroup.length },
      "相册整组已取全",
    );
  } else {
    logger.warn(
      { entityKey, messageId, groupedId: groupId },
      "相册只取到一条（窗口与区间都没命中，可能是相册已删或该条本身就不在相册里）",
    );
  }
  return sameGroup.length ? sameGroup : [first];
}

/** 将 gramjs 下载的临时文件重命名为期望文件名 */
export function targetRelativePath(
  template: string,
  vars: { date: string; channel: string; name: string; messageId: number },
): string {
  const rendered = (template || "{date}/{channel}/{name}")
    .replace(/\{date\}/g, vars.date)
    .replace(/\{channel\}/g, vars.channel)
    .replace(/\{name\}/g, vars.name)
    .replace(/\{id\}/g, String(vars.messageId));
  // 逐段清理，避免路径穿越
  const segments = rendered
    .split(/[\\/]+/)
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => s.replace(/[\u0000-\u001f<>:"|?*]/g, "_"));
  return path.join(...segments);
}
