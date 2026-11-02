import fs from "node:fs";
import path from "node:path";
import { db, getSettings } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { Download } from "../types";
import { formatDateFolder, sanitizeSegment, toNumber } from "../utils";
import { getClient } from "./client";
import { extractMedia, targetRelativePath } from "./media";
import { channelEntityKey } from "./entity";
import { decodeMeta, describeMeta, finalizeMedia } from "./emby";
import { queueEmbyUpdate } from "./embyapi";
import { requestCacheTrim } from "../cache";

const MAX_AUTO_RETRY = 1;

/** 日志里给人看的大小，省得在列表里自己换算字节 */
function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 下载目录内的相对路径（统一用 / 分隔，日志里跨平台都好读） */
function relPathOf(file: string): string {
  return path.relative(env.downloadDir, file).split(path.sep).join("/");
}

/** 一条任务在日志里的可读标识：优先「剧名 S01E04」，否则退回到文件名 */
function describeRow(row: Download): string {
  const meta = decodeMeta(row.emby_json);
  if (meta) return describeMeta(meta);
  if (row.save_name) return row.save_dir ? `${row.save_dir}/${row.save_name}` : row.save_name;
  return row.file_name;
}

const stmtGet = db.prepare<[number], Download>("SELECT * FROM downloads WHERE id = ?");
const stmtQueued = db.prepare<[], { id: number }>(
  "SELECT id FROM downloads WHERE status = 'queued' ORDER BY id ASC LIMIT 2000",
);
const stmtSetStatus = db.prepare<[number, number]>(
  "UPDATE downloads SET status = 'downloading', progress = 1, downloaded_bytes = 0, started_at = ? WHERE id = ?",
);
const stmtProgress = db.prepare<[number, number, number]>(
  "UPDATE downloads SET progress = ?, downloaded_bytes = ? WHERE id = ?",
);
const stmtFail = db.prepare<[string, number, number]>(
  "UPDATE downloads SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
);
const stmtDone = db.prepare<[number, string, number, number, number]>(
  "UPDATE downloads SET status = 'done', progress = 100, downloaded_bytes = ?, file_path = ?, file_size = ?, finished_at = ? WHERE id = ?",
);
const stmtResetStuck = db.prepare(
  "UPDATE downloads SET status = 'queued', progress = 0 WHERE status = 'downloading'",
);
const stmtChannel = db.prepare<[number], { username: string | null; tg_id: string | null; title: string }>(
  "SELECT username, tg_id, title FROM channels WHERE id = ?",
);

/** 运行中的实时进度（只在内存里）：速度靠采样相邻两次回调算，落库只是兜底 */
export interface LiveProgress {
  startedAt: number;
  downloaded: number;
  total: number;
  /** 字节/秒，指数平滑，避免数字乱跳 */
  speed: number;
  lastAt: number;
  lastBytes: number;
}

/** 手动中断的三种原因：暂停 / 停止 / 让位给插队的任务 */
type CancelMode = "pause" | "stop" | "preempt";

const CANCEL_TEXT: Record<CancelMode, string> = {
  pause: "已暂停",
  stop: "已手动停止",
  preempt: "已让出队列",
};

/**
 * 用它从 progressCallback 里抛出以中断 gramjs 的下载循环：
 * downloadFileV2 每写完一个数据块都会 await 回调，抛出后循环跳出、
 * 写流在 finally 里关闭，下载 Promise 直接 reject。
 */
class CancelError extends Error {
  mode: CancelMode;

  constructor(mode: CancelMode) {
    super(CANCEL_TEXT[mode]);
    this.name = "CancelError";
    this.mode = mode;
  }
}

class DownloadQueue {
  private queue: number[] = [];
  private active = new Set<number>();
  private attempts = new Map<number, number>();
  private lastProgressAt = new Map<number, number>();
  private live = new Map<number, LiveProgress>();
  /** 被用户点了暂停/停止/让位的任务：下一块数据回来时中断 */
  private cancelIntent = new Map<number, CancelMode>();
  /** 手动插队的任务，启动时跳过「先封面后正片」的分阶段限制 */
  private priority = new Set<number>();
  /** 插队后需要「让位」的任务重新排队时要插到它后面 */
  private jumpTarget: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** 接口读取实时速率用；没有在跑的任务返回 null */
  snapshot(id: number): LiveProgress | null {
    return this.live.get(id) ?? null;
  }

