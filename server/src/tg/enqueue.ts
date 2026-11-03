import { db, getSettings } from "../db";
import { Channel, Subscription } from "../types";
import { matchText } from "../match";
import { extractMedia, groupIdOf, messageText, type MediaInfo } from "./media";
import { parseCaptionMeta, planFileNames } from "./naming";
import { channelMessageLink } from "./entity";
import { encodeMeta, type EmbyMeta } from "./emby";
import { joinRel } from "./mediadir";

/**
 * 把「一条消息（含整个相册）」落成下载任务 + 监控记录。
 *
 * 定时扫描、手动链接、机器人链接都走这里，保证命名规则、
 * Emby 元信息、大小过滤、封面裁剪完全一致。
 */

export interface GroupEnqueueOptions {
  /** true = 新消息（要判断关键词、统计命中）；false = 只为留痕回看，不入队 */
  fresh: boolean;
  /** 强制下载：跳过关键词匹配（手动链接 / 机器人收到链接时用） */
  force?: boolean;
  /** 记录用的关键词（force 时写 null 表示「手动」） */
  keyword?: string | null;
  subscriptionId?: number | null;
  runId?: number | null;
  /** 是否写监控记录（默认 true） */
  writeLog?: boolean;
  /**
   * 是否把图片也算作可下载文件。
   * - undefined / true：图片照常下载（网页手动下载、定时扫描保持原行为，避免回归）
   * - false：纯图片不下载，只下视频 / 文件（机器人默认，需用户在菜单开启「图片下载」）
   */
  includeImages?: boolean;
}

export interface GroupEnqueueResult {
  /** 这条消息在 downloads/message_logs 里的代表 ID（相册取组内最小） */
  messageId: number;
  matched: boolean;
  files: number;
  queued: number;
  skipped: number;
  /** 之前已经下过、这次没有重复入队的文件数 */
  existing: number;
  /** 这条消息里是否包含视频（动图也算）；用来区分「纯图片消息」与「被大小限制挡掉」 */
  hasVideo: boolean;
  saveDir: string | null;
  saveName: string | null;
  pendingIds: number[];
}

const stmtInsertDownload = db.prepare(`
  INSERT OR IGNORE INTO downloads
    (channel_id, channel_title, message_id, grouped_id, file_name, file_size, mime_type,
     media_kind, status, progress, matched_keyword, subscription_id, created_at, save_dir, save_name, emby_json, net_route)
  VALUES (@channel_id, @channel_title, @message_id, @grouped_id, @file_name, @file_size, @mime_type,
     @media_kind, @status, 0, @matched_keyword, @subscription_id, @created_at, @save_dir, @save_name, @emby_json, @net_route)
`);
const stmtInsertLog = db.prepare(`
  INSERT INTO message_logs
    (channel_id, channel_title, channel_username, message_id, grouped_id, kind,
     matched_keyword, subscription_id, subscription_name, media_kind, file_name,
     file_size, file_count, file_names, excerpt, full_text, run_id, created_at, last_seen_at, seen_count)
  VALUES (@channel_id, @channel_title, @channel_username, @message_id, @grouped_id, @kind,
     @matched_keyword, @subscription_id, @subscription_name, @media_kind, @file_name,
     @file_size, @file_count, @file_names, @excerpt, @full_text, @run_id, @created_at, @last_seen_at, 1)
  ON CONFLICT(channel_id, message_id) DO UPDATE SET
    channel_title     = excluded.channel_title,
    channel_username  = excluded.channel_username,
    grouped_id        = excluded.grouped_id,
    kind              = excluded.kind,
    matched_keyword   = excluded.matched_keyword,
    subscription_id   = excluded.subscription_id,
    subscription_name = excluded.subscription_name,
    media_kind        = excluded.media_kind,
    file_name         = excluded.file_name,
    file_size         = excluded.file_size,
    file_count        = excluded.file_count,
    file_names        = excluded.file_names,
    excerpt           = excluded.excerpt,
    full_text         = COALESCE(excluded.full_text, message_logs.full_text),
    run_id            = excluded.run_id,
    last_seen_at      = excluded.last_seen_at,
    seen_count        = message_logs.seen_count + 1
`);
/** 相册跨扫描批次被游标切开时，沿用已记录那行的 message_id，避免同一条消息出现两行 */
const stmtFindGroupLog = db.prepare<[number, string], { message_id: number }>(
  "SELECT message_id FROM message_logs WHERE channel_id = ? AND grouped_id = ? ORDER BY message_id ASC LIMIT 1",
);
const stmtFindDownload = db.prepare<[number, number, string], { id: number; status: string }>(
  "SELECT id, status FROM downloads WHERE channel_id = ? AND message_id = ? AND file_name = ?",
);
/**
 * 按「目标文件名」查重。
 *
 * 同一集可能从不同链接、不同消息各抓一次（剧集频道常见「第 4 集」被重发），
 * message_id 不同但目标文件名一样。只按 (message_id, file_name) 判重会留下
 * 两行抢同一个文件，所以要按文件名再查一次。
 */
