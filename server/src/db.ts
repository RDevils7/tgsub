import crypto from "node:crypto";
import Database from "better-sqlite3";
import { env } from "./env";
import { logger } from "./logger";
import { AppSettings, DEFAULT_SETTINGS } from "./types";

export const db = new Database(env.dbFile);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id           TEXT,
  username        TEXT,
  title           TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_scanned_id INTEGER NOT NULL DEFAULT 0,
  last_scan_at    INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_username
  ON channels(lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_tgid
  ON channels(tg_id) WHERE tg_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  keywords    TEXT NOT NULL,
  match_mode  TEXT NOT NULL DEFAULT 'contains',
  channel_ids TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      INTEGER NOT NULL,
  channel_title   TEXT NOT NULL,
  message_id      INTEGER NOT NULL,
  grouped_id      TEXT,
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL DEFAULT 0,
  mime_type       TEXT,
  media_kind      TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  progress        INTEGER NOT NULL DEFAULT 0,
  -- 已下载字节数（用于展示「已下载 / 总大小」与断点续传排查）
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  file_path       TEXT,
  matched_keyword TEXT,
  subscription_id INTEGER,
  created_at      INTEGER NOT NULL,
  -- 真正开始下载的时刻（排队时间为 created_at）
  started_at      INTEGER,
  finished_at     INTEGER,
  -- 按正文剧集解析出的目标位置（相对下载根目录）：剧名文件夹 + 剧名S01E04.mp4。
  -- 为空时退回 file_template 的老逻辑
  save_dir        TEXT,
  save_name       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_downloads_unique
  ON downloads(channel_id, message_id, file_name);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status, id);
CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);

/* 手动添加的媒体来源：用户在元数据页手动选中的视频文件 / 视频目录。
   这些路径不在下载目录内，但用户明确要求为其生成元数据，故单独登记。 */
CREATE TABLE IF NOT EXISTS media_sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER NOT NULL,
  channel_title TEXT NOT NULL,
  scanned       INTEGER NOT NULL DEFAULT 0,
  matched       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running',
  message       TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_started ON scan_runs(started_at DESC);

/* 消息级监控日志：每一条被扫描到的消息都留痕，用于回答
   「这条消息为什么下载了 / 为什么没下载」。
   kind 取值：hit(命中并入队) / filtered(命中但被大小限制过滤) / miss(未命中) / empty(无文本无媒体) */
