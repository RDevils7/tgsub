import { db, getSettings } from "../db";
import { logger } from "../logger";
import { Channel } from "../types";
import { getClient, hasSession } from "./client";
import { downloader } from "./downloader";
import { groupIdOf } from "./media";
import { channelEntityKey } from "./entity";
import { enqueueGroup } from "./enqueue";
import { notify } from "./notify";

/**
 * 分页拉取之间的抖动间隔。
 *
 * 一次性把 offsetId 一页页翻到底，在 Telegram 看来就是典型的「自动抓取历史消息」，
 * 频道多、积压多时短时间能发出几十个 messages.getHistory。
 * 加上 300~900ms 的随机间隔后，请求节奏接近人翻聊天记录，风控画像明显更平缓。
 */
function pace(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 600));
}

const MAX_BATCHES = 20;

/** 每次扫描至少留痕的最近消息条数：频道安静时监控页也能看到"扫到了什么" */
const RESCAN_RECENT = 20;

const stmtChannels = db.prepare<[], Channel>("SELECT * FROM channels ORDER BY id ASC");
const stmtChannel = db.prepare<[number], Channel>("SELECT * FROM channels WHERE id = ?");
const stmtInsertRun = db.prepare<[number, string, number]>(
  "INSERT INTO scan_runs(channel_id, channel_title, status, started_at) VALUES (?, ?, 'running', ?)",
);
const stmtFinishRun = db.prepare<[number, number, string, string | null, number, number]>(
  "UPDATE scan_runs SET scanned = ?, matched = ?, status = ?, message = ?, finished_at = ? WHERE id = ?",
);
const stmtTouchChannel = db.prepare<[number, number | null, number]>(
  "UPDATE channels SET last_scanned_id = ?, last_scan_at = ?, last_error = NULL WHERE id = ?",
);
const stmtChannelError = db.prepare<[string, number, number]>(
  "UPDATE channels SET last_error = ?, last_scan_at = ? WHERE id = ?",
);
export interface ScanResult {
  channelId: number;
  scanned: number;
  matched: number;
  queued: number;
  skipped: number;
  error?: string;
}

interface GroupedMessages {
  key: string;
  messages: Array<Record<string, unknown>>;
}

function groupMessages(messages: unknown[]): GroupedMessages[] {
  const groups = new Map<string, GroupedMessages>();
  const order: string[] = [];
  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const gid = groupIdOf(msg);
    const key = gid ? `g:${gid}` : `m:${String(msg.id)}`;
    if (!groups.has(key)) {
      groups.set(key, { key, messages: [] });
      order.push(key);
    }
    groups.get(key)!.messages.push(msg);
  }
  return order.map((k) => groups.get(k)!);
}

interface FetchedMessages {
  /** 比游标新的消息：完整处理（匹配 / 入队下载 / 留痕） */
  fresh: unknown[];
  /** 游标以内的最近消息：只留痕，不重复入队。频道安静时也能看到"扫描到了什么" */
  recent: unknown[];
}

