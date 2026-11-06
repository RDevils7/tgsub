import { db, getSettings } from "../db";
import { logger } from "../logger";
import { Channel } from "../types";
import { getClient } from "./client";
import { fetchMessageGroup } from "./media";
import { channelEntityKey, channelMessageLink } from "./entity";
import { enqueueGroup } from "./enqueue";
import { downloader } from "./downloader";
import { resolveM3u8Input, isHttpUrl } from "./m3u8";
import { joinRel } from "./mediadir";
import { isCommentLink, parseTelegramLink, type ParsedLink } from "./link";
import { resolveDiscussionGroup } from "./discussion";
import { hashString } from "./discussionplan";

// 机器人与旧代码从 direct 导入这两个纯函数，保持导出位置不变
export { parseTelegramLink, extractTelegramLinks, commentIdOf, isCommentLink } from "./link";
export type { ParsedLink } from "./link";

/**
 * 直接按 Telegram 消息链接下载（不等关键词命中）。
 * 网页「手动下载」、监控历史的「下载」按钮、机器人收到链接都走这里。
 */

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
  "INSERT INTO channels(tg_id, username, access_hash, title, enabled, created_at) VALUES (?, ?, ?, ?, 0, ?)",
);
/** 补存 access_hash：同一频道不同入口拿到的 hash 一般一样，变了就更新成新的 */
const stmtSetAccessHash = db.prepare<[string, number]>("UPDATE channels SET access_hash = ? WHERE id = ?");

interface Target {
  channel: Channel;
  /** 传给 getEntity 的键：优先用户名，其次 -100 标记形式的频道 ID */
  entityKey: string;
  /** 取消息用的 access_hash（讨论组大多没有用户名，靠它才取得到评论） */
  accessHash: string | null;
  /** 本次自动新建的频道（会给用户提示） */
  autoAdded: boolean;
  /** 目标是不是「帖子的讨论组」（评论区链接） */
  discussion?: boolean;
}

async function resolveTarget(parsed: ParsedLink): Promise<Target> {
  const client = await getClient();

  if (parsed.kind === "private") {
    const existing = stmtByTgId.get(parsed.internalId ?? "");
    if (existing) {
      return {
        channel: existing,
        entityKey: channelEntityKey(existing),
        accessHash: existing.access_hash ?? null,
        autoAdded: false,
      };
    }
    if (!parsed.internalId) throw new Error("链接里没有频道 ID");
    const entity = (await client.getEntity(`-100${parsed.internalId}`)) as unknown as {
      id: unknown;
      title?: string;
      username?: string;
      accessHash?: unknown;
    };
    return insertChannel(entity, `-100${parsed.internalId}`);
  }

  const username = parsed.username ?? "";
  const existing = stmtByUsername.get(username);
  if (existing) {
    return {
      channel: existing,
      entityKey: channelEntityKey(existing),
      accessHash: existing.access_hash ?? null,
      autoAdded: false,
    };
  }
  const entity = (await client.getEntity(username)) as unknown as {
    id: unknown;
    title?: string;
    username?: string;
    accessHash?: unknown;
  };
  return insertChannel(entity, username);
}

function insertChannel(
  entity: { id: unknown; title?: string; username?: string; accessHash?: unknown },
  fallbackKey: string,
): Target {
  const tgId = String(entity.id);
  const accessHash = hashString(entity.accessHash);
  const byId = stmtByTgId.get(tgId);
  if (byId) {
    if (accessHash && byId.access_hash !== accessHash) stmtSetAccessHash.run(accessHash, byId.id);
    return {
      channel: { ...byId, access_hash: accessHash ?? byId.access_hash },
      entityKey: channelEntityKey(byId),
      accessHash: accessHash ?? byId.access_hash ?? null,
      autoAdded: false,
    };
  }

  const title = entity.title || entity.username || `频道 ${tgId}`;
  // 自动加入的频道默认停用：只用于这次下载，不参与定时扫描
  const info = stmtInsertChannel.run(tgId, entity.username ?? null, accessHash, title, Date.now());
  const channel = stmtChannelById.get(Number(info.lastInsertRowid)) as Channel;
  logger.info({ channel: title, tgId }, "手动下载自动添加频道（默认停用，不参与定时扫描）");
  return {
    channel,
    entityKey: channelEntityKey(channel) || fallbackKey,
    accessHash: channel.access_hash ?? null,
    autoAdded: true,
  };
}

/**
 * 评论链接（?comment=<id>）要换成「讨论组」这个 peer 再取消息。
 *
 * 评论不在频道里：帖子底下开评论后，Telegram 把它转发进关联的 megagroup，
 * `?comment=55488` 的 55488 是**讨论组内**的消息 ID。这里做三件事：
 *   1. 用 messages.GetDiscussionMessage 找到讨论组（**不需要加入群组**，
 *      官方文档原话就是 without actually joining the group）；
 *   2. 把讨论组的 access_hash 一起存进 channels —— 讨论组通常没有公开用户名，
 *      裸 -100<id> 拼不出 InputChannel，只有 hash 才能按消息 ID 取评论；
 *   3. 返回以讨论组为 entityKey 的 Target —— 入队、命名、链接、以及
 *      downloader 下载阶段重新取消息，都会自动用讨论组，不会出现「入队拿到评论、
 *      下载时又去频道按 55488 取了个空」。
 */
