// 端到端验证：订阅弹窗只填关键词（不填名称）能否保存成功
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(path.join(os.tmpdir(), "edge-e2e-"));
const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
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
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:6789/#/subscriptions" });
await sleep(2000);

console.log("打开弹窗:", await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建订阅'))?.click() ?? 'clicked'`));
await sleep(600);

// 只填关键词，不填名称
console.log(
  "填关键词:",
  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '美人局');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('[role=dialog] input').value === '' ? '名称留空' : '名称有值';
  })()`),
);
await sleep(400);

console.log(
  "点击创建:",
  await ev(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.includes('创建订阅'))?.click() ?? 'no-button'`),
);
await sleep(1800);

console.log(
  "结果:",
  JSON.stringify(
    await ev(`(() => ({
      toast: [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && /订阅/.test(el.textContent || '')).map((el) => el.textContent).slice(0, 3),
      dialogOpen: Boolean(document.querySelector('[role=dialog]')),
      cards: [...document.querySelectorAll('.chip')].map((c) => c.textContent).slice(0, 5),
    }))()`),
  ),
);

ws.close();
proc.kill();
