import { Router } from "express";
import { db } from "../db";
import { invalidateMatcherCache, validateRegex } from "../match";
import { MatchMode, Subscription } from "../types";
import { deriveName, splitKeywords } from "../utils";
import { asyncHandler, assert, parseId } from "../lib/http";

export const subscriptionsRouter = Router();

const MODES: MatchMode[] = ["contains", "word", "regex"];

const stmtList = db.prepare("SELECT * FROM subscriptions ORDER BY id DESC");
const stmtGet = db.prepare<[number], Subscription>("SELECT * FROM subscriptions WHERE id = ?");

function normalizeChannelIds(raw: unknown): string {
  if (!Array.isArray(raw)) return "[]";
  const ids = raw
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  return JSON.stringify([...new Set(ids)]);
}

function parseMode(raw: unknown): MatchMode {
  const mode = String(raw ?? "contains") as MatchMode;
  assert(MODES.includes(mode), 400, "匹配模式无效");
  return mode;
}

/** 名称留空时用关键词自动生成，避免"只想填关键词"却存不进去 */

subscriptionsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ items: stmtList.all() });
  }),
);

subscriptionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const keywords = String(req.body?.keywords ?? "").trim();
    const mode = parseMode(req.body?.match_mode);
    assert(splitKeywords(keywords).length > 0, 400, "请至少填写一个关键词");
    const name = String(req.body?.name ?? "").trim() || deriveName(keywords);
    if (mode === "regex") {
      const error = validateRegex(keywords);
      assert(!error, 400, error || "正则表达式无效");
    }

    const info = db
      .prepare(
        `INSERT INTO subscriptions(name, keywords, match_mode, channel_ids, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, keywords, mode, normalizeChannelIds(req.body?.channel_ids), req.body?.enabled === false ? 0 : 1, Date.now());

    invalidateMatcherCache();
    res.status(201).json({ subscription: stmtGet.get(Number(info.lastInsertRowid)) });
  }),
);

subscriptionsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    assert(stmtGet.get(id), 404, "订阅不存在");

    const patch: Record<string, unknown> = {};
    if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim();
    if (typeof req.body?.keywords === "string") {
      const keywords = req.body.keywords.trim();
      assert(splitKeywords(keywords).length > 0, 400, "请至少填写一个关键词");
      const mode = parseMode(req.body?.match_mode ?? stmtGet.get(id)?.match_mode);
      if (mode === "regex") {
        const error = validateRegex(keywords);
        assert(!error, 400, error || "正则表达式无效");
      }
      patch.keywords = keywords;
    }
    if (req.body?.match_mode !== undefined) patch.match_mode = parseMode(req.body.match_mode);
    if (req.body?.channel_ids !== undefined) patch.channel_ids = normalizeChannelIds(req.body.channel_ids);
    if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled ? 1 : 0;

    const keys = Object.keys(patch);
    assert(keys.length > 0, 400, "没有需要更新的字段");
    db.prepare(`UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
      ...keys.map((k) => patch[k]),
      id,
    );
    invalidateMatcherCache();
    res.json({ subscription: stmtGet.get(id) });
  }),
);

subscriptionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const info = db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
    assert(info.changes > 0, 404, "订阅不存在");
    invalidateMatcherCache();
    res.json({ ok: true });
  }),
);