const stmtFindBySaveName = db.prepare<[number, string | null, string], { id: number; status: string }>(
  "SELECT id, status FROM downloads WHERE channel_id = ? AND save_dir IS ? AND save_name = ?",
);
const stmtRequeue = db.prepare(
  "UPDATE downloads SET status = 'queued', progress = 0, downloaded_bytes = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?",
);
/**
 * 兜底命名（一链接一文件夹）重名检测：同一个正文前缀已经被别的消息占用时，
 * 新链接加 `-<消息id>` 后缀，避免两条不同链接挤进同一个文件夹。
 */
const stmtLooseDirOwner = db.prepare<[string, number], { id: number }>(
  "SELECT id FROM downloads WHERE save_dir = ? AND message_id <> ? AND status <> 'skipped' LIMIT 1",
);
const stmtSubs = db.prepare<[], Subscription>("SELECT * FROM subscriptions WHERE enabled = 1");

/** 消息内文件以哪种类型为主（相册常常视频+图片混排，取数量最多的那种） */
function pickMainKind(kinds: string[]): string | null {
  if (!kinds.length) return null;
  const tally = new Map<string, number>();
  for (const kind of kinds) tally.set(kind, (tally.get(kind) ?? 0) + 1);
  let best = kinds[0];
  let bestCount = 0;
  for (const [kind, count] of tally) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/** 把消息文本压成单行摘要，供监控列表展示 */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}

