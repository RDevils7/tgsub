import type { Browser, Page, Response } from "playwright";
import { chromium } from "playwright";
import { logger } from "../logger";
import { refererOf, originOf, titleFromUrl, type M3u8Target } from "./m3u8";

/**
 * 用无头浏览器渲染页面、截获真实 m3u8 请求。
 *
 * 适用场景：SPA / JS 动态加载 / 签名接口的视频站——这类站点的 m3u8 不在静态 HTML 里，
 * 而是由页面 JS 向带签名的 API 请求得来（很多还走 hls.js 把 manifest 喂给 MSE）。
 * 纯抓 HTML 解析不到，只能把页面真正跑起来、监听网络请求才能拿到地址。
 *
 * 注意：本模块只负责「解析出 m3u8 地址」，真正的下载仍交给 downloadM3u8To（ffmpeg）。
 * 浏览器单例复用：首次启动 chromium，之后每个请求只开 context/page，降低开销。
 * 若 chromium 未安装（本地没跑 `playwright install chromium`），launch 会失败并降级为 null，
 * 由上层回退到原来的报错文案，不会让服务崩溃。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let browserPromise: Promise<Browser> | null = null;
let browserDisabled = false;

async function getBrowser(): Promise<Browser> {
  if (browserDisabled) throw new Error("headless browser 已禁用（上次启动失败）");
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
        ],
      })
      .catch((e) => {
        browserPromise = null;
        browserDisabled = true;
        logger.warn("无头浏览器启动失败（chromium 未安装？）: %s", String(e));
        throw e;
      });
  }
  return browserPromise;
}

function isM3u8Response(url: string, contentType: string): boolean {
  if (/\.m3u8(\?[^"'\s]*)?$/i.test(url)) return true;
  return /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i.test(contentType);
}

/** 给候选地址打分：优先 master / playlist / index / hls，避开 segment / chunk / ts */
function rank(url: string): number {
  const u = url.toLowerCase();
  if (/(segment|chunk|\/ts\/|\.ts(?:\?|$))/i.test(u)) return 0;
  if (/(master|playlist|index|hls|\.m3u8$)/i.test(u)) return 3;
  return 1;
}

async function tryTriggerPlay(page: Page): Promise<void> {
  // evaluate 的回调在浏览器里运行，但 server 的 tsconfig 不带 DOM 库，
  // 故把函数整体标注为 any，避免 document / HTMLElement 类型报错（运行时无影响）。
  const trigger: any = () => {
    const doc: any = (globalThis as any).document;
    const v: any = doc?.querySelector("video");
    if (v) {
      try {
        v.muted = true;
        if (typeof v.play === "function") v.play();
      } catch {
        /* ignore */
      }
    }
    // 点一下常见的大播放按钮，触发懒加载的播放器
    const playSelectors = [
      ".vjs-big-play-button",
      "button.play",
      '[aria-label*="play" i]',
      '[class*="play" i]',
    ];
    for (const sel of playSelectors) {
      const el: any = doc?.querySelector(sel);
      if (el && el.offsetParent !== null) {
        try {
          el.click();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  };
  await page.evaluate(trigger).catch(() => {
    /* ignore */
  });
}

/**
 * 渲染页面并截获 m3u8 请求。返回 M3u8Target；拿不到返回 null。
 */
export async function resolveM3u8ViaBrowser(
  pageUrl: string,
  timeoutMs = 20000,
): Promise<M3u8Target | null> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch {
    return null;
  }

  const context = await browser.newContext({
    userAgent: UA,
    acceptDownloads: false,
    // 让 navigator.webdriver 为 false，降低被站点识别为爬虫的概率
    viewport: { width: 1280, height: 720 },
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
  const candidates: string[] = [];
  const seen = new Set<string>();

  const onResponse = (response: Response): void => {
    const url = response.url();
    if (seen.has(url)) return;
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    if (isM3u8Response(url, ct)) {
      seen.add(url);
      candidates.push(url);
    }
  };
  page.on("response", onResponse);

  let pageTitle = "";
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    pageTitle = await page.title().catch(() => "");
  } catch (e) {
    logger.warn("无头浏览器打开页面失败: %s", String(e));
  }

  await tryTriggerPlay(page);

  // 等待播放器发出 m3u8 请求；master 优先，其次任意 m3u8
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hasMaster = candidates.some((u) => rank(u) >= 3);
    if (hasMaster || candidates.length >= 3) break;
    await page.waitForTimeout(400);
  }
  if (!candidates.some((u) => rank(u) >= 3)) {
    while (Date.now() < deadline && candidates.length === 0) {
      await page.waitForTimeout(400);
    }
  }

  await context.close().catch(() => {
    /* ignore */
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => rank(b) - rank(a));
  const chosen = candidates[0];

  return {
    m3u8Url: chosen,
    title: titleFromUrl(pageTitle || pageUrl),
    referer: refererOf(pageUrl),
    origin: originOf(pageUrl),
  };
}
