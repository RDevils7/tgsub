/**
 * SOCKS 桥稳定性：连续 N 次「取桥 → HTTPS 请求 → 归还」，统计失败原因。
 * 运行：npx tsx scripts/probe-bridge.ts
 */
import { httpRequest, parseProxy } from "../server/src/lib/netprobe";
import { acquireProxyBridge } from "../server/src/tg/proxyBridge";

const PROXY = process.env.M3U8_BROWSER_PROXY || "socks5://192.168.5.2:7890";
const URL_ = process.env.PROBE_URL || "https://www.google.com/generate_204";
const N = Number(process.env.PROBE_N || 5);

async function main(): Promise<void> {
  console.log(`代理：${PROXY}`);
  console.log(`目标：${URL_}`);
  let ok = 0;
  for (let i = 1; i <= N; i += 1) {
    const bridge = await acquireProxyBridge(PROXY);
    try {
      const res = await httpRequest(URL_, {
        proxy: parseProxy(bridge.url),
        timeoutMs: 15_000,
        verifyTls: false,
        maxBody: 1024,
      });
      console.log(`  #${i} 桥 ${bridge.url} → HTTP ${res.status} · ${res.ms}ms`);
      ok += 1;
    } catch (err) {
      console.log(`  #${i} 桥 ${bridge.url} → 失败：${(err as Error).message}`);
    } finally {
      bridge.release();
    }
  }
  console.log(`\n成功 ${ok}/${N}`);
  process.exit(ok === N ? 0 : 1);
}

void main();
