import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { logger } from "../logger";
import { Channel } from "../types";
import { getClient } from "./client";
import { extractMedia, fetchMessageGroup } from "./media";
import { channelEntityKey } from "./entity";

/**
 * 监控历史的「封面预览」缓存。
 *
 * 一次下载会用消息里随机挑的 3 张图做 Emby 的 poster / landscape / fanart，
 * 这 3 张原图在拼图结束后就被删掉了。为了能在监控历史里悬停回看，这里把它们
 * 复制一份到 data/covers/<频道ID>-<消息ID>-<序号>.<ext>（不进媒体库，不会被 Emby 扫到）。
 *
 * 还没下载过的消息也要能预览：第一次悬停时按需从 Telegram 取 3 张缩略图，
 * 并把「用的是相册里第几张图」记进 <key>.json。之后真正下载时 enqueue 会读这份记录，
 * 用同样的 3 张图做封面 —— 保证「预览看到的」和「下载时用的」完全一致。
 */

const coverDir = path.join(env.dataDir, "covers");
fs.mkdirSync(coverDir, { recursive: true });

const COVER_RE = /^(-?\d+)-(\d+)-(\d+)\.(jpe?g|png|webp)$/i;

export interface CoverEntry {
  /** 文件名（covers 目录内） */
  file: string;
  /** 第几张（1 起） */
  index: number;
}

export interface CoverMeta {
  /** 相册里被选中的图片序号（从 0 起，按图片顺序）；下载时据此复用同样 3 张 */
  photos: number[];
  files: string[];
  /** download = 下载时留下的实拍封面；telegram = 悬停时从消息里取的缩略图 */
  source: "download" | "telegram";
  at: number;
}

export function coverKey(channelId: number, messageId: number): string {
  return `${channelId}-${messageId}`;
}

function metaPath(key: string): string {
  return path.join(coverDir, `${key}.json`);
}

export function readCoverMeta(channelId: number, messageId: number): CoverMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(coverKey(channelId, messageId)), "utf8");
    const parsed = JSON.parse(raw) as CoverMeta;
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return {
      photos: Array.isArray(parsed.photos) ? parsed.photos.map(Number).filter((n) => Number.isFinite(n)) : [],
      files: parsed.files.filter((f) => typeof f === "string"),
      source: parsed.source === "download" ? "download" : "telegram",
      at: Number(parsed.at) || 0,
    };
  } catch {
    return null;
  }
}

function writeCoverMeta(channelId: number, messageId: number, meta: CoverMeta): void {
  try {
    fs.writeFileSync(metaPath(coverKey(channelId, messageId)), JSON.stringify(meta), "utf8");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "封面缓存索引写入失败");
  }
}

/** 列出某条消息已缓存的封面图，按序号升序 */
export async function listCovers(channelId: number, messageId: number): Promise<CoverEntry[]> {
  const prefix = `${coverKey(channelId, messageId)}-`;
  const names = await fs.promises.readdir(coverDir).catch(() => [] as string[]);
  return names
    .filter((name) => name.startsWith(prefix) && COVER_RE.test(name))
    .map((name) => ({ file: name, index: Number(COVER_RE.exec(name)?.[3] ?? 0) }))
    .filter((entry) => entry.index > 0)
    .sort((a, b) => a.index - b.index);
}

/** 删掉同一序号下不同扩展名的旧图，避免 png/jpg 同时存在时列表重复 */
async function dropSameIndex(channelId: number, messageId: number, index: number): Promise<void> {
  const prefix = `${coverKey(channelId, messageId)}-${index}.`;
  const names = await fs.promises.readdir(coverDir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.startsWith(prefix)) await fs.promises.unlink(path.join(coverDir, name)).catch(() => undefined);
  }
}

/** 下载完成时调用：把封面原图从媒体目录复制到缓存目录 */
export async function saveCoverFromFile(
  channelId: number,
  messageId: number,
  index: number,
  srcPath: string,
): Promise<string | null> {
  if (index <= 0) return null;
  await dropSameIndex(channelId, messageId, index);
  const ext = (path.extname(srcPath) || ".jpg").toLowerCase();
  const file = `${coverKey(channelId, messageId)}-${index}${ext}`;
  try {
    await fs.promises.copyFile(srcPath, path.join(coverDir, file));
    return file;
  } catch (err) {
    logger.warn({ err: (err as Error).message, srcPath }, "封面缓存复制失败");
    return null;
  }
}

async function saveCoverBuffer(
  channelId: number,
  messageId: number,
  index: number,
  buffer: Buffer,
  ext = ".jpg",
): Promise<string | null> {
  await dropSameIndex(channelId, messageId, index);
  const file = `${coverKey(channelId, messageId)}-${index}${ext}`;
  try {
    await fs.promises.writeFile(path.join(coverDir, file), buffer);
    return file;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "封面缓存写入失败");
    return null;
  }
}

