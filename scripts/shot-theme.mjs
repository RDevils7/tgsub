// 主题切换视觉验证：node scripts/shot-theme.mjs [outDir]
// 分别截「暗色」与「亮色」下的概览页与元数据页（含展开的文件夹树）
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const outDir = process.argv[2] ?? "docs/shots";
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), "edge-theme-"));
const proc = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1200",
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

const setTheme = async (theme) => {
  await evalJs(`localStorage.setItem("tgsub-theme", ${JSON.stringify(theme)})`);
  await evalJs(
    `document.documentElement.classList.toggle("dark", ${theme === "dark"});
     document.documentElement.dataset.theme = ${JSON.stringify(theme)};
     window.dispatchEvent(new Event("storage"));`,
  );
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1200,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: "http://127.0.0.1:6789/" });
await sleep(1800);

for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  await evalJs('location.hash = "/dashboard";');
  await sleep(1400);
  await shot(`theme-${theme}-dashboard.png`);

  await evalJs('location.hash = "/metadata";');
  await sleep(2200);
  // 展开文件夹树
  await evalJs(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.title === "展开文件");
    if (b) b.click();
    return b ? "ok" : "missing";
  })()`);
  await sleep(1200);
  await shot(`theme-${theme}-metadata.png`);
}

ws.close();
proc.kill();
