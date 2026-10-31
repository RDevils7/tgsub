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
    const limit = clampInt(req.query.limit, 1, 200, 50);
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
