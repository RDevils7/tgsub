/**
 * 诊断脚本：解密已保存的 Telegram session，解析其 DC / 地址 / 端口，
 * 并用它真实连接一次，抓取原始错误。
 *
 * 用法：node scripts/diag-session.js
 */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");

const secretFile = path.join(DATA, ".session-secret");
if (!fs.existsSync(secretFile)) {
  console.error("找不到 data/.session-secret");
  process.exit(1);
}
const secret = fs.readFileSync(secretFile, "utf8").trim();
const key = crypto.createHash("sha256").update(secret).digest();

function decrypt(payload) {
  if (!payload.startsWith("v1:")) return payload;
  const [, ivB64, tagB64, dataB64] = payload.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(dataB64, "base64")), d.final()]).toString("utf8");
}

const db = new Database(path.join(DATA, "tgsub.db"), { readonly: true });
const row = db.prepare("SELECT value FROM settings WHERE key = 'session'").get();
if (!row || !row.value) {
  console.error("数据库中没有 session");
  process.exit(1);
}

const sessionStr = decrypt(row.value);
console.log("session 明文长度:", sessionStr.length);
console.log("版本位:", sessionStr[0]);

// 解析内部结构
const raw = Buffer.from(sessionStr.slice(1), "base64");
let off = 0;
const dcId = raw.readUInt8(off); off += 1;
const addrLen = raw.readInt16BE(off); off += 2;
const addr = raw.slice(off, off + addrLen).toString(); off += addrLen;
const port = raw.readInt16BE(off); off += 2;
const authKey = raw.slice(off);
console.log("DC       :", dcId);
console.log("服务器地址:", addr);
console.log("端口     :", port);
console.log("authKey  :", authKey.length, "字节", authKey.slice(0, 8).toString("hex"), "...");

// 读取其余配置
const settings = {};
for (const r of db.prepare("SELECT key, value FROM settings").all()) settings[r.key] = r.value;
console.log("凭证模式 :", settings.credential_mode, "| 内置应用:", settings.builtin_app);
console.log("代理     :", settings.proxy_url);

(async () => {
  // 关键保护：服务在跑的时候绝不能用同一个 session 再连一次 Telegram。
  // 同一个 authKey 并发连接会被服务器判 AUTH_KEY_DUPLICATED 并作废，
  // 结果就是「诊断脚本跑一次，网页端又要重新扫码」。
  const alive = await fetch("http://127.0.0.1:6789/api/health")
    .then(() => true)
    .catch(() => false);
  if (alive && !process.argv.includes("--force")) {
    console.error("检测到 tgsub 服务正在运行。此刻连接会作废当前 authKey（需要重新扫码）。");
    console.error("请先停掉服务再诊断；确实要强行执行请加 --force。");
    process.exit(2);
  }

  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");

  let proxy;
  if (settings.proxy_url) {
    const u = new URL(settings.proxy_url);
    proxy = { ip: u.hostname, port: Number(u.port || 1080), socksType: 5, timeout: 15 };
  }

  const client = new TelegramClient(new StringSession(sessionStr), 2040, "b18441a1ff607e10a989891a5462e627", {
    connectionRetries: 1,
    requestRetries: 1,
    timeout: 20000,
    useWSS: false,
    deviceModel: "Desktop",
    systemVersion: "Windows 10",
    appVersion: "4.2.4 x64",
    langCode: "zh",
    proxy,
  });

  try {
    await client.connect();
    console.log("connect() 成功, 当前 DC:", client.session.dcId);
    const ok = await client.checkAuthorization();
    console.log("checkAuthorization:", ok);
    if (ok) {
      const me = await client.getMe();
      console.log("账号:", me.username || me.firstName, "| id:", String(me.id));
    }
    // 试一个需要授权的轻量调用
    try {
      const res = await client.invoke(new (require("telegram").Api.help.GetNearestDc)());
      console.log("help.GetNearestDc OK:", JSON.stringify(res));
    } catch (e) {
      console.log("help.GetNearestDc 失败:", e.errorMessage || e.message);
    }
  } catch (e) {
    console.log("!!! 连接/鉴权异常:", e.errorMessage || e.message);
    console.log("    错误类:", e.constructor && e.constructor.name);
  } finally {
    await client.disconnect().catch(() => undefined);
    process.exit(0);
  }
})();