async function fetchMessages(
  entity: unknown,
  channel: Channel,
  batchSize: number,
  initialLimit: number,
  rescanRecent: number,
): Promise<FetchedMessages> {
  const client = await getClient();
  const lastId = channel.last_scanned_id;

  if (!lastId) {
    // 首次扫描：只看最近 N 条，避免把整个频道历史拉下来
    const batch = (await client.getMessages(entity as never, { limit: initialLimit })) as unknown[];
    return { fresh: batch, recent: [] };
  }

  /**
   * 从最新一条往回翻，翻过游标为止。
   *
   * 不能用 `{ minId: cursor, limit }`：Telegram 会返回「比 minId 新的最新 N 条」，
   * 积压超过 N 条时中间那段会被永久跳过（实测频道积压 124 条、limit=100，
   * 游标指向的 10500 就再也没被扫到）。这里按 offsetId 一页页往回走，保证不漏。
   */
  const collected: unknown[] = [];
  let offsetId = 0;
  let reachedCursor = false;

  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const batch = (await client.getMessages(entity as never, {
      limit: batchSize,
      offsetId,
    })) as unknown[];
    if (!batch.length) {
      reachedCursor = true;
      break;
    }
    const ids = batch.map((item) => Number((item as { id: number }).id));
    const newer = batch.filter((item) => Number((item as { id: number }).id) > lastId);
    if (newer.length) collected.unshift(...newer);
    const oldestInBatch = Math.min(...ids);
    if (oldestInBatch <= lastId) {
      reachedCursor = true;
      break;
    }
    offsetId = oldestInBatch;
    if (batch.length < batchSize) {
      reachedCursor = true;
      break;
    }
    await pace();
  }
  if (!reachedCursor) {
    logger.warn({ channel: channel.title, lastId }, "积压消息过多，本轮只处理最近部分");
  }

  // 增量消息不足时，把最近若干条老消息也取回来留痕：
  // 否则频道一安静，监控页就永远是空的，看起来像"没在扫描"
  // 注意这里的量词是「消息」：一个相册（比如 1 视频 + 8 图片）算 1 条
  if (rescanRecent <= 0 || groupMessages(collected).length >= rescanRecent) {
    return { fresh: collected, recent: [] };
  }
  const freshIds = new Set(collected.map((item) => Number((item as { id: number }).id)));
  // 多取一些原始条目，分组后由调用方截取最近 N 条消息
  const latest = (await client.getMessages(entity as never, { limit: Math.min(200, rescanRecent * 5) })) as unknown[];
  const recent = latest.filter((item) => {
    const id = Number((item as { id: number }).id);
    return id <= lastId && !freshIds.has(id);
  });

  return { fresh: collected, recent };
}

/** 正在扫描的频道：手动触发与定时任务可能同时到，同一个频道必须串行 */
const scanningChannels = new Set<number>();

export async function scanChannel(
  channelId: number,
  options?: { ignoreDisabled?: boolean },
): Promise<ScanResult> {
  // 并发扫描同一个频道会把日志行和下载队列互相覆盖（唯一索引 IGNORE 掉对方的插入），
  // 表现为「明明命中了却没入队」。这里直接跳过后来者。
  if (scanningChannels.has(channelId)) {
    logger.warn({ channelId }, "该频道正在扫描中，跳过本次触发");
    return { channelId, scanned: 0, matched: 0, queued: 0, skipped: 0, error: "该频道正在扫描中，已跳过" };
  }
  scanningChannels.add(channelId);
  try {
    return await scanChannelOnce(channelId, options);
  } finally {
    scanningChannels.delete(channelId);
  }
}

async function scanChannelOnce(
  channelId: number,
  options?: { ignoreDisabled?: boolean },
): Promise<ScanResult> {
  const channel = stmtChannel.get(channelId);
  if (!channel) throw new Error("频道不存在");
  if (!channel.enabled && !options?.ignoreDisabled) {
    return { channelId, scanned: 0, matched: 0, queued: 0, skipped: 0, error: "频道已停用" };
  }

  const settings = getSettings();
  const client = await getClient();
  const runId = Number(stmtInsertRun.run(channel.id, channel.title, Date.now()).lastInsertRowid);

  let scanned = 0;
  let matched = 0;
  let queued = 0;
  let skipped = 0;

  try {
    const entity = await client.getEntity(channelEntityKey(channel) as never);
    const fetched = await fetchMessages(
      entity,
      channel,
      settings.batch_size || 100,
      settings.initial_scan_messages || 40,
      RESCAN_RECENT,
    );
    const messages = fetched.fresh;
    const byId = (a: unknown, b: unknown): number =>
      Number((a as Record<string, unknown>).id) - Number((b as Record<string, unknown>).id);

    /**
     * 分组即「消息」：一个相册（1 个视频 + 8 张图片）合成一条，
     * 普通消息各自一条。监控记录、扫描条数都以这个单位为准。
     */
    const freshGroups = groupMessages([...messages].sort(byId));
    const freshKeys = new Set(freshGroups.map((group) => group.key));
    const recentGroups =
      fetched.recent.length > 0
        ? groupMessages([...fetched.recent].sort(byId))
            .filter((group) => !freshKeys.has(group.key))
            .slice(-RESCAN_RECENT)
        : [];
    // 统计口径 = 消息条数（相册整组算一条），不是文件条数
    scanned = freshGroups.length + recentGroups.length;

    if (freshGroups.length > 0 || recentGroups.length > 0) {
      const pendingIds: number[] = [];

      /** fresh=true 表示游标之外的新消息（匹配后入队），false 只为留痕回看不入队 */
      const handleGroup = (group: GroupedMessages, fresh: boolean): void => {
        const result = enqueueGroup(channel, group.messages, { fresh, runId });
        if (result.matched) matched += 1;
        queued += result.queued;
        skipped += result.skipped;
        pendingIds.push(...result.pendingIds);
      };

      for (const group of freshGroups) handleGroup(group, true);
      for (const group of recentGroups) handleGroup(group, false);
      if (pendingIds.length) downloader.enqueue(pendingIds);
    }

    const maxId = messages.reduce<number>(
      (acc, m) => Math.max(acc, Number((m as { id: number }).id)),
      channel.last_scanned_id,
    );
    stmtTouchChannel.run(maxId, Date.now(), channel.id);
    stmtFinishRun.run(scanned, matched, "ok", null, Date.now(), runId);

    logger.info({ channel: channel.title, scanned, matched, queued, skipped }, "频道扫描完成");
    return { channelId, scanned, matched, queued, skipped };
  } catch (err) {
    const message = (err as Error)?.message || "扫描失败";
    stmtChannelError.run(message.slice(0, 500), Date.now(), channel.id);
    stmtFinishRun.run(scanned, matched, "error", message.slice(0, 500), Date.now(), runId);
    logger.error({ channel: channel.title, err: message }, "频道扫描失败");
    return { channelId, scanned, matched, queued, skipped, error: message };
  }
}

