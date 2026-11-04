/**
 * 截图：概览页（浅色 / 暗色），顺带检查新面板是否都渲染出来、有没有控制台报错。
 * 运行：npx tsx scripts/shot-overview.ts
 */
import fs from "node:fs";
import { chromium } from "playwright";

for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
  delete process.env[key];
}

const BASE = process.env.SHOT_BASE || "http://localhost:5173";
const OUT = process.env.SHOT_DIR || "data/shots";

async function shoot(page: import("playwright").Page, theme: "light" | "dark") {
  await page.addInitScript((t) => window.localStorage.setItem("tgsub-theme", t), theme);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  // 等概览聚合接口回来（首次探测约 1 秒）
  await page.getByText("工具链", { exact: true }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(900);
  const expected = ["服务状态", "工具链", "存储与目录", "运行时", "Chromium（Playwright）", "复制诊断"];
  const missing: string[] = [];
  for (const text of expected) {
    if ((await page.getByText(text, { exact: false }).count()) === 0) missing.push(text);
  }
  await page.screenshot({ path: `${OUT}/overview-${theme}.png`, fullPage: true });
  const height = await page.evaluate(() => document.body.scrollHeight);
  console.log(`✓ overview-${theme}.png（页面高 ${height}px）${missing.length ? ` 缺失: ${missing.join(", ")}` : " 面板齐全"}`);
  return missing;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  const lightMissing = await shoot(page, "light");
  const darkMissing = await shoot(page, "dark");

  console.log(errors.length ? `控制台报错 ${errors.length} 条:\n${errors.slice(0, 6).join("\n")}` : "无控制台报错");
  await browser.close();
  process.exit(lightMissing.length || darkMissing.length || errors.length ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
