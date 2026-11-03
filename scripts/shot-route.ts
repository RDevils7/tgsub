/**
 * 截图：下载列表（线路徽章）与设置页（网页/m3u8 线路配置）。
 * 运行：npx tsx scripts/shot-route.ts
 */
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://localhost:5173";
const OUT = process.env.SHOT_DIR || "data/shots";

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1500);
  // 侧边栏「下载记录」
  await page.getByText("下载记录", { exact: false }).first().click().catch(() => undefined);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/route-downloads.png`, fullPage: false });
  console.log(`✓ ${OUT}/route-downloads.png`);

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.getByText("设置", { exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(2000);
  // 展开「网络与代理」卡片
  const card = page.locator('text=网络与代理').first();
  if (await card.count()) {
    await card.click().catch(() => undefined);
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: `${OUT}/route-settings.png`, fullPage: false });
  console.log(`✓ ${OUT}/route-settings.png`);

  await browser.close();
}

void main();
