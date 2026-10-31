/**
 * 只读探测：连上 Telegram 看某个频道的消息 id 分布与 minId 取数行为。
 * 必须在服务停止时运行（同一 session 并发连接会让 authKey 作废）。
 * 用法: node scripts/probe-channel.js ASC2256 10499
 */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const ROOT = "C:/Users/RDevils7/WorkBuddy/tgsub";
const DATA = path.join(ROOT, "data");
const target = process.argv[2] || "ASC2256";
const minId = Number(process.argv[3] || 0);

const secret = fs.readFileSync(path.join(DATA, ".session-secret"), "utf8").trim();
const key = crypto.createHash("sha256").update(secret).digest();
const db = new Database(path.join(DATA, "tgsub.db"), { readonly: true });
const row = db.prepare("select value from settings where key='session'").get();
const [, iv, tag, data] = row.value.split(":");
const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
d.setAuthTag(Buffer.from(tag, "base64"));
const session = Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
const settings = {};
for (const r of db.prepare("select key,value from settings").all()) settings[r.key] = r.value;

(async () => {
  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");
  const u = new URL(settings.proxy_url);
  const client = new TelegramClient(new StringSession(session), 2040, "b18441a1ff607e10a989891a5462e627", {
    connectionRetries: 1,
    requestRetries: 1,
    timeout: 30000,
    useWSS: false,
    deviceModel: "Desktop",
    systemVersion: "Windows 10",
    appVersion: "4.2.4 x64",
    langCode: "zh",
    proxy: { ip: u.hostname, port: Number(u.port || 1080), socksType: 5, timeout: 15 },
  });
  await client.connect();
  try {
    const entity = await client.getEntity(target);

    const latest = await client.getMessages(entity, { limit: 20 });
    console.log(
      "最近 20 条 id:",
      latest.map((m) => m.id).join(","),
    );

    if (minId) {
      const newer = await client.getMessages(entity, { limit: 100, minId });
      console.log(`minId=${minId} 取到 ${newer.length} 条:`, newer.map((m) => m.id).join(","));
    }

    const one = await client.getMessages(entity, { ids: [10500] });
    const msg = one && one[0];
    if (msg) {
      console.log("10500 存在:", {
        id: msg.id,
        groupedId: msg.groupedId ? String(msg.groupedId) : null,
        hasMedia: Boolean(msg.media),
        date: msg.date,
        text: (msg.message || "").slice(0, 60),
      });
    } else {
      console.log("10500 不存在或已被删除");
    }
  } catch (err) {
    console.log("探测失败:", err.errorMessage || err.message);
  }
  await client.disconnect().catch(() => undefined);
  process.exit(0);
})();
