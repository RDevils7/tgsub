/**
 * 截图：手动下载页底部的「提交记录」。
 * 运行：npx tsx scripts/shot-history.ts
 */
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://localhost:5173";
const OUT = process.env.SHOT_DIR || "data/shots";

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.getByText("手动下载", { exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `${OUT}/manual-history.png`, fullPage: true });
  console.log(`✓ ${OUT}/manual-history.png`);

  // 只看失败
  await page.getByRole("button", { name: "失败", exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/manual-history-fail.png`, fullPage: false });
  console.log(`✓ ${OUT}/manual-history-fail.png`);

  // 回到全部，悬停一行看「再提交 / 删除」按钮
  await page.getByRole("button", { name: "全部", exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(1000);
  const row = page.locator("section", { hasText: "提交记录" }).first().locator("div.group").first();
  if (await row.count()) {
    await row.hover().catch(() => undefined);
    await page.waitForTimeout(400);
    await page.locator("section", { hasText: "提交记录" }).first().screenshot({ path: `${OUT}/manual-history-hover.png` });
    console.log(`✓ ${OUT}/manual-history-hover.png`);
  }

  // 清空确认弹窗（注意页面上有两个「清空」，要限定在提交记录卡片里点）
  const card = page.locator("section", { hasText: "提交记录" }).first();
  await card.getByRole("button", { name: /清空/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/manual-history-clear.png`, fullPage: false });
  console.log(`✓ ${OUT}/manual-history-clear.png`);

  // 关掉弹窗，切深色主题再看一遍徽章对比度
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /切换到暗色主题/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(900);
  await card.screenshot({ path: `${OUT}/manual-history-dark.png` });
  console.log(`✓ ${OUT}/manual-history-dark.png`);

  await browser.close();
  process.exit(0);
}

void main();