const inflight = new Map<string, Promise<CoverEntry[]>>();

/**
 * 串行执行：一次只从 Telegram 取一条消息的封面。
 *
 * 快速划过列表会连着触发好几条；并发下载小图会和正在跑的正片抢连接
 * （gramjs 切 DC 时会把并发的下载打断成 0 字节），串行最稳。
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * 保证某条消息至少有封面可看：命中缓存直接返回，否则从 Telegram 拉前 3 张图。
 * 同一条消息的并发请求会合并成一次（悬停时鼠标抖动不会打出多次请求）。
 */
export async function ensureCovers(channel: Channel, messageId: number): Promise<CoverEntry[]> {
  const cached = await listCovers(channel.id, messageId);
  if (cached.length) return cached;

  // 之前已经确认过「这条消息没有图片」，不必再问一遍 Telegram
  const meta = readCoverMeta(channel.id, messageId);
  if (meta && meta.files.length === 0) return [];

  const key = coverKey(channel.id, messageId);
  const running = inflight.get(key);
  if (running) return running;

  const task = serialize(async (): Promise<CoverEntry[]> => {
    try {
      const entityKey = channelEntityKey(channel);
      if (!entityKey) return [];
      const client = await getClient();
      const messages = await fetchMessageGroup(entityKey, messageId);
      const photos = messages
        .map((msg) => ({ msg, info: extractMedia(msg) }))
        .filter((entry): entry is { msg: Record<string, unknown>; info: NonNullable<ReturnType<typeof extractMedia>> } =>
          entry.info?.kind === "photo",
        );

      if (!photos.length) {
        writeCoverMeta(channel.id, messageId, { photos: [], files: [], source: "telegram", at: Date.now() });
        return [];
      }

      const picked = photos.slice(0, 3).map((entry, ordinal) => ({ ...entry, ordinal }));
      const files: string[] = [];
      const order: number[] = [];
      for (const [position, entry] of picked.entries()) {
        let buffer: Buffer | null = null;
        try {
          // 用 320px 的缩略图：悬停时 3 张合计约 1~2 秒，800px 要 4 秒以上，不值得。
          // gramjs 的类型声明只写了数字/PhotoSize，运行期也接受 "m" 这样的尺寸名。
          const thumb = (await client.downloadMedia(entry.msg as never, {
            thumb: "m",
          } as unknown as Parameters<typeof client.downloadMedia>[1])) as unknown;
          if (Buffer.isBuffer(thumb) && thumb.length > 0) buffer = thumb;
          if (!buffer) {
            const full = (await client.downloadMedia(entry.msg as never, {})) as unknown;
            if (Buffer.isBuffer(full) && full.length > 0) buffer = full;
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message, messageId }, "封面缩略图获取失败");
        }
        if (!buffer) continue;
        const file = await saveCoverBuffer(channel.id, messageId, position + 1, buffer);
        if (!file) continue;
        files.push(file);
        order.push(entry.ordinal);
      }

      writeCoverMeta(channel.id, messageId, {
        photos: order,
        files,
        source: "telegram",
        at: Date.now(),
      });
      logger.info({ messageId, count: files.length }, "已缓存消息封面预览");
      return files.map((file, i) => ({ file, index: i + 1 }));
    } catch (err) {
      logger.warn({ err: (err as Error).message, messageId }, "封面预览获取失败");
      return [];
    } finally {
      inflight.delete(key);
    }
  });

  inflight.set(key, task);
  return task;
}

/** 取消息的完整正文（老记录的 excerpt 只存了 400 字，悬停时补一次并存库） */
export async function fetchCaption(channel: Channel, messageId: number): Promise<string | null> {
  const entityKey = channelEntityKey(channel);
  if (!entityKey) return null;
  const messages = await fetchMessageGroup(entityKey, messageId);
  const text = messages
    .map((msg) => (typeof msg.message === "string" ? msg.message : ""))
    .filter((part) => part.trim())
    .join("\n")
    .trim();
  return text || null;
}

/** 下载时优先复用预览里选中的那几张图，保证「预览 = 封面」 */
export function preferredArtOrdinals(channelId: number, messageId: number): number[] | null {
  const meta = readCoverMeta(channelId, messageId);
  if (!meta || meta.source !== "telegram" || !meta.photos.length) return null;
  return meta.photos;
}

/** 记录「这批封面图是从下载来的」，覆盖掉预览时的临时记录 */
export async function markCoversFromDownload(channelId: number, messageId: number): Promise<void> {
  const covers = await listCovers(channelId, messageId);
  if (!covers.length) return;
  writeCoverMeta(channelId, messageId, {
    photos: [],
    files: covers.map((c) => c.file),
    source: "download",
    at: Date.now(),
  });
}
