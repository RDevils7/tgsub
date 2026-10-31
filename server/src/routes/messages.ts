import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { db } from "../db";
import { env } from "../env";
import { asyncHandler, clampInt, HttpError } from "../lib/http";
import { Channel, MessageLog } from "../types";
import { ensureCovers, fetchCaption, listCovers, readCoverMeta } from "../tg/covers";

export const messagesRouter = Router();

/** hit=命中并入队, filtered=命中但被大小限制过滤, miss=未命中, empty=无文本无媒体 */
const KINDS = ["hit", "filtered", "miss", "empty"];

/** 封面缓存目录（data/covers），只允许这里面的文件名 */
const coverDir = path.join(env.dataDir, "covers");
const COVER_FILE_RE = /^-?\d+-\d+-\d+\.(jpe?g|png|webp)$/i;

messagesRouter.get("/", asyncHandler(async (req, res) => {
  const status = String(req.query.status ?? "all");
  const channelId = Number(req.query.channelId ?? 0);
  const q = String(req.query.q ?? "").trim();
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

  // 基础筛选（不含状态）：频道 + 关键字，用于状态标签上的计数
  const base: string[] = [];
  const baseParams: unknown[] = [];
  if (channelId > 0) {
    base.push("channel_id = ?");
    baseParams.push(channelId);
  }
  if (q) {
    base.push("(excerpt LIKE ? OR file_name LIKE ? OR matched_keyword LIKE ? OR channel_title LIKE ?)");
    baseParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const baseSql = base.length ? `WHERE ${base.join(" AND ")}` : "";

  const where = [...base];
  const params = [...baseParams];
  if (KINDS.includes(status)) {
    where.push("kind = ?");
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // 列表不带 full_text：一页 50 条、每条最多 8KB，10 秒轮询一次太重，
  // 悬停时由 /:id/preview 单独取
  const items = (
    db
      .prepare(`SELECT * FROM message_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as MessageLog[]
  ).map((row) => ({ ...row, full_text: null }));
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM message_logs ${whereSql}`).get(...params) as { n: number }).n;

  const counts: Record<string, number> = { all: 0, hit: 0, filtered: 0, miss: 0, empty: 0 };
  const rows = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM message_logs ${baseSql} GROUP BY kind`)
    .all(...baseParams) as Array<{ kind: string; n: number }>;
  for (const row of rows) {
    counts[row.kind] = row.n;
    counts.all += row.n;
  }

  res.json({ items, total, limit, offset, counts });
}));

/**
 * 悬停预览用：完整介绍 + 3 张封面图。
 *
 * 封面优先取「下载时真正用过的那 3 张」（拼图时复制到 data/covers）；
 * 还没下载过的消息，按需从 Telegram 取前 3 张缩略图，并记住序号，
 * 之后下载会用同样的 3 张做 Emby 封面。
 */
messagesRouter.get(
  "/:id/preview",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM message_logs WHERE id = ?").get(id) as MessageLog | undefined;
    if (!row) throw new HttpError(404, "监控记录不存在");

    const cachedMeta = readCoverMeta(row.channel_id, row.message_id);
    let covers = await listCovers(row.channel_id, row.message_id);
    // 缓存里可能是「下载时留下的」，也可能是之前悬停时抓的缩略图，按索引文件判断
    let source: "download" | "telegram" | "none" = covers.length
      ? cachedMeta?.source === "telegram"
        ? "telegram"
        : "download"
      : "none";

    const channel = db.prepare("SELECT * FROM channels WHERE id = ?").get(row.channel_id) as Channel | undefined;

    // 老记录只存了 400 字摘要：补一次全文，存起来以后就不用了
    if (!row.full_text && channel) {
      try {
        const text = await fetchCaption(channel, row.message_id);
        if (text) {
          const saved = text.slice(0, 8000);
          db.prepare("UPDATE message_logs SET full_text = ? WHERE id = ?").run(saved, row.id);
          row.full_text = saved;
        }
      } catch {
        /* 取不到就先用摘要顶着 */
      }
    }

    if (!covers.length) {
      // 只在消息里确实有图片时才去打扰 Telegram
      const hasPhoto = (() => {
        try {
          const list = JSON.parse(row.file_names ?? "[]") as Array<{ kind?: string }>;
          return Array.isArray(list) && list.some((f) => f?.kind === "photo");
        } catch {
          return false;
        }
      })();
      if (channel && hasPhoto) {
        covers = await ensureCovers(channel, row.message_id);
        if (covers.length) source = "telegram";
      }
    }

    const meta = readCoverMeta(row.channel_id, row.message_id);
    res.json({
      item: row,
      source,
      covers: covers.map((cover) => ({
        file: cover.file,
        index: cover.index,
        url: `/api/messages/cover/${encodeURIComponent(cover.file)}`,
      })),
      note: meta && meta.files.length === 0 ? "这条消息里没有图片" : null,
    });
  }),
);

/** 封面图静态输出（文件名严格校验，防止路径穿越） */
messagesRouter.get(
  "/cover/:file",
  asyncHandler(async (req, res) => {
    const file = String(req.params.file ?? "");
    if (!COVER_FILE_RE.test(file)) throw new HttpError(400, "非法的文件名");
    const target = path.join(coverDir, file);
    if (!fs.existsSync(target)) throw new HttpError(404, "图片不存在");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(target);
  }),
);

messagesRouter.delete(
  "/",
  asyncHandler(async (_req, res) => {
    const result = db.prepare("DELETE FROM message_logs").run();
    res.json({ ok: true, count: result.changes });
  }),
);
