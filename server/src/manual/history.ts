import { db } from "../db";
import { logger } from "../logger";
import type { ManualKind, ManualStatus } from "./note";

export interface ManualRecordInput {
  link: string;
  kind: ManualKind;
  platform?: string | null;
  status: ManualStatus;
  title?: string | null;
  note?: string | null;
  queued?: number;
  existing?: number;
  skipped?: number;
  saveDir?: string | null;
  error?: string | null;
}

export interface ManualRecordRow {
  id: number;
  link: string;
  kind: ManualKind;
  platform: string | null;
  status: ManualStatus;
  title: string | null;
  note: string | null;
  queued: number;
  existing: number;
  skipped: number;
  save_dir: string | null;
  error: string | null;
  created_at: number;
}

/** 只留最近这么多条，够回溯就行，别把库撑大 */
const MAX_ROWS = 2000;
/** 每写这么多条才扫一次表删旧行，避免每次提交都全表 count */
const TRIM_EVERY = 100;

let sinceTrim = 0;

const stmtInsert = db.prepare(
  `INSERT INTO manual_history(link, kind, platform, status, title, note, queued, existing, skipped, save_dir, error, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const stmtTrim = db.prepare(
  `DELETE FROM manual_history WHERE id NOT IN (SELECT id FROM manual_history ORDER BY id DESC LIMIT ${MAX_ROWS})`,
);

/**
 * 落一条提交记录。
 *
 * 调用方（路由层）**不要**因为写记录失败而影响下载本身：
 * 这里全部 try/catch 吞掉，只留一条 warn 日志。
 */
export function recordManual(input: ManualRecordInput): void {
  try {
    stmtInsert.run(
      String(input.link ?? "").slice(0, 2048),
      input.kind,
      input.platform ?? null,
      input.status,
      input.title ? input.title.slice(0, 500) : null,
      input.note ? input.note.slice(0, 500) : null,
      Math.max(0, Math.trunc(input.queued ?? 0)),
      Math.max(0, Math.trunc(input.existing ?? 0)),
      Math.max(0, Math.trunc(input.skipped ?? 0)),
      input.saveDir ?? null,
      input.error ? String(input.error).slice(0, 2000) : null,
      Date.now(),
    );
    sinceTrim += 1;
    if (sinceTrim >= TRIM_EVERY) {
      sinceTrim = 0;
      stmtTrim.run();
    }
  } catch (err) {
    logger.warn({ err }, "写入手动下载记录失败");
  }
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  /** 按状态筛：ok / existing / empty / error / cancel，空表示全部 */
  status?: string;
  /** 按类型筛：telegram / platform / web */
  kind?: string;
  /** 链接 / 标题 / 摘要里搜关键词 */
  q?: string;
}

export interface ListResult {
  items: ManualRecordRow[];
  total: number;
  summary: Record<string, number>;
}

const STATUSES = ["ok", "existing", "empty", "error", "cancel"] as const;

export function listManual(options: ListOptions = {}): ListResult {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 30)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const where: string[] = [];
  const params: unknown[] = [];
  // status 支持逗号分隔多选（界面「成功」= ok,existing），非法值直接忽略
  const wanted = String(options.status ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => (STATUSES as readonly string[]).includes(s));
  if (wanted.length === 1) {
    where.push("status = ?");
    params.push(wanted[0]);
  } else if (wanted.length > 1) {
    where.push(`status IN (${wanted.map(() => "?").join(", ")})`);
    params.push(...wanted);
  }
  if (options.kind && ["telegram", "platform", "web"].includes(options.kind)) {
    where.push("kind = ?");
    params.push(options.kind);
  }
  if (options.q) {
    where.push("(link LIKE ? OR title LIKE ? OR note LIKE ?)");
    const like = `%${options.q}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const items = db
    .prepare(`SELECT * FROM manual_history ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ManualRecordRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM manual_history ${whereSql}`).get(...params) as { n: number })
    .n;
  const summary = { ok: 0, existing: 0, empty: 0, error: 0, cancel: 0 } as Record<string, number>;
  for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM manual_history GROUP BY status").all() as Array<{
    status: string;
    n: number;
  }>) {
    summary[row.status] = row.n;
  }

  return { items, total, summary };
}

/** scope=all 全清；scope=error 只清失败与空记录；scope=older 只清 7 天前的 */
export function clearManual(scope: "all" | "error" | "older" = "all"): number {
  if (scope === "error") {
    return db.prepare("DELETE FROM manual_history WHERE status IN ('error', 'empty', 'cancel')").run().changes;
  }
  if (scope === "older") {
    return db.prepare("DELETE FROM manual_history WHERE created_at < ?").run(Date.now() - 7 * 86_400_000).changes;
  }
  return db.prepare("DELETE FROM manual_history").run().changes;
}

export function deleteManual(id: number): boolean {
  return db.prepare("DELETE FROM manual_history WHERE id = ?").run(id).changes > 0;
}
