/**
 * 截图：登录页 / 首次初始化页。
 * 运行：SHOT_BASE=http://127.0.0.1:6790 npx tsx scripts/shot-login.ts
 */
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:6790";
const OUT = process.env.SHOT_DIR || "data/shots";
const TAG = process.env.SHOT_TAG || "login";

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    // 本机有 http_proxy 环境变量，Chromium 会照单全收，把 127.0.0.1 也送进代理
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${TAG}-1.png` });
  console.log(`✓ ${OUT}/${TAG}-1.png`);

  // 输错一次，看错误提示条
  const user = page.locator('input[autocomplete="username"]');
  const pass = page.locator('input[autocomplete="current-password"], input[autocomplete="new-password"]').first();
  await user.fill("admin");
  await pass.fill("wrong-password");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${TAG}-2.png` });
  console.log(`✓ ${OUT}/${TAG}-2.png`);

  // 展开「忘记密码？」
  const forgot = page.getByRole("button", { name: "忘记密码？" });
  if (await forgot.count()) {
    await forgot.first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${TAG}-3.png` });
    console.log(`✓ ${OUT}/${TAG}-3.png`);
  }

  // 手机上只留表单
  await page.setViewportSize({ width: 430, height: 860 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${TAG}-4.png` });
  console.log(`✓ ${OUT}/${TAG}-4.png`);

  await browser.close();
}

void main();
