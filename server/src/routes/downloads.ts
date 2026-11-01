import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { db } from "../db";
import { env } from "../env";
import { Download } from "../types";
import { downloader, withLiveProgress } from "../tg/downloader";
import { downloadFromChannelMessage, downloadFromLink } from "../tg/direct";
import { asyncHandler, assert, clampInt, parseId } from "../lib/http";

export const downloadsRouter = Router();

const stmtGet = db.prepare<[number], Download>("SELECT * FROM downloads WHERE id = ?");

downloadsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? "all");
    const channelId = Number(req.query.channelId ?? 0);
    const q = String(req.query.q ?? "").trim();
    const limit = clampInt(req.query.limit, 1, 1000, 50);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    if (
      status !== "all" &&
      ["queued", "downloading", "paused", "stopped", "done", "failed", "skipped"].includes(status)
    ) {
      where.push("status = ?");
      params.push(status);
    }
    if (channelId > 0) {
      where.push("channel_id = ?");
      params.push(channelId);
    }
    if (q) {
      where.push("(file_name LIKE ? OR matched_keyword LIKE ? OR channel_title LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const items = (
      db.prepare(`SELECT * FROM downloads ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Download[]
    ).map(withLiveProgress);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM downloads ${whereSql}`).get(...params) as { n: number }).n;

    res.json({ items, total, limit, offset, queue: { ...downloader.stats(), speed: downloader.totalSpeed() } });
  }),
);

downloadsRouter.post(
  "/link",
  asyncHandler(async (req, res) => {
    const link = String(req.body?.link ?? "").trim();
    const channelId = Number(req.body?.channelId ?? 0);
    const messageId = Number(req.body?.messageId ?? 0);

    // 监控历史里点「下载」传的是库里的频道 ID + 消息 ID，比拼链接可靠
    if (channelId > 0 && messageId > 0) {
      res.json({ item: await downloadFromChannelMessage(channelId, messageId) });
      return;
    }
    assert(link, 400, "请输入 Telegram 消息链接");
    res.json({ item: await downloadFromLink(link) });
  }),
);

downloadsRouter.post(
  "/:id/retry",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    assert(stmtGet.get(id), 404, "任务不存在");
    res.json({ ok: downloader.retry(id) });
  }),
);

downloadsRouter.post(
  "/retry-failed",
  asyncHandler(async (_req, res) => {
    const rows = db.prepare("SELECT id FROM downloads WHERE status = 'failed'").all() as Array<{ id: number }>;
    for (const row of rows) downloader.retry(row.id);
    res.json({ ok: true, count: rows.length });
  }),
);

/** 暂停 / 停止 / 继续 / 插队 —— 四个动作都只动内存队列 + 状态字段 */
const QUEUE_ACTIONS = {
  pause: (id: number) => downloader.pause(id),
  stop: (id: number) => downloader.stopTask(id),
  resume: (id: number) => downloader.resume(id),
  jump: (id: number) => downloader.jump(id),
} as const;

for (const [action, run] of Object.entries(QUEUE_ACTIONS)) {
  downloadsRouter.post(
    `/:id/${action}`,
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const row = stmtGet.get(id);
      assert(row, 404, "任务不存在");
      assert(run(id), 400, `当前状态（${row.status}）不支持该操作`);
      res.json({ ok: true });
    }),
  );
}

/**
 * 批量清空。
 * - `scope=finished`（默认）：只清已结束的记录（完成/失败/跳过/已停止），排队与下载中的保留
 * - `scope=all`：除「正在下载」外全部清掉（下载中的任务删掉会留下无主文件，直接跳过）
 * - `purge=1`：同时删除磁盘文件（只删 downloadDir 内的，防止误删）
 */
downloadsRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    const scope = String(req.query.scope ?? "finished") === "all" ? "all" : "finished";
    const purge = req.query.purge === "1";

    const rows = (
      scope === "all"
        ? db.prepare("SELECT id, file_path FROM downloads WHERE status <> 'downloading'").all()
        : db
            .prepare(
              "SELECT id, file_path FROM downloads WHERE status IN ('done','failed','skipped','stopped')",
            )
            .all()
    ) as Array<{ id: number; file_path: string | null }>;

    const root = path.resolve(env.downloadDir) + path.sep;
    let purged = 0;
    if (purge) {
      for (const row of rows) {
        if (!row.file_path) continue;
        const abs = path.resolve(row.file_path);
        if (!abs.startsWith(root)) continue;
        try {
          await fs.promises.unlink(abs);
          purged += 1;
        } catch {
          /* 文件早已被移走或删掉，不算失败 */
        }
      }
    }

    const del = db.prepare("DELETE FROM downloads WHERE id = ?");
    db.transaction((ids: number[]) => {
      for (const id of ids) del.run(id);
    })(rows.map((row) => row.id));

    // stats() 内部会 prune，把队列里已经不存在的任务清掉
    res.json({ ok: true, count: rows.length, purged, queue: downloader.stats() });
  }),
);

downloadsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "任务不存在");
    if (req.query.purge === "1" && row.file_path) {
      await fs.promises.unlink(row.file_path).catch(() => undefined);
    }
    db.prepare("DELETE FROM downloads WHERE id = ?").run(id);
    res.json({ ok: true });
  }),
);

downloadsRouter.get(
  "/:id/file",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row && row.file_path, 404, "文件不存在");
    const abs = path.resolve(row.file_path);
    assert(abs.startsWith(path.resolve(env.downloadDir) + path.sep), 403, "非法路径");
    assert(fs.existsSync(abs), 410, "文件已被移动或删除");
    res.download(abs, row.file_name);
  }),
);

downloadsRouter.get(
  "/:id/meta",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "任务不存在");
    res.json({ item: withLiveProgress(row) });
  }),
);