CREATE TABLE IF NOT EXISTS message_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL,
  channel_title     TEXT NOT NULL,
  channel_username  TEXT,
  message_id        INTEGER NOT NULL,
  grouped_id        TEXT,
  kind              TEXT NOT NULL,
  matched_keyword   TEXT,
  subscription_id   INTEGER,
  subscription_name TEXT,
  media_kind        TEXT,
  file_name         TEXT,
  file_size         INTEGER NOT NULL DEFAULT 0,
  file_count        INTEGER NOT NULL DEFAULT 0,
  excerpt           TEXT,
  run_id            INTEGER,
  created_at        INTEGER NOT NULL,
  -- 首次扫描时间（created_at）与最近一次扫到的时间分开记：
  -- 同一条消息被反复扫到时只更新 last_seen_at / seen_count，不重复堆行
  last_seen_at      INTEGER NOT NULL DEFAULT 0,
  seen_count        INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_unique
  ON message_logs(channel_id, message_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_created ON message_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_kind ON message_logs(kind, id DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_channel ON message_logs(channel_id, id DESC);
`);

/** 轻量迁移：老库补列（SQLite 没有 ADD COLUMN IF NOT EXISTS） */
function ensureColumn(table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  logger.info({ table, column }, "数据库已补列");
}

ensureColumn("message_logs", "last_seen_at", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("message_logs", "seen_count", "INTEGER NOT NULL DEFAULT 1");
// 一条消息里可能同时有视频和多张图片（相册），文件清单单独存一份 JSON：
// 形如 [{"kind":"video","name":"a.mp4","size":123}]，最多 20 项
ensureColumn("message_logs", "file_names", "TEXT");
// 完整正文（excerpt 只有 400 字，悬停预览要显示全文）
ensureColumn("message_logs", "full_text", "TEXT");
ensureColumn("downloads", "save_dir", "TEXT");
ensureColumn("downloads", "save_name", "TEXT");
// Emby 元信息（剧名/季/集/简介/标签/原消息链接），下载完成后生成 .nfo 与封面图
ensureColumn("downloads", "emby_json", "TEXT");
// 下载进度明细：已下载字节数 + 实际开始时间
ensureColumn("downloads", "downloaded_bytes", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("downloads", "started_at", "INTEGER");
// 老数据补齐：已完成的任务下载量必然等于文件大小
db.prepare("UPDATE downloads SET downloaded_bytes = file_size WHERE status = 'done' AND downloaded_bytes = 0").run();

/**
 * 老数据合并：早期版本对相册的每条子消息各写一行，
 * 现在「一条消息 = 一行」（相册整组算一条），需要把历史数据收敛掉。
 *
 * 保留组内最小 message_id 的那行作为代表（t.me 链接定位到相册第一条），
 * 文件数取最大值（旧行里每行都记了整组文件数），大小求和（每行只记自己那个文件）。
 */
function mergeGroupedLogs(): void {
  const groups = db
    .prepare(
      `SELECT channel_id, grouped_id, COUNT(*) AS n, MIN(message_id) AS keep_id,
              SUM(file_size) AS total_size, MAX(file_count) AS files,
              MAX(seen_count) AS seen, MAX(last_seen_at) AS seen_at, MIN(created_at) AS first_at
         FROM message_logs
        WHERE grouped_id IS NOT NULL AND grouped_id <> ''
        GROUP BY channel_id, grouped_id
       HAVING n > 1`,
    )
    .all() as Array<{
    channel_id: number;
    grouped_id: string;
    n: number;
    keep_id: number;
    total_size: number | null;
    files: number | null;
    seen: number | null;
    seen_at: number | null;
    first_at: number;
  }>;
  if (!groups.length) return;

  const update = db.prepare(
    `UPDATE message_logs
        SET file_size = ?, file_count = ?, seen_count = ?, last_seen_at = ?, created_at = ?
      WHERE channel_id = ? AND message_id = ?`,
  );
  const remove = db.prepare(
    "DELETE FROM message_logs WHERE channel_id = ? AND grouped_id = ? AND message_id <> ?",
  );

  let removed = 0;
  db.transaction(() => {
    for (const g of groups) {
      update.run(
        g.total_size ?? 0,
        g.files ?? 0,
        g.seen ?? 1,
        g.seen_at ?? g.first_at,
        g.first_at,
        g.channel_id,
        g.keep_id,
      );
      removed += remove.run(g.channel_id, g.grouped_id, g.keep_id).changes;
    }
  })();
  logger.info({ groups: groups.length, removed }, "已把相册重复记录合并为一条消息一行");
}

mergeGroupedLogs();

const settingsCache = new Map<string, string>();

const selectSetting = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?");
const upsertSetting = db.prepare(
  "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function getSetting(key: string): string | undefined {
  if (settingsCache.has(key)) return settingsCache.get(key);
  const row = selectSetting.get(key);
  if (row) settingsCache.set(key, row.value);
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  upsertSetting.run(key, value);
  settingsCache.set(key, value);
}

export function getSettings(): AppSettings {
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const raw = getSetting(key);
    if (raw === undefined) continue;
    const def = defaults[key];
    if (typeof def === "number") merged[key] = Number(raw) || 0;
    else if (typeof def === "boolean") merged[key] = raw === "true";
    else merged[key] = raw;
  }
  return merged as unknown as AppSettings;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const tx = db.transaction((entries: [string, unknown][]) => {
    for (const [key, value] of entries) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      setSetting(key, String(value ?? ""));
    }
  });
  tx(Object.entries(patch).filter(([, v]) => v !== undefined));
  return getSettings();
}

/* ------------------------------------------------------------------ */
/* 会话密钥：AES-256-GCM 加密 Telegram session，避免明文落盘           */
/* ------------------------------------------------------------------ */

const key = crypto.createHash("sha256").update(env.secret).digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  if (!payload.startsWith("v1:")) return payload;
  const [, ivB64, tagB64, dataB64] = payload.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

function readEncryptedSession(raw: string | undefined, label: string): string {
  if (!raw) return "";
  try {
    return decryptSecret(raw);
  } catch (err) {
    logger.warn({ err, label }, "无法解密 session，可能 SESSION_SECRET 已变更");
    return "";
  }
}

export function getSession(): string {
  return readEncryptedSession(getSetting("session"), "session");
}

/**
 * 最近一次「服务器验证通过」的 session 快照。
 * 主记录被异常覆盖、迁移写入半成品、或数据库页损坏时用它兜底，
 * 避免一个本可以恢复的登录状态被迫重新扫码。
 */
export function getSessionBackup(): string {
  return readEncryptedSession(getSetting("session_backup"), "session_backup");
}

/**
 * 保存 session。
 *
 * 只会被「已向服务器验证成功」的流程调用（登录收尾 / 首次连接探测通过），
 * 所以写进去的既是主记录也是备份——备份天然是已知可用的一份。
 */
export function setSession(session: string): void {
  if (!session) {
    setSetting("session", "");
    return;
  }
  const encrypted = encryptSecret(session);
  setSetting("session", encrypted);
  setSetting("session_backup", encrypted);
  setSetting("session_saved_at", String(Date.now()));
  setSetting("session_state", "ok");
  setSetting("session_error", "");
  setSetting("session_error_at", "");
}

/** 标记「登录状态已被服务器判死」，但**保留** session 与备份，便于事后排查/手动恢复 */
export function markSessionInvalid(code: string): void {
  setSetting("session_state", "dead");
  setSetting("session_error", code);
  setSetting("session_error_at", String(Date.now()));
}

export function markSessionValid(): void {
  if (getSetting("session_state") === "dead") {
    setSetting("session_state", "ok");
    setSetting("session_error", "");
    setSetting("session_error_at", "");
  }
}

export function getSessionMeta(): {
  savedAt: number | null;
  state: "ok" | "dead" | "none";
  error: string | null;
} {
  const has = Boolean(getSession());
  const rawState = getSetting("session_state");
  const savedAt = Number(getSetting("session_saved_at"));
  return {
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : null,
    state: !has ? "none" : rawState === "dead" ? "dead" : "ok",
    error: getSetting("session_error") || null,
  };
}

/** 仅在用户主动登出时调用：清空主记录与备份 */
export function clearSession(): void {
  setSetting("session", "");
  setSetting("session_backup", "");
  setSetting("session_state", "");
  setSetting("session_error", "");
  setSetting("session_error_at", "");
  setSetting("session_saved_at", "");
}

/* ------------------------------------------------------------------ */
/* 机器人 token：和 session 一样按 secret 加密落盘，不放进 AppSettings   */
/* （AppSettings 会被原样回给前端，token 混在里面很容易被带出去）        */
/* ------------------------------------------------------------------ */

export function getBotToken(): string {
  const raw = getSetting("bot_token");
  if (!raw) return "";
  try {
    return decryptSecret(raw);
  } catch {
    return "";
  }
}

export function setBotToken(token: string): void {
  const value = token.trim();
  setSetting("bot_token", value ? encryptSecret(value) : "");
  // 换了 bot 归属 DC 可能不同，清掉旧的直连缓存，重新登录时自动探测
  setSetting("bot_dc", "");
}
