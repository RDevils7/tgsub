// 元数据页「手动来源按剧集文件夹拆分 + 删除按钮」截图
// node scripts/shot-metadata-sources.mjs [outDir]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const outDir = process.argv[2] ?? "docs/shots";
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造一个多剧的上级目录，验证「遍历 + 按剧集文件夹显示」
const testRoot = path.join(os.tmpdir(), "tgsub-shot-media");
rmSync(testRoot, { recursive: true, force: true });
const series = [
  ["美人局", ["美人局S01E01.mp4", "美人局S01E02.mp4", "美人局S01E03.mp4"]],
  ["我的妈妈徐秋曼", ["我的妈妈徐秋曼S01E01.mp4", "我的妈妈徐秋曼S01E02.mp4"]],
  ["老板今天又发飙了", ["老板今天又发飙了S01E01.mp4"]],
];
for (const [name, files] of series) {
  mkdirSync(path.join(testRoot, "短剧", name), { recursive: true });
  for (const f of files) {
    await writeFile(path.join(testRoot, "短剧", name, f), Buffer.alloc(1024));
  }
}

// 登记为手动来源（用完即删）
const added = await fetch("http://127.0.0.1:3000/api/metadata/sources", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: path.join(testRoot, "短剧") }),
}).then((r) => r.json());
const sourceId = added.source?.id;

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), "edge-meta-src-"));
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

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:3000/" });
await sleep(1600);
await send("Runtime.evaluate", { expression: 'location.hash = "/metadata";' });
await sleep(2600);
await shot("meta-sources-tree.png");

// 打开「添加」对话框，看来源展开信息
console.log(
  "打开添加对话框:",
  await evalJs(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "添加");
    if (!b) return "missing";
    b.click();
    return "ok";
  })()`),
);
await sleep(1400);
await shot("meta-sources-dialog.png");

console.log(
  "关闭对话框:",
  await evalJs(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "完成");
    if (!b) return "missing";
    b.click();
    return "ok";
  })()`),
);
await sleep(900);

// 点第一个手动来源文件夹上的删除按钮 → 弹出确认框
console.log(
  "点击删除按钮:",
  await evalJs(`(() => {
    const b = [...document.querySelectorAll("button[title]")].find((x) =>
      (x.title || "").includes("移除手动来源"),
    );
    if (!b) return "missing";
    b.click();
    return "ok";
  })()`),
);
await sleep(900);
await shot("meta-sources-confirm.png");

ws.close();
proc.kill();

// 清理：移除来源与测试目录
if (sourceId) {
  await fetch(`http://127.0.0.1:3000/api/metadata/sources/${sourceId}`, { method: "DELETE" }).catch(() => {});
}
rmSync(testRoot, { recursive: true, force: true });
console.log("cleaned up");
