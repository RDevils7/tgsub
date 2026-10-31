import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const rootDir = process.cwd();
const dataDir = ensureDir(path.resolve(process.env.DATA_DIR || path.join(rootDir, "data")));
const downloadDir = ensureDir(
  path.resolve(process.env.DOWNLOAD_DIR || path.join(dataDir, "downloads")),
);

/**
 * 会话密钥：优先读环境变量；否则在数据目录生成并持久化。
 * 用于加密 Telegram session（DB 落盘时不存明文）。
 */
function resolveSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const keyFile = path.join(dataDir, ".session-secret");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  return generated;
}

export const env = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  dataDir,
  downloadDir,
  dbFile: path.resolve(process.env.DB_FILE || path.join(dataDir, "tgsub.db")),
  webDist: path.resolve(process.env.WEB_DIST || path.join(rootDir, "web", "dist")),
  logLevel: process.env.LOG_LEVEL || "info",
  secret: resolveSecret(),
  basicAuth: {
    user: process.env.BASIC_AUTH_USER || "",
    pass: process.env.BASIC_AUTH_PASS || "",
  },
  timezone: process.env.TZ || "Asia/Shanghai",
};
