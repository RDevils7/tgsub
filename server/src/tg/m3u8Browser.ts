import type { Browser, Page, Response } from "playwright";
import { chromium } from "playwright";
import { logger } from "../logger";
import {
  refererOf,
  originOf,
  sanitizeName,
  titleFromUrl,
  type M3u8Target,
} from "./m3u8";
import { acquireProxyBridge } from "./proxyBridge";
import type { NetRoute } from "./netroute";

/**
 * 无头浏览器渲染页面、截获真实 m3u8 请求。详见文件顶部说明。
 * 浏览器启动所需的 chromium 单例复用；若未安装则降级为 null，不影响服务。
 */

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
/** 空闲多久后关闭浏览器（chromium 常驻约 150MB 内存，NAS 上不该一直占着） */
const IDLE_CLOSE_MS = 3 * 60 * 1000;
let idleTimer: NodeJS.Timeout | null = null;

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

/** 每次解析结束后重置空闲计时；超时无新任务就关掉浏览器释放内存 */
function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const p = browserPromise;
    browserPromise = null;
    if (!p) return;
    p.then((b) =>
      b.close().catch(() => {
        /* ignore */
      }),
    ).catch(() => {
      /* ignore */
    });
    logger.info("无头浏览器空闲超过 %d 分钟，已关闭", IDLE_CLOSE_MS / 60000);
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
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
    // 跳过广告倒计时：短视频站播放前常有 3~5 秒贴片广告，
    // 第一次点击会打在浮层上，必须在广告结束后再点一次才真的会起播
    const skipSelectors = ['[class*="skip" i]', '[class*="countdown" i]', '[class*="ad-skip" i]'];
    for (const sel of skipSelectors) {
      const el: any = doc?.querySelector(sel);
      if (el && el.offsetParent !== null) {
        try {
          el.click();
        } catch {
          /* ignore */
        }
      }
    }
    // 按文案找「跳过广告」按钮（CSS 没有按文本选中的写法，只能自己扫）
    const walk = doc?.querySelectorAll?.("button, a, span, div");
    if (walk) {
      for (const node of Array.from(walk as ArrayLike<any>)) {
        const text = String(node?.textContent ?? "").trim();
        if (!text || text.length > 12) continue;
        if (!/^(跳过|关闭广告|跳过广告|skip|skip ad)/i.test(text)) continue;
        if (node.offsetParent === null) continue;
        try {
          node.click();
          break;
        } catch {
          /* ignore */
        }
      }
    }
  };
  await page.evaluate(trigger).catch(() => {
    /* ignore */
  });
}

/**
 * 渲染页面并截获 m3u8 请求（单次尝试）。
 *
 * route=direct 时浏览器直连；route=proxy 时经代理。
 * 代理若是 SOCKS，这里通过本地桥转成 HTTP 代理给 Chromium
 * （Chromium 不支持 socks4，且 socks5 由浏览器本地解析域名）。
 */
async function resolveOnce(
  pageUrl: string,
  timeoutMs: number,
  route: NetRoute,
  proxy: string | undefined,
): Promise<M3u8Target | null> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch {
    return null;
  }

  let bridgeUrl: string | undefined;
  let releaseBridge: (() => void) | undefined;
  if (route === "proxy" && proxy) {
    try {
      const bridge = await acquireProxyBridge(proxy);
      bridgeUrl = bridge.url;
      releaseBridge = bridge.release;
    } catch (e) {
      logger.warn("准备浏览器代理失败: %s", String(e));
      return null;
    }
  }

  let context;
  try {
    context = await browser.newContext({
      userAgent: UA,
      acceptDownloads: false,
      // 让 navigator.webdriver 为 false，降低被站点识别为爬虫的概率
      viewport: { width: 1280, height: 720 },
      ...(bridgeUrl ? { proxy: { server: bridgeUrl } } : {}),
    });
  } catch (e) {
    releaseBridge?.();
    logger.warn("无头浏览器创建上下文失败: %s", String(e));
    return null;
  }
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
  } catch (e) {
    logger.warn("无头浏览器打开页面失败: %s", String(e));
  }

  // 等待播放器发出 m3u8 请求；master 优先，其次任意 m3u8。
  // 期间反复点播放：短视频站播放前常有贴片广告倒计时，
  // 只在开头点一次的话，click 会打在浮层上，播放器一直不起播。
  const deadline = Date.now() + timeoutMs;
  let lastTrigger = 0;
  while (Date.now() < deadline) {
    const hasMaster = candidates.some((u) => rank(u) >= 3);
    if (hasMaster || candidates.length >= 3) break;
    if (Date.now() - lastTrigger > 1500) {
      lastTrigger = Date.now();
      await tryTriggerPlay(page);
    }
    await page.waitForTimeout(400);
  }
  if (!candidates.some((u) => rank(u) >= 3)) {
    while (Date.now() < deadline && candidates.length === 0) {
      await page.waitForTimeout(400);
    }
  }

  // 在等待截获之后才取标题：SPA 往往等数据回来后才把真实标题写进 <title>，
  // 太早取会拿到空壳的初始 <title>。
  pageTitle = await page.title().catch(() => "");

  await context.close().catch(() => {
    /* ignore */
  });
  releaseBridge?.();

  if (!candidates.length) return null;

  candidates.sort((a, b) => rank(b) - rank(a));
  const chosen = candidates[0];

  return {
    m3u8Url: chosen,
    title: pageTitle ? sanitizeName(pageTitle) : titleFromUrl(pageUrl),
    referer: refererOf(pageUrl),
    origin: originOf(pageUrl),
    route,
  };
}

/**
 * 用无头浏览器解析出 m3u8 地址。返回 M3u8Target；拿不到返回 null。
 *
 * 外层包了重试：走代理时偶发 ERR_CONNECTION_CLOSED / ERR_TIMED_OUT 很常见
 * （代理抖动、站点限流），单次失败就报错体验很差，故失败后换新 context 再试一次。
 */
export async function resolveM3u8ViaBrowser(
  pageUrl: string,
  timeoutMs = 20000,
  route: NetRoute = "direct",
  proxy?: string,
): Promise<M3u8Target | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await resolveOnce(pageUrl, timeoutMs, route, proxy);
      if (r) return r;
      logger.warn("无头浏览器未捕获到 m3u8（第 %d 次尝试）", attempt);
    } catch (e) {
      logger.warn("无头浏览器解析异常（第 %d 次尝试）: %s", attempt, String(e));
    }
    scheduleIdleClose();
  }
  return null;
}
