/**
 * 截图：设置页「第三方平台」里的 yt-dlp 定时检查（每 N 天）。
 * 运行：npx tsx scripts/shot-days.ts
 */
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://localhost:5173";
const OUT = process.env.SHOT_DIR || "data/shots";

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.getByText("设置", { exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(2000);

  // 展开「第三方平台」卡片
  const card = page.locator("text=第三方平台").first();
  if (await card.count()) {
    await card.click().catch(() => undefined);
    await page.waitForTimeout(1800);
  }

  // 把「定时检查并自动更新」那一行滚进视口
  const row = page.locator("text=定时检查并自动更新").first();
  if (await row.count()) {
    await row.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(600);
  }

  await page.screenshot({ path: `${OUT}/ytdlp-days.png`, fullPage: false });
  console.log(`✓ ${OUT}/ytdlp-days.png`);

  // 顺便把输入框的值与单位读出来，避免只看图漏判
  const info = await page.evaluate((): unknown => {
    const doc: any = (globalThis as any).document;
    const label = [...doc.querySelectorAll("label")].find((l: any) =>
      String(l.textContent || "").includes("定时检查并自动更新"),
    );
    if (!label) return { found: false };
    const input = label.parentElement?.querySelector('input[type="number"]');
    return {
      found: true,
      value: input?.value ?? null,
      text: String(label.parentElement?.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
  console.log("  输入框:", JSON.stringify(info));

  await browser.close();
  process.exit(0);
}

void main();
