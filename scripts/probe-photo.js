/**
 * 只读探测：把 10500 这条相册里的几张照片依次下载到临时目录，看 0 字节问题出在哪。
 * 需在服务停止时运行。
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const ROOT = "C:/Users/RDevils7/WorkBuddy/tgsub";
const DATA = path.join(ROOT, "data");
const ids = (process.argv[2] || "10501,10503,10505").split(",").map(Number);

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
  const { TelegramClient, Api } = require("telegram");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgsub-photo-"));
  try {
    const entity = await client.getEntity("ASC2256");
    for (const id of ids) {
      const msgs = await client.getMessages(entity, { ids: [id] });
      const msg = msgs && msgs[0];
      if (!msg) {
        console.log(id, "消息不存在");
        continue;
      }
      const media = msg.media;
      const photo = media && media.photo;
      console.log(id, "media:", media && media.className, "photo:", photo && photo.className, "sizes:", photo && photo.sizes && photo.sizes.map((s) => s.className + (s.size ? `:${s.size}` : "")).join("|"));
      const out = path.join(dir, `${id}.jpg`);
      const t0 = Date.now();
      const res = await client.downloadMedia(msg, { outputFile: out, progressCallback: (d, t) => { console.log("  progress", id, String(d), String(t)); } });
      const size = fs.existsSync(out) ? fs.statSync(out).size : -1;
      const retSize = Buffer.isBuffer(res) ? res.length : typeof res === "string" ? res.length : -2;
      console.log(id, "落盘:", size, "返回:", retSize, "耗时:", Date.now() - t0, "ms");
    }
  } catch (err) {
    console.log("探测失败:", err.errorMessage || err.message);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  await client.disconnect().catch(() => undefined);
  process.exit(0);
})();
