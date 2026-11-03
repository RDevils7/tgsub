import { db } from "../db";
import { logger } from "../logger";
import { Channel } from "../types";
import { getClient } from "./client";
import { fetchMessageGroup } from "./media";
import { channelEntityKey, channelMessageLink } from "./entity";
import { enqueueGroup } from "./enqueue";
import { downloader } from "./downloader";
import { resolveM3u8Input, isHttpUrl } from "./m3u8";

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

/** m3u8 / 网页视频下载任务落库：source='m3u8'，channel 相关字段留 0（不属于任何 Telegram 频道） */
const stmtInsertM3u8 = db.prepare<[string, string, string, string, string, number]>(
  `INSERT INTO downloads
   (channel_id, channel_title, message_id, file_name, source, source_url, save_dir, save_name, media_kind, emby_json, status, progress, downloaded_bytes, file_size, created_at, net_route)
   VALUES (0, 'm3u8', 0, ?, 'm3u8', ?, ?, ?, 'video', ?, 'queued', 0, 0, 0, ?, 'auto')`,
);

async function enqueueFromTarget(
  target: Target,
  messageId: number,
  link: string,
  includeImages?: boolean,
): Promise<DirectResult> {
  const messages = await fetchMessageGroup(target.entityKey, messageId);
  const result = enqueueGroup(target.channel, messages, {
    fresh: true,
    force: true,
    keyword: null,
    // 手动下载也留一条监控记录，方便回看「这个文件从哪来的」
    writeLog: true,
    includeImages,
  });

  if (result.files === 0) {
    throw new Error("这条消息没有可下载的媒体文件（纯文本）");
  }
  if (result.queued === 0 && result.existing === 0) {
    if (!result.hasVideo) {
      throw new Error("这条消息只有图片，默认不下载图片。请在机器人菜单里开启「图片下载」后再发一次。");
    }
    throw new Error("文件都被大小限制过滤了，可在设置里调整最小 / 最大文件大小");
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
export async function downloadFromLink(link: string, opts?: { includeImages?: boolean }): Promise<DirectResult> {
  const parsed = parseTelegramLink(link);
  if (parsed) {
    const target = await resolveTarget(parsed);
    return enqueueFromTarget(target, parsed.messageId, parsed.raw, opts?.includeImages);
  }
  // 非 Telegram 链接：m3u8 直链或普通网页（自动解析其中的 m3u8 视频）
  if (isHttpUrl(link)) {
    return m3u8ToDirectResult(await enqueueM3u8(link));
  }
  throw new Error("链接格式不对，示例：https://t.me/频道名/123 或 https://t.me/c/1234567890/123；也支持网页 / m3u8 视频链接");
}

/**
 * 转发到机器人的频道消息：从 `fwd_from` 取出原始频道与消息 ID 直接下载。
 * 视频 / 文件照常下载；纯图片是否下载由 `includeImages` 决定（机器人默认不下载）。
 */
export async function downloadFromForward(
  rawChannelId: string,
  messageId: number,
  opts?: { includeImages?: boolean; title?: string | null },
): Promise<DirectResult> {
  const client = await getClient();
  const bare = String(rawChannelId).replace(/^-100/, "").replace(/^-/, "");
  const marked = `-100${bare}`;
  let target: Target;
  const existing = stmtByTgId.get(bare);
  if (existing) {
    target = { channel: existing, entityKey: channelEntityKey(existing), autoAdded: false };
  } else {
    // 转发来源可能不在频道列表里：按 tg_id 解析并自动加入（默认停用，不参与定时扫描）
    const entity = (await client.getEntity(marked)) as unknown as {
      id: unknown;
      title?: string;
      username?: string;
    };
    target = insertChannel(entity, marked);
  }
  const link = channelMessageLink(target.channel, messageId);
  return enqueueFromTarget(target, messageId, link, opts?.includeImages);
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

export interface M3u8Result {
  ok: boolean;
  /** 解析得到的标题 */
  title: string;
  /** 相对下载根目录的存放目录，如 m3u8/视频标题 */
  saveDir: string;
  /** 用户原始输入 */
  link: string;
  /** 已入队文件数 */
  queued: number;
  /** 这条下载记录在 downloads 表的 id */
  id: number;
}

/**
 * 把一个网页 / m3u8 链接解析并落库为一条下载任务（source='m3u8'）。
 * 真正的 ffmpeg 下载在 downloader 的 runM3u8 里进行。
 */
export async function enqueueM3u8(input: string): Promise<M3u8Result> {
  const target = await resolveM3u8Input(input);
  const safeTitle = target.title || "video";
  const saveDir = `m3u8/${safeTitle}`;
  const saveName = `${safeTitle}.mp4`;

  // 把 m3u8 真实地址与防盗链信息塞进 emby_json，runM3u8 运行时再取出来。
  // 同时填好 series/title 等基本字段，finalizeMedia 才能据此生成 NFO + 封面。
  const emby = {
    series: safeTitle,
    season: 1,
    episode: 1,
    firstLine: safeTitle,
    plot: "",
    tags: [],
    studio: "m3u8",
    link: input,
    airedAt: Date.now(),
    messageId: 0,
    kind: "video",
    platform: null,
    cover: null,
    views: null,
    likes: null,
    duration: null,
    categories: [],
    m3u8: { url: target.m3u8Url, referer: target.referer, origin: target.origin },
  };

  const info = stmtInsertM3u8.run(
    saveName,
    input,
    saveDir,
    saveName,
    JSON.stringify(emby),
    Date.now(),
  );
  const id = Number(info.lastInsertRowid);
  // 用自增 id 当 message_id，避开 downloads 唯一索引 (channel_id, message_id, file_name)
  db.prepare("UPDATE downloads SET message_id = ? WHERE id = ?").run(id, id);
  downloader.enqueue([id]);

  logger.info({ id, title: safeTitle, url: target.m3u8Url }, "已入队 m3u8 下载任务");
  return { ok: true, title: safeTitle, saveDir, link: input, queued: 1, id };
}

/** 把 m3u8 入队结果包装成 DirectResult，复用机器人回执渲染（directText） */
function m3u8ToDirectResult(r: M3u8Result): DirectResult {
  return {
    ok: true,
    channelId: 0,
    channelTitle: "m3u8",
    messageId: r.id,
    messageIds: [r.id],
    files: 1,
    queued: r.queued,
    skipped: 0,
    existing: 0,
    title: r.title,
    saveDir: r.saveDir,
    link: r.link,
    autoAdded: false,
  };
}
