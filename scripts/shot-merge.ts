/**
 * 截图：元数据页的「勾选合并」与「剧集改名」入口。
 * 运行：npx tsx scripts/shot-merge.ts
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
  await page.getByText("元数据", { exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(2500);

  // 展开第一个文件夹
  const chevron = page.locator('button[title="展开文件"]').first();
  if (await chevron.count()) {
    await chevron.click().catch(() => undefined);
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: `${OUT}/meta-list.png`, fullPage: false });
  console.log(`✓ ${OUT}/meta-list.png`);

  // 勾选两个视频，看底部操作条
  const boxes = page.locator('input[type="checkbox"][aria-label^="选择"]');
  const n = await boxes.count();
  console.log(`  找到 ${n} 个可勾选项`);
  for (let i = 0; i < Math.min(2, n); i += 1) {
    await boxes.nth(i).check({ force: true }).catch(() => undefined);
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/meta-checked.png`, fullPage: false });
  console.log(`✓ ${OUT}/meta-checked.png`);

  // 打开合并对话框
  const mergeBtn = page.getByText("合并为剧集", { exact: true }).first();
  if (await mergeBtn.count()) {
    await mergeBtn.click().catch(() => undefined);
    await page.waitForTimeout(800);
    const input = page.locator('input[placeholder*="我的妈妈"]').first();
    if (await input.count()) {
      await input.fill("界面测试剧");
      await page.waitForTimeout(2200);
    }
    await page.screenshot({ path: `${OUT}/meta-merge-dialog.png`, fullPage: false });
    console.log(`✓ ${OUT}/meta-merge-dialog.png`);
  } else {
    console.log("  ✗ 没找到「合并为剧集」按钮");
  }

  await browser.close();
  process.exit(0);
}

void main();
