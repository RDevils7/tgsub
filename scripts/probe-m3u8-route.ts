/**
 * 网页 / m3u8 端到端实测：直连优先、换线路回退、ffmpeg 不误用环境代理。
 *
 * 运行：npx tsx scripts/probe-m3u8-route.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveM3u8Input, pickProxy, plannedRoutes } from "../server/src/tg/m3u8";
import { httpRequest, parseProxy } from "../server/src/lib/netprobe";
import { acquireProxyBridge } from "../server/src/tg/proxyBridge";
import { downloadM3u8To } from "../server/src/tg/m3u8";

/** 之前实测过的站点：SPA 空壳页，m3u8 由 JS 调签名接口拿到 */
const PAGE = process.env.M3U8_TEST_PAGE || "https://2048ai.vip/";

async function probeRoute(label: string, url: string, route: "direct" | "proxy"): Promise<boolean> {
  try {
    const proxy = route === "proxy" ? pickProxy() : undefined;
    const parsed = route === "proxy" && proxy ? parseProxy(proxy) : null;
    const res = await httpRequest(url, {
      proxy: parsed,
      timeoutMs: 12_000,
      verifyTls: false,
      maxBody: 4096,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    });
    console.log(`  ${label} → HTTP ${res.status} · ${res.ms}ms`);
    return res.status > 0;
  } catch (err) {
    console.log(`  ${label} → 失败：${(err as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`页面：${PAGE}`);
  console.log(`代理：${pickProxy() ?? "（无）"}`);
  console.log(`计划线路：${plannedRoutes(PAGE).join(" → ")}`);

  console.log("\n[1] 站点连通性（两种线路各试一次）");
  await probeRoute("直连", PAGE, "direct");
  await probeRoute("代理", PAGE, "proxy");

  console.log("\n[2] 解析（走完整策略：直连优先，不通回退代理）");
  const directM3u8 = process.env.M3U8_TEST_M3U8 || "";
  const target = directM3u8
    ? await resolveM3u8Input(directM3u8)
    : await resolveM3u8Input(PAGE);
  console.log(`  m3u8：${target.m3u8Url.slice(0, 110)}`);
  console.log(`  标题：${target.title}`);
  console.log(`  线路：${target.route}`);
  console.log(`  Referer：${target.referer}`);

  console.log("\n[3] 下载（只跑 12 秒，看线路与字节数）");
  const timeoutSec = Number(process.env.M3U8_TEST_TIMEOUT || 12);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgsub-route-"));
  const outFile = path.join(outDir, "test.mp4");
  const routes = plannedRoutes(target.m3u8Url);
  for (const route of routes) {
    console.log(`  试 ${route} …`);
    try {
      await downloadM3u8To(target.m3u8Url, outFile, {
        referer: target.referer,
        origin: target.origin,
        route,
        proxy: pickProxy(),
        signal: AbortSignal.timeout(timeoutSec * 1000),
      });
      const size = fs.statSync(outFile).size;
      console.log(`  ✓ ${route} 下载完成：${(size / 1024 / 1024).toFixed(2)} MB`);
      break;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "下载已取消") {
        console.log(`  … ${route} 被超时中断（说明下载链路是通的）`);
        break;
      }
      console.log(`  ✗ ${route} 失败：${msg}`);
    }
  }
  fs.rmSync(outDir, { recursive: true, force: true });

  console.log("\n[4] SOCKS 桥自检（ffmpeg 走桥需要它）");
  const proxy = pickProxy();
  if (proxy) {
    const bridge = await acquireProxyBridge(proxy);
    try {
      const res = await httpRequest("https://www.google.com/generate_204", {
        proxy: parseProxy(bridge.url),
        timeoutMs: 12_000,
        verifyTls: false,
        maxBody: 1024,
      });
      console.log(`  桥 ${bridge.url} → HTTP ${res.status}`);
    } finally {
      bridge.release();
    }
  }
}

void main();
