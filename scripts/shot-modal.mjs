// 用 Edge 无头模式打开订阅页并截取"新建订阅"弹窗，用于确认弹窗头部/底部按钮不再被裁掉
// 用法: node scripts/shot-modal.mjs [out.png] [width] [height]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const out = process.argv[2] ?? "docs/shots/subscription-modal.png";
const width = Number(process.argv[3] ?? 1440);
const height = Number(process.argv[4] ?? 900);
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(os.tmpdir(), "edge-shot-"));
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
await sleep(2500);

await send("Runtime.evaluate", {
  expression: `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建订阅'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`,
  returnByValue: true,
});
await sleep(900);

// 填关键词，检查名称留空时的提示
await send("Runtime.evaluate", {
  expression: `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '美人局');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`,
  returnByValue: true,
});
await sleep(600);

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(out, Buffer.from(shot.data, "base64"));

ws.close();
proc.kill();
console.log("saved", out);
