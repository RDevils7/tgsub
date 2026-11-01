// 元数据页截图：node scripts/shot-metadata.mjs [outDir]
// 依次截：基本信息 / 图片 / 更换图片弹窗（截图页）/ NFO 原文
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const outDir = process.argv[2] ?? "docs/shots";
const PORT = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), "edge-meta-"));
const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1500",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitTarget() {
  for (let i = 0; i < 80; i += 1) {
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
let seq = 0;
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
    seq += 1;
    pending.set(seq, { resolve, reject });
    ws.send(JSON.stringify({ id: seq, method, params }));
  });

const evalJs = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? "JS 执行失败");
  return res.result.value;
};

const shot = async (name) => {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(outDir, name);
  await writeFile(file, Buffer.from(res.data, "base64"));
  console.log("saved", file);
};

const clickText = (text, selector = "button") =>
  evalJs(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
      (x) => x.textContent.trim() === ${JSON.stringify(text)} || x.title === ${JSON.stringify(text)},
    );
    if (!b) return "missing";
    b.click();
    return "ok";
  })()`);

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:3000/" });
await sleep(1600);
await send("Runtime.evaluate", { expression: 'location.hash = "/metadata";' });
await sleep(2600);
await shot("meta-basic.png");

console.log("tab 图片:", await clickText("图片"));
await sleep(1500);
await shot("meta-images.png");

console.log("打开更换弹窗:", await clickText("更换"));
await sleep(4200);
await shot("meta-picker.png");

console.log("关闭弹窗:", await clickText("取消"));
await sleep(600);
console.log("tab NFO:", await clickText("NFO 原文"));
await sleep(1500);
await shot("meta-nfo.png");

ws.close();
proc.kill();
