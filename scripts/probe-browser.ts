/**
 * 无头浏览器逐条请求日志：看页面到底发了哪些请求、m3u8 在不在。
 * 运行：npx tsx scripts/probe-browser.ts
 */
import { chromium } from "playwright";
import { logger } from "../server/src/logger";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PAGE = process.env.M3U8_TEST_PAGE || "https://2048ai.vip/media/short-dramas/311/episodes/1";
const PROXY = process.env.M3U8_BROWSER_PROXY || "";

async function main(): Promise<void> {
  console.log(`页面：${PAGE}`);
  console.log(`代理：${PROXY || "（直连）"}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"],
  });
  console.log("Chromium 启动成功");

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    ...(PROXY ? { proxy: { server: PROXY } } : {}),
  });
  await context.addInitScript((): void => {
    const nav: any = (globalThis as any).navigator;
    if (nav) {
      try {
        Object.defineProperty(nav, "webdriver", { get: () => false });
      } catch {
        /* ignore */
      }
    }
  });
  const page = await context.newPage();

  const seen: string[] = [];
  page.on("response", (r) => {
    const ct = (r.headers()["content-type"] || "").toLowerCase();
    const u = r.url();
    if (/\.m3u8(\?|$)/i.test(u) || /mpegurl/i.test(ct)) {
      seen.push(`★ M3U8  ${u.slice(0, 140)}`);
    } else if (/\.ts(\?|$)|\.mp4(\?|$)|video|media/i.test(u)) {
      seen.push(`  MEDIA ${r.status()} ${u.slice(0, 140)}`);
    } else if (/api|\.json/i.test(u)) {
      seen.push(`  API   ${r.status()} ${u.slice(0, 140)}`);
    }
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") seen.push(`  ERR   ${msg.text().slice(0, 160)}`);
  });

  try {
    await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (e) {
    console.log(`打开页面失败：${String(e)}`);
  }
  await page.waitForTimeout(10_000);

  const trigger: any = () => {
    const doc: any = (globalThis as any).document;
    const v: any = doc?.querySelector("video");
    if (v) {
      try {
        v.muted = true;
        v.play?.();
      } catch {
        /* ignore */
      }
    }
    for (const sel of [".vjs-big-play-button", "button.play", '[aria-label*="play" i]', '[class*="play" i]']) {
      const el: any = doc?.querySelector(sel);
      if (el) {
        try {
          el.click();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  };
  await page.evaluate(trigger).catch(() => undefined);

  // 广告倒计时可能挡住真正播放：多等几轮，每轮都点一次播放
  const rounds = Number(process.env.PROBE_ROUNDS || 4);
  for (let i = 0; i < rounds; i += 1) {
    await page.waitForTimeout(8000);
    await page.evaluate(trigger).catch(() => undefined);
    const info = await page
      .evaluate(() => {
        const doc: any = (globalThis as any).document;
        const v: any = doc?.querySelector("video");
        return {
          hasVideo: Boolean(v),
          src: v?.currentSrc || v?.src || "",
          videos: doc?.querySelectorAll?.("video")?.length ?? 0,
          bodyLen: doc?.body?.innerText?.length ?? 0,
        };
      })
      .catch(() => ({ hasVideo: false, src: "", videos: 0, bodyLen: 0 }));
    console.log(`  第 ${i + 1} 轮：video 元素 ${info.videos} 个 · src=${info.src.slice(0, 90) || "（空）"}`);
  }

  console.log(`\n标题：${await page.title().catch(() => "?")}`);
  console.log("\n请求记录：");
  for (const line of seen.slice(0, 40)) console.log(`  ${line}`);
  if (!seen.length) console.log("  （没有捕获到任何请求）");

  await browser.close();
  logger.info("probe-browser 结束");
}

void main();
