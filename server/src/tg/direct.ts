import { db } from "../db";
import { logger } from "../logger";
import { Channel } from "../types";
import { getClient } from "./client";
import { fetchMessageGroup } from "./media";
import { channelEntityKey, channelMessageLink } from "./entity";
import { enqueueGroup } from "./enqueue";
import { downloader } from "./downloader";

/**
 * 直接按 Telegram 消息链接下载（不等关键词命中）。
 * 网页「手动下载」、监控历史的「下载」按钮、机器人收到链接都走这里。
 */

export interface ParsedLink {
  kind: "public" | "private";
  /** 公开频道用户名（小写） */
  username: string | null;
  /** 私有频道 t.me/c/<id> 里的内部 ID */
  internalId: string | null;
  messageId: number;
  raw: string;
}

export interface DirectResult {
  ok: boolean;
  channelId: number;
  channelTitle: string;
  messageId: number;
  messageIds: number[];
  /** 这条消息里的文件数 */
  files: number;
  queued: number;
  skipped: number;
  /** 之前已经下过、这次跳过的文件数 */
  existing: number;
  /** 命名后的文件名（第一个文件），用于回执 */
  title: string | null;
  saveDir: string | null;
  link: string;
  /** 频道是这次自动加入的（默认停用，不参与定时扫描） */
  autoAdded: boolean;
}

const stmtChannelById = db.prepare<[number], Channel>("SELECT * FROM channels WHERE id = ?");
const stmtByUsername = db.prepare<[string], Channel>(
  "SELECT * FROM channels WHERE lower(username) = lower(?) LIMIT 1",
);
const stmtByTgId = db.prepare<[string], Channel>("SELECT * FROM channels WHERE tg_id = ? LIMIT 1");
const stmtInsertChannel = db.prepare(
  "INSERT INTO channels(tg_id, username, title, enabled, created_at) VALUES (?, ?, ?, 0, ?)",
);

/** 支持 t.me/<用户名>/<id>、t.me/c/<内部ID>/<id>，带 ?single 之类的查询串也能认 */
export function parseTelegramLink(input: string): ParsedLink | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const text = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^(?:www\.)?(?:t|telegram)\.me\//i, "")
    .replace(/^@?/, "")
    .trim();

  const priv = /^c\/(\d+)\/(\d+)/i.exec(text);
  if (priv) {
    return { kind: "private", username: null, internalId: priv[1], messageId: Number(priv[2]), raw };
  }
  const pub = /^([A-Za-z0-9_]{3,})\/(\d+)/.exec(text);
  if (pub) {
    return { kind: "public", username: pub[1].toLowerCase(), internalId: null, messageId: Number(pub[2]), raw };
  }
  return null;
}

/** 从一段文字里挑出所有 Telegram 消息链接（机器人收消息时用） */
export function extractTelegramLinks(text: string): string[] {
  const re = /(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:c\/\d+|[A-Za-z0-9_]{3,})\/\d+(?:\?\S*)?/gi;
  const found = String(text ?? "").match(re) ?? [];
  return [...new Set(found.map((s) => s.trim()))];
}

interface Target {
  channel: Channel;
  /** 传给 getEntity 的键：优先用户名，其次 -100 标记形式的频道 ID */
  entityKey: string;
  /** 本次自动新建的频道（会给用户提示） */
  autoAdded: boolean;
}

async function resolveTarget(parsed: ParsedLink): Promise<Target> {
  const client = await getClient();

  if (parsed.kind === "private") {
    const existing = stmtByTgId.get(parsed.internalId ?? "");
    if (existing) {
      return { channel: existing, entityKey: channelEntityKey(existing), autoAdded: false };
    }
    if (!parsed.internalId) throw new Error("链接里没有频道 ID");
    const entity = (await client.getEntity(`-100${parsed.internalId}`)) as unknown as {
      id: unknown;
      title?: string;
      username?: string;
    };
    return insertChannel(entity, `-100${parsed.internalId}`);
  }

  const username = parsed.username ?? "";
  const existing = stmtByUsername.get(username);
  if (existing) {
    return { channel: existing, entityKey: channelEntityKey(existing), autoAdded: false };
  }
  const entity = (await client.getEntity(username)) as unknown as {
    id: unknown;
    title?: string;
    username?: string;
  };
  return insertChannel(entity, username);
}

function insertChannel(
  entity: { id: unknown; title?: string; username?: string },
  fallbackKey: string,
): Target {
  const tgId = String(entity.id);
  const byId = stmtByTgId.get(tgId);
  if (byId) return { channel: byId, entityKey: channelEntityKey(byId), autoAdded: false };

  const title = entity.title || entity.username || `频道 ${tgId}`;
  // 自动加入的频道默认停用：只用于这次下载，不参与定时扫描
  const info = stmtInsertChannel.run(tgId, entity.username ?? null, title, Date.now());
  const channel = stmtChannelById.get(Number(info.lastInsertRowid)) as Channel;
  logger.info({ channel: title, tgId }, "手动下载自动添加频道（默认停用，不参与定时扫描）");
  return { channel, entityKey: channelEntityKey(channel) || fallbackKey, autoAdded: true };
}

async function enqueueFromTarget(target: Target, messageId: number, link: string): Promise<DirectResult> {
  const messages = await fetchMessageGroup(target.entityKey, messageId);
  const result = enqueueGroup(target.channel, messages, {
    fresh: true,
    force: true,
    keyword: null,
    // 手动下载也留一条监控记录，方便回看「这个文件从哪来的」
    writeLog: true,
  });

  if (result.files === 0) {
    throw new Error("这条消息没有可下载的媒体文件（纯文本）");
  }
  if (result.pendingIds.length) downloader.enqueue(result.pendingIds);

  return {
    ok: true,
    channelId: target.channel.id,
    channelTitle: target.channel.title,
    messageId,
    messageIds: messages.map((m) => Number((m as { id: number }).id)),
    files: result.files,
    queued: result.queued,
    skipped: result.skipped,
    existing: result.existing,
    title: result.saveName,
    saveDir: result.saveDir,
    link,
    autoAdded: target.autoAdded,
  };
}

/** 按链接下载单条消息（含相册整组） */
export async function downloadFromLink(link: string): Promise<DirectResult> {
  const parsed = parseTelegramLink(link);
  if (!parsed) {
    throw new Error("链接格式不对，示例：https://t.me/频道名/123 或 https://t.me/c/1234567890/123");
  }
  const target = await resolveTarget(parsed);
  return enqueueFromTarget(target, parsed.messageId, parsed.raw);
}

/** 监控历史里点「下载」用：直接给库里的频道 ID + 消息 ID */
export async function downloadFromChannelMessage(channelId: number, messageId: number): Promise<DirectResult> {
  const channel = stmtChannelById.get(channelId);
  if (!channel) throw new Error("频道不存在");
  const entityKey = channelEntityKey(channel);
  if (!entityKey) throw new Error("该频道没有可用的标识，无法下载");
  const link = channelMessageLink(channel, messageId);
  return enqueueFromTarget({ channel, entityKey, autoAdded: false }, messageId, link);
}