async function resolveCommentTarget(parsed: ParsedLink, postTarget: Target): Promise<Target> {
  const postId = parsed.postId;
  if (!postId) throw new Error("评论链接缺少帖子 ID");

  const client = await getClient();
  // 直接把频道的 entityKey / access_hash 交给定位器：它会按 6 条路依次兜底，
  // 不再依赖单一路径（getDiscussionMessage 偶发返回空，是 1.3.7 里那条
  // 「这个帖子没有开启评论」报错的真实原因）。
  const group = await resolveDiscussionGroup(
    client,
    { entityKey: postTarget.entityKey, accessHash: postTarget.accessHash },
    postId,
  );

  const existing = stmtByTgId.get(group.id);
  if (existing) {
    if (group.accessHash && existing.access_hash !== group.accessHash) {
      stmtSetAccessHash.run(group.accessHash, existing.id);
    }
    return {
      channel: { ...existing, access_hash: group.accessHash ?? existing.access_hash },
      entityKey: group.entityKey,
      accessHash: group.accessHash ?? existing.access_hash ?? null,
      autoAdded: false,
      discussion: true,
    };
  }

  const title = group.title ? `${group.title}（评论区）` : `${postTarget.channel.title} 评论区`;
  let info: { lastInsertRowid: number | bigint; changes: number };
  try {
    info = stmtInsertChannel.run(group.id, group.username, group.accessHash, title, Date.now());
  } catch (err) {
    // 极少见：讨论组的公开用户名和库里某个频道撞了唯一索引，退回去只用数字 ID
    if (!group.username) throw err;
    info = stmtInsertChannel.run(group.id, null, group.accessHash, title, Date.now());
  }
  const channel = stmtChannelById.get(Number(info.lastInsertRowid)) as Channel;
  logger.info(
    { groupId: group.id, title, postId, hasHash: Boolean(group.accessHash) },
    "手动下载登记帖子的关联讨论组（默认停用）",
  );
  return {
    channel,
    entityKey: group.entityKey,
    accessHash: channel.access_hash ?? group.accessHash ?? null,
    autoAdded: true,
    discussion: true,
  };
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
  const messages = await fetchMessageGroup(target.entityKey, messageId, target.accessHash);
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

/** 按链接下载单条消息（含相册整组）；`?comment=` 时下载评论区里指定的那条评论 */
export async function downloadFromLink(link: string, opts?: { includeImages?: boolean }): Promise<DirectResult> {
  const parsed = parseTelegramLink(link);
  if (parsed) {
    const postTarget = await resolveTarget(parsed);
    if (isCommentLink(parsed)) {
      const target = await resolveCommentTarget(parsed, postTarget);
      // 评论是「讨论组里的另一条消息」，跨 peer 取的时候偶发取空（同一条链接重试就好），
      // 所以空结果再试一次，别把一次抖动记成失败。
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await enqueueFromTarget(target, parsed.commentId as number, parsed.raw, opts?.includeImages);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const gone = reason.includes("消息不存在或已删除");
          if (gone && attempt === 1) {
            await new Promise((resolve) => setTimeout(resolve, 900));
            continue;
          }
          if (gone) {
            throw new Error(
              `取不到评论 #${parsed.commentId}（${reason}）：评论可能已被删除；` +
                "若讨论组是私密的（没有公开用户名、需要邀请），只能用已加入该群的账号读取，公开讨论组不需要加入",
            );
          }
          throw err;
        }
      }
      throw new Error(`取不到评论 #${parsed.commentId}：重试两次都没拿到`);
    }
    return enqueueFromTarget(postTarget, parsed.messageId, parsed.raw, opts?.includeImages);
  }
  // 非 Telegram 链接：m3u8 直链或普通网页（自动解析其中的 m3u8 视频）
  if (isHttpUrl(link)) {
    return m3u8ToDirectResult(await enqueueM3u8(link));
  }
  throw new Error(
    "链接格式不对，示例：https://t.me/频道名/123 或 https://t.me/c/1234567890/123；" +
      "评论区链接用 https://t.me/频道名/123?comment=456；也支持网页 / m3u8 视频链接",
  );
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
    target = {
      channel: existing,
      entityKey: channelEntityKey(existing),
      accessHash: existing.access_hash ?? null,
      autoAdded: false,
    };
  } else {
    // 转发来源可能不在频道列表里：按 tg_id 解析并自动加入（默认停用，不参与定时扫描）
    const entity = (await client.getEntity(marked)) as unknown as {
      id: unknown;
      title?: string;
      username?: string;
      accessHash?: unknown;
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
  return enqueueFromTarget(
    { channel, entityKey, accessHash: channel.access_hash ?? null, autoAdded: false },
    messageId,
    link,
  );
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
  // 来源目录可配（默认 m3u8/），标题是它下面的剧集目录
  const saveDir = joinRel(getSettings().dir_m3u8, safeTitle) || safeTitle;
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
    m3u8: {
      url: target.m3u8Url,
      referer: target.referer,
      origin: target.origin,
      // 人机验证（cf_clearance）与登录态都在 Cookie 里，下载时必须原样带上
      cookies: target.cookies ?? null,
    },
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
