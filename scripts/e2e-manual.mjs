// 端到端验证：手动下载页粘贴链接 → 解析 → 回执
// 用法：node scripts/e2e-manual.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(path.join(os.tmpdir(), "edge-manual-"));
const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
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
      const p = list.find((t) => t.type === "page");
      if (p) return p;
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
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
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:3000/#/manual" });
await sleep(2200);

// 一条已下载过的（不会真的重复下载）+ 一条格式不对的
console.log(
  "填入链接:",
  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'https://t.me/ASC2256/10500\\nhttps://example.com/not-a-link');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`),
);
await sleep(500);

console.log(
  "识别数量:",
  await ev(`[...document.querySelectorAll('p')].map(p => p.textContent).find(t => t.includes('已识别')) ?? '未找到'`),
);

console.log("点击开始:", await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('开始下载'))?.click() ?? 'no-button'`));

// 等解析完成
for (let i = 0; i < 20; i += 1) {
  await sleep(800);
  const done = await ev(`document.body.innerText.includes('已入队') || document.body.innerText.includes('失败')`);
  if (done) break;
}

console.log(
  "结果:",
  JSON.stringify(
    await ev(`(() => {
      const rows = [...document.querySelectorAll('.card .divide-y > div')].map((row) => row.innerText.replace(/\\n+/g, ' | '));
      return { rows, toast: [...document.querySelectorAll('body *')].filter(el => el.children.length === 0 && /入队|失败|解析/.test(el.textContent || '')).map(el => el.textContent.trim()).slice(-3) };
    })()`),
  ),
);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("docs/shots/manual-result.png", Buffer.from(shot.data, "base64"));
console.log("截图已保存 docs/shots/manual-result.png");

ws.close();
proc.kill();
