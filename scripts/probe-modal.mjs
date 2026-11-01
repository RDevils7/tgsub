// 用 Edge 无头模式打开订阅页，点击"新建订阅"，输出弹窗各区块的几何信息（调布局时用）
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const width = Number(process.argv[2] ?? 1440);
const height = Number(process.argv[3] ?? 900);
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(os.tmpdir(), "edge-probe-"));
const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitTargets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
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
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:6789/#/subscriptions" });
await sleep(2000);

const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建订阅'))?.click()`);
await sleep(700);
await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '美人局');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
await sleep(500);

const info = await evaluate(`(() => {
  const dialog = document.querySelector('[role=dialog]');
  if (!dialog) return { error: 'no dialog' };
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const parts = [...dialog.children];
  const body = parts[1];
  return {
    viewport: { w: innerWidth, h: innerHeight, scrollY: scrollY },
    dialog: rect(dialog),
    header: rect(parts[0]),
    body: rect(body),
    bodyScroll: body ? { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null,
    footer: rect(parts[2]),
    bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
    inputs: [...dialog.querySelectorAll('input,textarea')].map((el) => ({ tag: el.tagName, value: el.value, ph: el.placeholder })),
    hints: [...dialog.querySelectorAll('span')].map((s) => s.textContent).filter((t) => t && t.includes('留空')),
  };
})()`);
console.log(JSON.stringify(info, null, 2));

ws.close();
proc.kill();