  /** 当前所有任务的合计速度（字节/秒） */
  totalSpeed(): number {
    let sum = 0;
    for (const item of this.live.values()) sum += item.speed;
    return sum;
  }

  start(): void {
    const res = stmtResetStuck.run();
    if (res.changes > 0) logger.warn({ count: res.changes }, "重置上次异常中断的下载任务");
    const cleaned = removeEmptyFiles(env.downloadDir);
    if (cleaned > 0) logger.warn({ count: cleaned }, "清理上次中断留下的 0 字节残留文件");
    this.queue = stmtQueued.all().map((r) => r.id);
    if (this.queue.length) logger.info({ count: this.queue.length }, "载入待下载任务");
    this.timer = setInterval(() => this.pump(), 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  enqueue(ids: number[]): void {
    for (const id of ids) if (!this.queue.includes(id)) this.queue.push(id);
    this.pump();
  }

  retry(id: number): boolean {
    const row = stmtGet.get(id);
    if (!row) return false;
    this.attempts.delete(id);
    db.prepare(
      "UPDATE downloads SET status = 'queued', progress = 0, downloaded_bytes = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?",
    ).run(id);
    if (!this.queue.includes(id)) this.queue.push(id);
    this.pump();
    return true;
  }

  /** 暂停：下载中的任务在下一块数据回来时中断；排队的直接移出队列 */
  pause(id: number): boolean {
    const row = stmtGet.get(id);
    if (!row) return false;
    if (row.status === "downloading") {
      this.cancelIntent.set(id, "pause");
      return true;
    }
    if (row.status !== "queued") return false;
    this.queue = this.queue.filter((x) => x !== id);
    const { pct, bytes } = this.snapshotOf(row, id);
    db.prepare(
      "UPDATE downloads SET status = 'paused', progress = ?, downloaded_bytes = ?, started_at = NULL, error = NULL WHERE id = ?",
    ).run(pct, bytes, id);
    logger.info({ id, file: describeRow(row) }, `任务已暂停：${describeRow(row)}`);
    return true;
  }

  /** 停止：下载中的立刻中断并标记为已停止，排队/暂停的直接结束（stop() 是关闭进程用的，别混） */
  stopTask(id: number): boolean {
    const row = stmtGet.get(id);
    if (!row) return false;
    if (row.status === "downloading") {
      this.cancelIntent.set(id, "stop");
      return true;
    }
    if (row.status !== "queued" && row.status !== "paused") return false;
    this.queue = this.queue.filter((x) => x !== id);
    const { pct, bytes } = this.snapshotOf(row, id);
    db.prepare(
      "UPDATE downloads SET status = 'stopped', progress = ?, downloaded_bytes = ?, finished_at = ?, error = ? WHERE id = ?",
    ).run(pct, bytes, Date.now(), CANCEL_TEXT.stop, id);
    logger.info({ id, file: describeRow(row) }, `任务已停止：${describeRow(row)}`);
    return true;
  }

  /** 继续：暂停/停止的任务重新排到队首（gramjs 不支持断点续传，会从头下一遍） */
  resume(id: number): boolean {
    const row = stmtGet.get(id);
    if (!row) return false;
    if (row.status !== "paused" && row.status !== "stopped") return false;
    this.attempts.delete(id);
    db.prepare(
      "UPDATE downloads SET status = 'queued', progress = 0, downloaded_bytes = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?",
    ).run(id);
    // 排到队首：当前任务下完就轮到它，不用排到最后面去等
    this.queue = [id, ...this.queue.filter((x) => x !== id)];
    logger.info({ id, file: describeRow(row) }, `任务继续下载：${describeRow(row)}`);
    this.pump();
    return true;
  }

  /**
   * 插队：直接挪到队首。如果此刻别的任务正在跑，让它让位
   * （中断后重新排到插队任务后面），否则要等它整集下完才轮得到。
   */
  jump(id: number): boolean {
    const row = stmtGet.get(id);
    if (!row) return false;
    if (row.status === "downloading") return true; // 已经在跑，本身就是队首
    if (row.status !== "queued" && row.status !== "paused" && row.status !== "stopped") return false;

    if (row.status !== "queued") {
      db.prepare(
        "UPDATE downloads SET status = 'queued', progress = 0, downloaded_bytes = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?",
      ).run(id);
    }
    this.attempts.delete(id);
    this.queue = [id, ...this.queue.filter((x) => x !== id)];
    this.priority.add(id);
    this.jumpTarget = id;
    for (const other of this.active) {
      if (other !== id) this.cancelIntent.set(other, "preempt");
    }
    logger.info({ id, file: describeRow(row) }, `任务插队到队首：${describeRow(row)}`);
    this.pump();
    return true;
  }

  /** 取一条任务当前的真实进度（优先用内存里的实时值） */
  private snapshotOf(row: Download, id: number): { pct: number; bytes: number } {
    const live = this.live.get(id);
    const bytes = live?.downloaded ?? row.downloaded_bytes ?? 0;
    const total = row.file_size > 0 ? row.file_size : live?.total ?? 0;
    const pct = total > 0 ? Math.min(99, Math.round((bytes / total) * 100)) : 0;
    return { pct, bytes };
  }

  /** 中断前检查用户意图：命中就抛出，由 run() 的 catch 统一收尾 */
  private checkCancel(id: number): void {
    const intent = this.cancelIntent.get(id);
    if (intent) throw new CancelError(intent);
  }

  /** 清掉已经被删除/已不在排队状态的任务，避免队列里留幽灵条目 */
  private prune(): void {
    this.queue = this.queue.filter((id) => {
      const row = stmtGet.get(id) as Download | undefined;
      return Boolean(row && row.status === "queued");
    });
  }

  stats(): { active: number; waiting: number } {
    this.prune();
    return { active: this.active.size, waiting: this.queue.length };
  }

  /** art = 封面用的临时图，video = 正片，其余归 other */
  private kindOf(id: number): "art" | "video" | "other" {
    const row = stmtGet.get(id);
    if (!row) return "other";
    if ((row.save_name ?? "").startsWith(".art-")) return "art";
    return row.media_kind === "video" || row.media_kind === "gif" ? "video" : "other";
  }

  private pump(): void {
    if (this.stopped) return;
    const { concurrency } = getSettings();
    /**
     * 实际并发固定为 1。
     *
     * 这个频道的媒体在别的 DC，gramjs 每次下载都会「导出授权 + 切 DC」，
     * 只要同一个连接上还有别的下载在跑，那些下载就会被打断成 0 字节
     * （实测并发 3 时相册 3 张封面必挂 1~2 张）。代理带宽本来就是瓶颈，
     * 串行的总耗时几乎一样，但不会留下坏文件。
     */
    const limit = Math.max(1, Math.min(1, concurrency || 1));
    while (this.active.size < limit && this.queue.length > 0) {
      /**
       * 视频和封面图不要同时下：正片常常落在别的 DC，gramjs 会导出授权并切 DC，
       * 这段时间里并发的小图会被打断成 0 字节（实测 2/3 张封面直接失败）。
       * 所以按「先小图、后正片」分阶段跑，两个阶段不重叠。
       */
      const activeKinds = [...this.active].map((id) => this.kindOf(id));
      const hasArtWaiting = () => this.queue.some((id) => !this.active.has(id) && this.kindOf(id) === "art");
      /**
       * 三个阶段互不重叠：
       * 1) 空闲时先把封面图下载完（串行，一次一张）
       * 2) 封面图期间不启动正片
       * 3) 正片下载期间不再插封面图
       * 手动插队的任务跳过这套分阶段限制，插了就先下。
       */
      const phase: "art" | "video" | "idle" = activeKinds.includes("art")
        ? "art"
        : activeKinds.includes("video")
          ? "video"
          : "idle";
      const accept = (id: number): boolean => {
        if (this.priority.has(id)) return true;
        const kind = this.kindOf(id);
        if (phase === "art") return false;
        if (phase === "video") return kind !== "art";
        return (kind === "art") === hasArtWaiting();
      };
      const index = this.queue.findIndex((id) => !this.active.has(id) && accept(id));
      if (index < 0) break;
      const id = this.queue.splice(index, 1)[0];
      this.priority.delete(id);
      this.active.add(id);
      void this.run(id).finally(() => {
        this.active.delete(id);
        this.live.delete(id);
        this.cancelIntent.delete(id);
        this.pump();
      });
    }
  }

  /**
   * 手动中断后的落库处理：
   * - pause   → 停在 paused，保留已下载字节用于展示
   * - stop    → 记为 stopped，附带「已手动停止」原因
   * - preempt → 回到队列，排在插队任务后面，等插队任务下完自动接着下
   */
  private async applyCancel(
    id: number,
    mode: CancelMode,
    row: Download,
    targetPath: string | null,
  ): Promise<void> {
    this.cancelIntent.delete(id);
    if (targetPath) await fs.promises.unlink(targetPath).catch(() => undefined);

    const { pct, bytes } = this.snapshotOf(row, id);
    if (mode === "pause") {
      db.prepare(
        "UPDATE downloads SET status = 'paused', progress = ?, downloaded_bytes = ?, started_at = NULL, error = NULL WHERE id = ?",
      ).run(pct, bytes, id);
      logger.info({ id, file: describeRow(row), pct }, `下载已暂停：${describeRow(row)}（${pct}%）`);
      return;
    }
    if (mode === "stop") {
      db.prepare(
        "UPDATE downloads SET status = 'stopped', progress = ?, downloaded_bytes = ?, finished_at = ?, error = ? WHERE id = ?",
      ).run(pct, bytes, Date.now(), CANCEL_TEXT.stop, id);
      logger.info({ id, file: describeRow(row), pct }, `下载已停止：${describeRow(row)}（${pct}%）`);
      return;
    }

    db.prepare(
      "UPDATE downloads SET status = 'queued', progress = 0, downloaded_bytes = 0, started_at = NULL WHERE id = ?",
    ).run(id);
    if (!this.queue.includes(id)) {
      const at = this.jumpTarget !== null && this.queue[0] === this.jumpTarget ? 1 : 0;
      this.queue.splice(at, 0, id);
    }
    this.jumpTarget = null;
    logger.info({ id, file: describeRow(row), pct }, `任务让位给插队任务，稍后继续：${describeRow(row)}`);
  }

  private async run(id: number): Promise<void> {
    const row = stmtGet.get(id);
    if (!row || row.status !== "queued") return;

    const startedAt = Date.now();
    stmtSetStatus.run(startedAt, id);
    this.live.set(id, {
      startedAt,
      downloaded: 0,
      total: row.file_size,
      speed: 0,
      lastAt: startedAt,
      lastBytes: 0,
    });
    let targetPath: string | null = null;
    // 日志统一带上「哪条消息、哪一集、哪个文件」，排障时不用再翻库对号
    const meta = decodeMeta(row.emby_json);
    const logContext = {
      id,
      messageId: row.message_id,
      channel: row.channel_title ?? null,
      series: meta?.series ?? null,
      season: meta?.season ?? null,
      episode: meta?.episode ?? null,
    };

    try {
      const settings = getSettings();
      const channel = stmtChannel.get(row.channel_id);
      if (!channel) throw new Error("频道已被删除");

      const client = await getClient();
      // 私有频道没有 username，必须用 -100 标记形式的 ID：裸号会被当成用户 ID
      const entity = await client.getEntity(channelEntityKey(channel) as never);
      this.checkCancel(id);
      const messages = (await client.getMessages(entity, { ids: [row.message_id] })) as unknown[];
      const message = messages?.[0];
      if (!message || !(message as { media?: unknown }).media) throw new Error("消息不存在或媒体已失效");
      // 准备阶段（连 DC、取消息）也可能被打断，早点退回队列，别白等
      this.checkCancel(id);

      const info = extractMedia(message);
      const fileName = info?.fileName || row.file_name;
      const isPhoto = (info?.kind ?? row.media_kind) === "photo";
      // 1.0.2 之前用来拼封面的临时图任务（.art-*）：它们不是媒体，别通知 Emby
      const isArtTask = (row.save_name ?? "").startsWith(".art-");

      // 剧集类内容按消息正文命名：<剧名>/<剧名>S01E04.mp4，
      // 同一剧名的后续集数会自然落进同一个文件夹；其余文件仍走 file_template。
      let rel: string;
      if (row.save_name) {
        const dir = row.save_dir ? sanitizeSegment(row.save_dir, 80) : "";
        const name = path.basename(row.save_name);
        rel = dir ? path.join(dir, name) : name;
      } else {
        rel = targetRelativePath(settings.file_template, {
          date: formatDateFolder(row.created_at),
          channel: sanitizeSegment(channel.title, 60),
          name: sanitizeSegment(fileName, 150),
          messageId: row.message_id,
        });
      }

      const candidate = path.join(env.downloadDir, rel);
      const label = meta ? describeMeta(meta) : path.basename(candidate);
      let resumeInPlace = false;
      // 同一集重跑时目标文件已经在位（大小一致）：直接算完成，不重复下一遍
      if (row.file_size > 0 && fs.existsSync(candidate)) {
        const existing = await fs.promises.stat(candidate).catch(() => null);
        if (existing && existing.size === row.file_size) {
          stmtDone.run(existing.size, candidate, existing.size, Date.now(), id);
          logger.info(
            { ...logContext, file: relPathOf(candidate), size: existing.size },
            `跳过重复下载：${label} → ${relPathOf(candidate)}（本地已有 ${humanSize(existing.size)}）`,
          );
          // 文件在但元信息可能缺（老版本下载的），顺手补齐
          await finalizeMedia(candidate, row.emby_json);
          // 顺手让 Emby 认一下这个文件：老版本下载时没通知过入库
          if (!isArtTask) queueEmbyUpdate(candidate, "Created");
          return;
        }
        // 上次中断留下的半截文件：就地覆盖，否则会生成「美人局S01E04 (2).mp4」
        resumeInPlace = true;
      }
      // 封面用的临时图（.art-N.jpg）每集都复用同一个名字，重下时直接覆盖，
      // 否则会变成「.art-1 (2).jpg」这种组装时认不出来的名字
      if (isArtTask) {
        await fs.promises.unlink(candidate).catch(() => undefined);
        resumeInPlace = false;
      }
      targetPath = resumeInPlace ? candidate : uniquePath(candidate);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

      let lastWrite = 0;
      await client.downloadMedia(message as never, {
        outputFile: targetPath,
        progressCallback: (downloaded: unknown, total: unknown) => {
          const now = Date.now();
          const d = toNumber(downloaded);
          const t = toNumber(total) || info?.size || row.file_size || 0;

          // 每块数据回来时检查一次：暂停/停止/插队都靠这里中断下载循环
          this.checkCancel(id);

          // 采样算速度：每 250ms 取一次增量做指数平滑，界面上的 MB/s 才不会抖
          const live = this.live.get(id);
          if (live) {
            live.downloaded = d;
            if (t > 0) live.total = t;
            const dt = now - live.lastAt;
            if (dt >= 250) {
              const delta = d - live.lastBytes;
              if (delta >= 0) {
                const instant = (delta * 1000) / dt;
                live.speed = live.speed > 0 ? live.speed * 0.6 + instant * 0.4 : instant;
              }
              live.lastAt = now;
              live.lastBytes = d;
            }
          }

          if (now - lastWrite < 700) return;
          lastWrite = now;
          const pct = t > 0 ? Math.min(99, Math.round((d / t) * 100)) : 0;
          const prev = this.lastProgressAt.get(id) ?? -1;
          if (pct !== prev) {
            this.lastProgressAt.set(id, pct);
            stmtProgress.run(pct, d, id);
          }
        },
      });

      let stat = await fs.promises.stat(targetPath);
      // 少量图片会以「写流已打开但没落字节」的方式返回（相册里第 2、3 张常见），
      // 这时改用 Buffer 模式重新取一遍再写盘，实测能正常拿到数据
      if (stat.size === 0 && isPhoto) {
        const buffer = (await client.downloadMedia(message as never, {})) as unknown;
        if (Buffer.isBuffer(buffer) && buffer.length > 0) {
          await fs.promises.writeFile(targetPath, buffer);
          stat = await fs.promises.stat(targetPath);
          logger.info(
            { ...logContext, file: relPathOf(targetPath), size: stat.size },
            `图片改走内存下载完成：${relPathOf(targetPath)}（${humanSize(stat.size)}）`,
          );
        }
      }
      // 校验落地文件：0 字节说明写入被中断，不能标记成功，否则会静默留下坏文件
      if (stat.size === 0) throw new Error("下载完成但文件为空（0 字节），已丢弃");
      stmtDone.run(stat.size, targetPath, stat.size, Date.now(), id);
      this.attempts.delete(id);
      logger.info(
        { ...logContext, file: relPathOf(targetPath), size: stat.size },
        `下载完成：${label} → ${relPathOf(targetPath)}（${humanSize(stat.size)}）`,
      );
      // 生成 Emby 的 .nfo / 本集缩略图 / 剧集封面（失败不影响下载结果）
      await finalizeMedia(targetPath, row.emby_json);
      // 最后通知 Emby 入库：放在元信息写完之后，Emby 扫到文件时海报简介已经就位。
      // 攒 2.5 秒批量提交，连着下完几集也只会触发一次增量扫描。
      if (!isArtTask && !isPhoto) queueEmbyUpdate(targetPath, "Created");
      // 这集刚写了自己的缩略图与剧集封面，顺手看一眼缓存总量有没有超上限
      requestCacheTrim();
    } catch (err) {
      // 用户手动中断：不是失败，别计入重试次数，也不要触发自动重试
      if (err instanceof CancelError) {
        await this.applyCancel(id, err.mode, row, targetPath);
        return;
      }
      const message = (err as Error)?.message || "下载失败";
      const tried = this.attempts.get(id) ?? 0;
      const where = targetPath ? relPathOf(targetPath) : row.file_name;
      if (targetPath) await fs.promises.unlink(targetPath).catch(() => undefined);

      if (tried < MAX_AUTO_RETRY) {
        this.attempts.set(id, tried + 1);
        logger.warn(
          { ...logContext, file: where, err: message, attempt: tried + 1 },
          `下载失败，稍后重试：${meta ? describeMeta(meta) : row.file_name}（${message}）`,
        );
        db.prepare(
          "UPDATE downloads SET status = 'queued', progress = 0, downloaded_bytes = 0, started_at = NULL WHERE id = ?",
        ).run(id);
        setTimeout(() => {
          if (!this.queue.includes(id)) this.queue.push(id);
          this.pump();
        }, 3000 * (tried + 1));
        return;
      }

      stmtFail.run(message.slice(0, 500), Date.now(), id);
      logger.error(
        { ...logContext, file: where, err: message },
        `下载失败：${meta ? describeMeta(meta) : row.file_name}（${message}）`,
      );
      // 老版本的封面图任务彻底失败时也触发一次收尾，别让同目录的活文件白等
      if (row.save_dir && (row.save_name ?? "").startsWith(".art-")) {
        const fallback = path.join(env.downloadDir, row.save_dir, row.save_name ?? "x");
        await finalizeMedia(fallback, row.emby_json);
      }
    }
  }
}

/** 递归清理下载目录下的 0 字节文件（进程被杀时 downloadMedia 会留下空文件） */
function removeEmptyFiles(dir: string): number {
  let removed = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile()) {
        try {
          if (fs.statSync(p).size === 0) {
            fs.unlinkSync(p);
            removed += 1;
          }
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return removed;
}

function uniquePath(candidate: string): string {
  if (!fs.existsSync(candidate)) return candidate;
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const base = path.basename(candidate, ext);
  for (let i = 2; i < 1000; i += 1) {
    const next = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

export const downloader = new DownloadQueue();

/**
 * 把内存里的实时速率合并到一条下载记录上。
 * 只对「下载中」的任务有意义：排队/完成的任务速度与剩余时间都是 null，
 * 界面据此显示「等待开始」「用时 1 分 12 秒」等文案。
 */
export function withLiveProgress<
  T extends { id: number; status: string; file_size: number; downloaded_bytes?: number; started_at?: number | null },
>(row: T): T & { downloaded_bytes: number; started_at: number | null; speed_bps: number | null; eta_seconds: number | null } {
  const base = {
    ...row,
    downloaded_bytes: row.downloaded_bytes ?? 0,
    started_at: row.started_at ?? null,
    speed_bps: null as number | null,
    eta_seconds: null as number | null,
  };
  if (row.status !== "downloading") return base;

  const live = downloader.snapshot(row.id);
  if (!live) return base;

  const total = row.file_size > 0 ? row.file_size : live.total;
  const remaining = total > 0 ? Math.max(0, total - live.downloaded) : 0;
  const speed = live.speed > 0 ? Math.round(live.speed) : 0;
  return {
    ...base,
    file_size: total || row.file_size,
    downloaded_bytes: Math.min(live.downloaded, total || live.downloaded),
    started_at: base.started_at ?? live.startedAt,
    speed_bps: speed > 0 ? speed : null,
    eta_seconds: speed > 0 && total > 0 ? Math.round(remaining / speed) : null,
  };
}
