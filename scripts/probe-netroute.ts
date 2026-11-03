/**
 * 线路决策实测：直连优先 + SOCKS 桥 + 换线路回退。
 *
 * 运行：npx tsx scripts/probe-netroute.ts
 * 需要能连上代理（默认 socks5://192.168.5.2:7890，可用 M3U8_BROWSER_PROXY 覆盖）。
 */
import { httpRequest, parseProxy } from "../server/src/lib/netprobe";
import { acquireProxyBridge } from "../server/src/tg/proxyBridge";
import { isNetworkError, planRoutes } from "../server/src/tg/netroute";

const PROXY = process.env.M3U8_BROWSER_PROXY || "socks5://192.168.5.2:7890";
const TARGETS = ["https://www.google.com/generate_204", "https://api.github.com/"];

async function probe(label: string, url: string, proxyRaw: string | null): Promise<boolean> {
  try {
    const res = await httpRequest(url, {
      proxy: proxyRaw ? parseProxy(proxyRaw) : null,
      timeoutMs: 12_000,
      verifyTls: false,
      maxBody: 2048,
    });
    console.log(`  ${label} ${url} → HTTP ${res.status} · ${res.ms}ms · ${res.viaProxy ? "经代理" : "直连"}`);
    return res.status > 0;
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`  ${label} ${url} → 失败：${msg}${isNetworkError(msg) ? "（属网络类错误，可换线路）" : ""}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`代理：${PROXY}`);

  console.log("\n[1] 直连");
  for (const url of TARGETS) await probe("直连", url, null);

  console.log("\n[2] 经 SOCKS 代理（本地桥）");
  const bridge = await acquireProxyBridge(PROXY);
  console.log(`  桥地址：${bridge.url}`);
  try {
    for (const url of TARGETS) await probe("代理", url, bridge.url);
  } finally {
    bridge.release();
  }

  console.log("\n[3] 线路计划");
  console.log(`  auto + 有代理 → ${planRoutes("auto", true).join(" → ")}`);
  console.log(`  auto + 无代理 → ${planRoutes("auto", false).join(" → ")}`);
  console.log(`  always       → ${planRoutes("always", true).join(" → ")}`);
  console.log(`  off          → ${planRoutes("off", true).join(" → ")}`);
}

void main();