let scanningAll = false;
let lastScanAt = 0;

export function isScanning(): boolean {
  return scanningAll;
}

export async function scanAll(reason = "scheduled"): Promise<ScanResult[]> {
  if (scanningAll) {
    logger.warn("上一次扫描尚未结束，跳过本轮");
    return [];
  }
  scanningAll = true;
  lastScanAt = Date.now();
  const results: ScanResult[] = [];
  try {
    const channels = stmtChannels.all().filter((c) => c.enabled);
    logger.info({ count: channels.length, reason }, "开始扫描频道");
    for (const channel of channels) {
      results.push(await scanChannel(channel.id));
      // 频道之间留 1.5~3s 随机间隔：固定节奏（比如恒定 1200ms）本身就是机器特征
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
    pruneHistory();
  } finally {
    scanningAll = false;
  }
  // 定时扫描发现新内容时主动推送一条，省得天天开网页看
  if (reason === "scheduled") {
    const queued = results.reduce((sum, r) => sum + r.queued, 0);
    const failed = results.filter((r) => r.error);
    if (queued > 0 || failed.length) {
      const lines = [`📡 <b>自动扫描完成</b>`];
      if (queued > 0) lines.push(`新入队 ${queued} 个文件`);
      for (const r of failed.slice(0, 3)) {
        lines.push(`❌ ${r.error?.slice(0, 120) ?? "扫描失败"}`);
      }
      await notify(lines.join("\n"));
    }
  }
  return results;
}

export function getSchedulerState() {
  const settings = getSettings();
  return {
    scanning: scanningAll,
    lastScanAt: lastScanAt || null,
    intervalMinutes: settings.scan_interval_minutes,
    autoScan: settings.auto_scan,
    nextRunAt: settings.auto_scan
      ? lastScanAt
        ? lastScanAt + Math.max(1, settings.scan_interval_minutes) * 60_000
        : Date.now()
      : null,
  };
}

export function markScanTimestamp(): void {
  lastScanAt = Date.now();
}

function pruneHistory(): void {
  db.prepare(
    "DELETE FROM scan_runs WHERE id NOT IN (SELECT id FROM scan_runs ORDER BY id DESC LIMIT 500)",
  ).run();
  // 监控日志保留最近 20000 条，避免长期运行把库撑大
  db.prepare(
    "DELETE FROM message_logs WHERE id NOT IN (SELECT id FROM message_logs ORDER BY id DESC LIMIT 20000)",
  ).run();
}

export function startScheduler(): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    const settings = getSettings();
    if (!settings.auto_scan) return;
    if (!hasSession()) return;
    const intervalMs = Math.max(1, settings.scan_interval_minutes) * 60_000;
    if (Date.now() - (lastScanAt || 0) < intervalMs) return;
    running = true;
    try {
      await scanAll("scheduled");
    } catch (err) {
      logger.error({ err }, "定时扫描异常");
    } finally {
      running = false;
    }
  }, 20_000);
  timer.unref?.();
  return timer;
}
