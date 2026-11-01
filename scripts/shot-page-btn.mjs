// 通用页面截图：node scripts/shot-page-btn.mjs downloads "" docs/shots/x.png
// 参数：路由（downloads/monitor/...）、可选点击的按钮文字、输出路径
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const route = process.argv[2] ?? "downloads";
const buttonText = process.argv[3] ?? "";
const out = process.argv[4] ?? "docs/shots/page.png";
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(os.tmpdir(), "edge-page-"));
const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1400",
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

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:3000/" });
await sleep(1800);
await send("Runtime.evaluate", { expression: `location.hash = "/${route}";` });
await sleep(2400);

if (buttonText) {
  const clicked = await send("Runtime.evaluate", {
    expression: `(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(buttonText)});
      if (b) { b.click(); return true; }
      return false;
    })()`,
    returnByValue: true,
  });
  console.log("button clicked:", clicked.result.value);
  await sleep(1200);
}

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(out, Buffer.from(shot.data, "base64"));
ws.close();
proc.kill();
console.log("saved", out);
