/**
 * 从 SQLite 主库与 WAL 中恢复被误删的 Telegram session。
 * 用法：node scripts/recover-session.js [--restore]
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const secret = fs.readFileSync(path.join(DATA, ".session-secret"), "utf8").trim();
const key = crypto.createHash("sha256").update(secret).digest();

function candidates() {
  const found = new Map();
  for (const f of ["tgsub.db", "tgsub.db-wal", "tgsub.db-shm"]) {
    const p = path.join(DATA, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p).toString("latin1");
    const re = /v1:[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]{20,30}:[A-Za-z0-9+/=]{300,600}/g;
    let m;
    while ((m = re.exec(s))) found.set(m[0], f);
  }
  return found;
}

function decrypt(payload) {
  const [, iv, tag, data] = payload.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

const list = [];
for (const [payload, src] of candidates()) {
  try {
    const plain = decrypt(payload);
    if (!plain.startsWith("1")) continue;
    const raw = Buffer.from(plain.slice(1), "base64");
    const dc = raw.readUInt8(0);
    const al = raw.readInt16BE(1);
    const addr = raw.slice(3, 3 + al).toString();
    const port = raw.readInt16BE(3 + al);
    const k = raw.slice(5 + al);
    list.push({
      payload,
      src,
      dc,
      addr,
      port,
      fp: crypto.createHash("sha256").update(k).digest("hex").slice(0, 12),
      plain,
    });
  } catch {
    /* 解密失败说明是损坏或被覆盖的旧页，跳过 */
  }
}

console.log(`可解密候选: ${list.length}`);
list.forEach((c, i) => console.log(`  [${i}] ${c.src} dc${c.dc} ${c.addr}:${c.port} fp=${c.fp}`));

const restore = process.argv.includes("--restore");
if (!list.length) process.exit(1);

(async () => {
  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");
  const Database = require("better-sqlite3");

  const db = new Database(path.join(DATA, "tgsub.db"), { readonly: true });
  const settings = {};
  for (const r of db.prepare("SELECT key, value FROM settings").all()) settings[r.key] = r.value;
  db.close();

  let proxy;
  if (settings.proxy_url) {
    const u = new URL(settings.proxy_url);
    proxy = { ip: u.hostname, port: Number(u.port || 1080), socksType: 5, timeout: 20 };
  }

  for (const c of list) {
    const client = new TelegramClient(new StringSession(c.plain), 2040, "b18441a1ff607e10a989891a5462e627", {
      connectionRetries: 1,
      requestRetries: 1,
      timeout: 25000,
      useWSS: false,
      deviceModel: "Desktop",
      systemVersion: "Windows 10",
      appVersion: "4.2.4 x64",
      langCode: "zh",
      proxy,
    });
    try {
      await client.connect();
      const me = await client.getMe();
      console.log(`[${list.indexOf(c)}] 有效 ✓ 账号: ${me.username || me.firstName} id=${me.id}`);
      if (restore) {
        const rw = new Database(path.join(DATA, "tgsub.db"));
        rw.prepare(
          "INSERT INTO settings(key,value) VALUES('session',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(c.payload);
        rw.close();
        console.log("已写回数据库");
      }
      await client.disconnect().catch(() => undefined);
      process.exit(0);
    } catch (e) {
      console.log(`[${list.indexOf(c)}] 无效: ${e.errorMessage || e.message}`);
      await client.disconnect().catch(() => undefined);
    }
  }
  process.exit(2);
})();
