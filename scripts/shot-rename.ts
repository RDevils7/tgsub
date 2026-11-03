/**
 * 截图：剧集详情的「重命名文件」对话框。
 * 运行：npx tsx scripts/shot-rename.ts
 */
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://localhost:5173";
const OUT = process.env.SHOT_DIR || "data/shots";

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.getByText("元数据", { exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(2500);
  // 选中第一个剧集目录（点文件夹名字那行）
  await page.locator("ul > li >> nth=0").getByText(/个视频/).first().click().catch(() => undefined);
  await page.waitForTimeout(1500);

  const btn = page.getByText("重命名文件", { exact: true }).first();
  console.log("  重命名按钮存在:", await btn.count());
  if (await btn.count()) {
    await btn.click().catch(() => undefined);
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `${OUT}/meta-rename-dialog.png`, fullPage: false });
    console.log(`✓ ${OUT}/meta-rename-dialog.png`);
  }
  await browser.close();
  process.exit(0);
}

void main();
