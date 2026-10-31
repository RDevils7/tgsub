import path from "node:path";
import { toNumber } from "../utils";
import { getClient } from "./client";

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
 * 取一条消息及其相册整组（按消息 id 升序）。
 *
 * 相册里点开任意一张，都只带回来那一条；直接下载、封面预览都需要整组，
 * 所以统一用 minId/maxId 取一个窗口再按 grouped_id 过滤。
 */
export async function fetchMessageGroup(
  entityKey: string,
  messageId: number,
): Promise<Array<Record<string, unknown>>> {
  const client = await getClient();
  const entity = await client.getEntity(entityKey as never);
  const list = (await client.getMessages(entity as never, { ids: [messageId] })) as unknown as Array<
    Record<string, unknown>
  >;
  const first = list?.[0];
  if (!first || first.className === "MessageEmpty") throw new Error(`消息不存在或已删除（#${messageId}）`);

  const groupId = groupIdOf(first);
  if (!groupId) return [first];

  const around = (await client.getMessages(entity as never, {
    minId: Math.max(0, messageId - 9),
    maxId: messageId + 10,
    limit: 20,
  })) as unknown as Array<Record<string, unknown>>;
  const sameGroup = around
    .filter((m) => groupIdOf(m) === groupId)
    .sort((a, b) => Number((a as { id: number }).id) - Number((b as { id: number }).id));
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
