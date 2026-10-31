import { Router } from "express";
import { db } from "../db";
import { Channel } from "../types";
import { resolveChannel } from "../tg/client";
import { scanChannel } from "../tg/scanner";
import { asyncHandler, assert, parseId } from "../lib/http";

export const channelsRouter = Router();

const stmtList = db.prepare(`
  SELECT c.*,
    (SELECT COUNT(*) FROM downloads d WHERE d.channel_id = c.id) AS download_count,
    (SELECT COUNT(*) FROM downloads d WHERE d.channel_id = c.id AND d.status = 'done') AS done_count
  FROM channels c ORDER BY c.id ASC
`);
const stmtByUsernameOrId = db.prepare(
  "SELECT * FROM channels WHERE lower(username) = lower(?) OR tg_id = ? LIMIT 1",
);
const stmtInsert = db.prepare(
  "INSERT INTO channels(tg_id, username, title, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
);

channelsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ items: stmtList.all() });
  }),
);

channelsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = String(req.body?.input ?? "").trim();
    assert(input, 400, "请输入频道 @用户名、t.me 链接或频道 ID");

    const resolved = await resolveChannel(input);
    const existing = stmtByUsernameOrId.get(
      resolved.username || "",
      resolved.tgId,
    ) as Channel | undefined;
    if (existing) {
      res.status(409).json({ error: `频道「${existing.title}」已在列表中`, channel: existing });
      return;
    }

    const info = stmtInsert.run(resolved.tgId, resolved.username, resolved.title, Date.now());
    const channel = db.prepare<[number], Channel>("SELECT * FROM channels WHERE id = ?").get(
      Number(info.lastInsertRowid),
    );
    res.status(201).json({ channel });
  }),
);

channelsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const channel = db.prepare<[number], Channel>("SELECT * FROM channels WHERE id = ?").get(id);
    assert(channel, 404, "频道不存在");

    const patch: Record<string, unknown> = {};
    if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled ? 1 : 0;
    if (typeof req.body?.title === "string" && req.body.title.trim()) patch.title = req.body.title.trim();
    if (req.body?.resetCursor === true) patch.last_scanned_id = 0;

    const keys = Object.keys(patch);
    assert(keys.length > 0, 400, "没有需要更新的字段");
    db.prepare(`UPDATE channels SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
      ...keys.map((k) => patch[k]),
      id,
    );
    const updated = db.prepare<[number], Channel>("SELECT * FROM channels WHERE id = ?").get(id);
    res.json({ channel: updated });
  }),
);

channelsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const channel = db.prepare<[number], Channel>("SELECT * FROM channels WHERE id = ?").get(id);
    assert(channel, 404, "频道不存在");
    db.transaction(() => {
      db.prepare("DELETE FROM downloads WHERE channel_id = ?").run(id);
      db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    })();
    res.json({ ok: true });
  }),
);

channelsRouter.post(
  "/:id/scan",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const result = await scanChannel(id, { ignoreDisabled: true });
    res.json(result);
  }),
);
