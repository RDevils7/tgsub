// 端到端验证：在设置页填 Bot Token → 保存并连接 → 状态徽标是否反映真实结果
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先把机器人打开（token 留空），模拟用户已经打开开关但还没填 token
await fetch("http://127.0.0.1:3000/api/settings", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bot_enabled: true, bot_allow_users: "123456789" }),
});

const profile = mkdtempSync(path.join(os.tmpdir(), "edge-bot-"));
const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,2600",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitTargets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) return p;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error("无法连接 DevTools");
}

const page = await waitTargets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 2600, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:3000/#/settings" });
await sleep(2600);

const before = await ev(`(() => {
  const s = [...document.querySelectorAll('section')].pop();
  return { title: s.querySelector('h2')?.textContent, badge: s.querySelector('span.rounded-full')?.textContent?.trim() };
})()`);
console.log("进入页面:", JSON.stringify(before));

console.log(
  "填入 token:",
  await ev(`(() => {
    const s = [...document.querySelectorAll('section')].pop();
    const input = s.querySelector('input[type=password]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '123456789:AAHfakefakefakefakefakefakefakefakef');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value.slice(0, 12) + '…';
  })()`),
);
await sleep(400);

console.log(
  "点击保存并连接:",
  await ev(`(() => {
    const s = [...document.querySelectorAll('section')].pop();
    const b = [...s.querySelectorAll('button')].find((x) => x.textContent.includes('保存并连接'));
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`),
);

await sleep(11000);

const after = await ev(`(() => {
  const s = [...document.querySelectorAll('section')].pop();
  const err = [...s.querySelectorAll('p')].map((p) => p.textContent).find((t) => /Token|连接|代理/.test(t));
  return {
    badge: s.querySelector('span.rounded-full')?.textContent?.trim(),
    error: err || null,
    tokenValue: s.querySelector('input[type=password]')?.value ?? null,
  };
})()`);
console.log("保存后:", JSON.stringify(after));

const state = await (await fetch("http://127.0.0.1:3000/api/bot")).json();
console.log("接口状态:", JSON.stringify(state.bot));

ws.close();
proc.kill();

// 清场：关掉机器人并清除测试 token
await fetch("http://127.0.0.1:3000/api/settings", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bot_enabled: false, bot_token: "", bot_allow_users: "" }),
});
console.log("已重置机器人配置");
