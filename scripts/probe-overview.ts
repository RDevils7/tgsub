/**
 * 概览聚合接口的本机诊断：不启 HTTP 服务，直接调采集层看结果。
 * 用法：npx tsx scripts/probe-overview.ts
 */
import { getOverview } from "../server/src/system/overview";

async function main() {
  console.log("开始采集…");
  const r = await getOverview(true);
  console.log("耗时", r.elapsedMs, "ms；汇总", JSON.stringify(r.summary));
  console.log("运行时", r.runtime.version, r.runtime.node, "容器:", r.runtime.inContainer);
  console.log("磁盘", JSON.stringify(r.storage.disk));
  console.log("目录", r.storage.dirs.map((d) => `${d.label}:${d.exists}/${d.writable}`).join(" | "));
  console.log("--- 工具 ---");
  for (const t of r.tools) {
    console.log(t.id.padEnd(10), t.status.padEnd(5), String(t.version).slice(0, 40).padEnd(42), String(t.path).slice(0, 78));
  }
  console.log("--- 服务 ---");
  for (const s of r.services) {
    console.log(s.id.padEnd(10), s.status.padEnd(5), s.value.padEnd(24), s.note ?? "");
  }
  process.exit(0);
}

void main().catch((err) => {
  console.error("采集失败", err);
  process.exit(1);
});
