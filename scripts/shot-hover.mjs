// 悬停预览截图：node scripts/shot-hover.mjs docs/shots/monitor-hover.png [行号]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const out = process.argv[2] ?? "docs/shots/monitor-hover.png";
const target = String(process.argv[3] ?? "0");
const rowIndex = Number(target) || 0;
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(os.tmpdir(), "edge-hover-"));
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

async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error("无法连接 DevTools");
}

const page = await waitTarget();
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
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return res.result?.value;
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:3000/" });
await sleep(1800);
await send("Runtime.evaluate", { expression: 'location.hash = "#/monitor";' });
await sleep(2200);

// 找到所有「介绍文字」段落（带 cursor-help 的那个），定位到指定行
const rect = await evaluate(`(() => {
  const ps = [...document.querySelectorAll('p.cursor-help')];
  const byMsg = ${Number(target) > 0 ? `ps.find(p => {
    const tr = p.closest('tr');
    return tr && (tr.innerText || '').includes('#${target}');
  })` : "null"};
  const el = byMsg || ps[${rowIndex}];
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(80, r.width / 2)), y: Math.round(r.top + r.height / 2), count: ps.length, found: byMsg ? 'byMsg' : 'byIndex' };
})()`);
if (!rect) throw new Error("没找到介绍文字");
console.log("rows:", rect.count, "hover at", rect.x, rect.y);

await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, buttons: 0 });
await sleep(360);
// 触发 React 的 onMouseEnter（部分环境 mouseMoved 不合成过场事件）
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + 1, y: rect.y + 1, buttons: 0 });
await sleep(5000);
// 把鼠标移到浮层里，验证不会闪退
const pop = await evaluate(`(() => {
  const el = [...document.querySelectorAll('div')].find(d => d.className && String(d.className).includes('z-[80]'));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40), w: Math.round(r.width), h: Math.round(r.height),
           imgs: el.querySelectorAll('img').length,
           text: (el.innerText || '').slice(0, 120) };
})()`);
console.log("overlay:", JSON.stringify(pop));
if (pop) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pop.x, y: pop.y, buttons: 0 });
  await sleep(600);
}
const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(out, Buffer.from(shot.data, "base64"));
ws.close();
proc.kill();
console.log("saved", out);
