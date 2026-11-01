/**
 * 登录状态监控：每 8 秒查一次 /api/auth/state，只在状态变化时打印。
 * 用法：node scripts/watch-auth.js [轮询次数]
 */
const times = Number(process.argv[2] || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

(async () => {
  let prev = "";
  for (let i = 0; i < times; i++) {
    try {
      const r = await fetch("http://127.0.0.1:6789/api/auth/state");
      const d = await r.json();
      const sig = `auth=${d.authorized} conn=${d.connected} user=${d.me ? d.me.id : "-"}`;
      if (sig !== prev) {
        console.log(`[${stamp()}] ${sig}  err=${d.error ?? "-"}`);
        prev = sig;
      }
    } catch (e) {
      console.log(`[${stamp()}] 请求失败: ${e.message}`);
    }
    await sleep(8000);
  }
  console.log("监控结束");
})();