const runGroup = db.transaction(
  (channel: Channel, messages: Array<Record<string, unknown>>, opts: GroupEnqueueOptions): GroupEnqueueResult => {
  const settings = getSettings();
  // Telegram 来源的落盘子目录（默认 telegram/）。剧本目录名由命名规划给出，
  // 这里只负责在它前面套上来源目录 —— 存储路径与「剧名」是两件事，后者要原样写进 NFO。
  const telegramRoot = settings.dir_telegram;
  const diskDir = (rel: string | null | undefined): string | null => joinRel(telegramRoot, rel) || null;
  // 图片默认计入可下载文件（网页手动下载 / 定时扫描保持原行为）；机器人显式传 false 时跳过
  const includeImages = opts.includeImages ?? true;
  const text = messages.map((m) => messageText(m)).join("\n");
    // 正文（caption）单独取一份：messageText 会拼上原始文件名，
    // 拿它当剧情简介会写出一堆 photo-10501.jpg
    const captionText = messages
      .map((m) => (typeof (m as { message?: unknown }).message === "string" ? String((m as { message: string }).message) : ""))
      .filter((part) => part.trim())
      .join("\n");
    const sourceText = captionText || text;
    const excerpt = excerptOf(text);

    const hit = opts.force
      ? {
          keyword: opts.keyword ?? null,
          subscriptionId: opts.subscriptionId ?? null,
          subscriptionName: null as string | null,
        }
      : (() => {
          const m = matchText(text, stmtSubs.all(), channel.id);
          return m
            ? { keyword: m.keyword, subscriptionId: m.subscription.id, subscriptionName: m.subscription.name }
            : null;
        })();

    const media = messages
      .map((msg) => ({ msg, info: extractMedia(msg) }))
      .filter((entry): entry is { msg: Record<string, unknown>; info: MediaInfo } => entry.info !== null);

    const groupedId = groupIdOf(messages[0]);
    const now = Date.now();

    // 一条消息只对应一个监控记录：相册用组内最小 message_id 作代表，
    // 这样 t.me/<channel>/<id> 打开的就是这一组的第一条。
    let messageId = messages.reduce(
      (min, m) => Math.min(min, Number((m as { id: number }).id)),
      Number.MAX_SAFE_INTEGER,
    );
    if (groupedId) {
      const existing = stmtFindGroupLog.get(channel.id, groupedId);
      if (existing) messageId = existing.message_id;
    }

    const totalSize = media.reduce((sum, entry) => sum + (entry.info.size || 0), 0);
    let hasVideo = false;
    // 以正文说明为准命名：剧名文件夹 + 剧名S01E04.mp4（解析不到剧名则回退原名）
    // 开启 Emby 元信息后，剧集类的图片一律不下载 —— 封面由下载完成后从视频随机截帧生成，
    // 消息里的图片往往带集数水印或台词，做封面反而难看，还白占带宽
    const skipAttachments = settings.emby_meta;
    const naming = planFileNames(
      sourceText,
      media.map((entry) => entry.info),
      {
        skipAttachments,
        // 认不出剧名时：一个链接一个文件夹，名字取正文
        looseFolder: settings.fallback_folder,
        uniqueLooseDir: (base) =>
          stmtLooseDirOwner.get(diskDir(base) ?? base, messageId) ? `${base}-${messageId}` : base,
        // 消息条数决定「一个文件含多集」还是「相册一集一条」
        messageCount: messages.length,
      },
    );
    const caption = parseCaptionMeta(sourceText);
    const airedAt = Number((messages[0] as { date?: number }).date ?? 0) * 1000 || now;
    // 私有频道没有 username，链接要走 t.me/c/<内部ID>/<消息ID>，否则打不开
    const channelLink = (messageId: number): string => channelMessageLink(channel, messageId);
    const fileNames = media
      .slice(0, 20)
      .map((entry) => ({ kind: entry.info.kind, name: entry.info.fileName, size: entry.info.size }));

    const result: GroupEnqueueResult = {
      messageId,
      matched: false,
      files: media.length,
      queued: 0,
      skipped: 0,
      existing: 0,
      hasVideo: hasVideo,
      saveDir: diskDir(naming.find((n) => !n.skip)?.dir ?? null),
      saveName: naming.find((n) => !n.skip)?.name ?? null,
      pendingIds: [],
    };

    const hitKeyword = hit?.keyword ?? null;
    const hitSubId = hit?.subscriptionId ?? null;
    const hitSubName = hit?.subscriptionName ?? null;

    const log = (kind: string): void => {
      if (opts.writeLog === false) return;
      stmtInsertLog.run({
        channel_id: channel.id,
        channel_title: channel.title,
        channel_username: channel.username ?? null,
        message_id: messageId,
        grouped_id: groupedId,
        kind,
        matched_keyword: hitKeyword,
        subscription_id: hitSubId,
        subscription_name: hitSubName,
        media_kind: pickMainKind(media.map((entry) => entry.info.kind)),
        file_name: media.length === 1 ? media[0].info.fileName : null,
        file_size: totalSize,
        file_count: media.length,
        file_names: fileNames.length ? JSON.stringify(fileNames) : null,
        excerpt,
        // 悬停预览要显示完整介绍：excerpt 只留 400 字，全文单独存一份
        full_text: text ? text.slice(0, 8000) : null,
        run_id: opts.runId ?? null,
        created_at: now,
        last_seen_at: now,
      });
    };

    if (!hit) {
      log(media.length > 0 || excerpt ? "miss" : "empty");
      return result;
    }

    if (opts.fresh) result.matched = true;

    if (media.length === 0) {
      // 命中关键词但是纯文本消息：算命中，只是没有可下载文件
      log("hit");
      return result;
    }

    let skippedFiles = 0;
    for (const [index, entry] of media.entries()) {
      const { msg, info } = entry;
      const named = naming[index];
      // 图片只留 N 张当封面，其余整条跳过（不建下载记录）
      if (named?.skip) continue;

      // 纯图片：机器人「图片下载」未开启时整条跳过（视频 / 文件照常下）
      const isPhoto = info.kind === "photo";
      if (isPhoto && !includeImages) {
        skippedFiles += 1;
        continue;
      }

      const isVideo = info.kind === "video" || info.kind === "gif";
      if (isVideo) hasVideo = true;

      // 视频是正文的主体内容，必须下载：不受文件大小过滤影响，
      // 否则用户为了挡掉杂图设了 30MB 上限，整集正片会被一起跳过
      let status: "queued" | "skipped" = "queued";
      if (!isVideo) {
        if (settings.min_file_size > 0 && info.size > 0 && info.size < settings.min_file_size) status = "skipped";
        if (settings.max_file_size > 0 && info.size > settings.max_file_size) status = "skipped";
      }
      if (status === "skipped") skippedFiles += 1;
      // 回看模式：只更新监控记录，不重新入队
      if (!opts.fresh) continue;

      let embyJson: string | null = null;
      if (settings.emby_meta && named?.dir) {
        const meta: EmbyMeta = {
          series: named.dir,
          season: named.season ?? 1,
          episode: named.episode ?? null,
          firstLine: caption.firstLine,
          plot: caption.plot,
          tags: caption.tags,
          studio: channel.title,
          link: channelLink(Number(msg.id)),
          airedAt,
          messageId: Number(msg.id),
          kind: isVideo ? "video" : "art",
        };
        embyJson = encodeMeta(meta);
      }

      // 同名目标文件已经在队列里/已下过：不再新建一行，避免两个任务抢同一个路径
      const sameName = named?.name
        ? stmtFindBySaveName.get(channel.id, diskDir(named.dir), named.name)
        : undefined;
      if (sameName) {
        if (opts.force && (sameName.status === "failed" || sameName.status === "skipped")) {
          stmtRequeue.run(sameName.id);
          result.pendingIds.push(sameName.id);
          result.queued += 1;
        } else {
          result.existing += 1;
        }
        continue;
      }

      const inserted = stmtInsertDownload.run({
        channel_id: channel.id,
        channel_title: channel.title,
        message_id: Number(msg.id),
        grouped_id: groupIdOf(msg),
        file_name: info.fileName,
        file_size: info.size,
        mime_type: info.mimeType,
        media_kind: info.kind,
        status,
        matched_keyword: hitKeyword,
        subscription_id: hitSubId,
        created_at: now,
        save_dir: diskDir(named?.dir ?? null),
        save_name: named?.name ?? null,
        emby_json: embyJson,
        // Telegram 的连接由 proxy_url 决定：填了代理就走代理，没填就直连
        net_route: String(getSettings().proxy_url ?? "").trim() ? "proxy" : "direct",
      });

      if (inserted.changes > 0) {
        if (status === "queued") {
          result.pendingIds.push(Number(inserted.lastInsertRowid));
          result.queued += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      // 已经有同名记录：手动/机器人触发时把失败或跳过的重新排队，扫描时保持原样
      const previous = stmtFindDownload.get(channel.id, Number(msg.id), info.fileName);
      if (opts.force && previous && (previous.status === "failed" || previous.status === "skipped")) {
        stmtRequeue.run(previous.id);
        result.pendingIds.push(previous.id);
        result.queued += 1;
      } else {
        result.existing += 1;
      }
    }

    // 整条消息的状态：文件全被大小限制挡掉才算「已过滤」，否则算命中
    log(skippedFiles > 0 && skippedFiles === media.length ? "filtered" : "hit");
    return result;
  },
);

export function enqueueGroup(
  channel: Channel,
  messages: Array<Record<string, unknown>>,
  opts: GroupEnqueueOptions,
): GroupEnqueueResult {
  return runGroup(channel, messages, opts);
}
