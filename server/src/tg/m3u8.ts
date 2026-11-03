import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpegInfo } from "./ffmpeg";
import { logger } from "../logger";
import { getSettings } from "../db";
import { httpRequest, parseProxy } from "../lib/netprobe";
import { resolveM3u8ViaBrowser } from "./m3u8Browser";
import { acquireProxyBridge } from "./proxyBridge";
import {
  forgetDirectFailure,
  isNetworkError,
  orderRoutes,
  pickProxyFrom,
  planRoutes,
  rememberDirectFailure,
  rememberRoute,
  type NetRoute,
  type RouteMode,
} from "./netroute";

/**
 * 网页 / m3u8 视频下载。
 *
 * 输入两种：
 *  - 直接的 m3u8 链接（`*.m3u8`）
 *  - 普通网页链接：抓取 HTML，从 `<video>` / `<source>` / JS 变量里挑出 m3u8 地址，
 *    挑不到再试几个常见播放器路径（playlist/index/live.m3u8）
 *
 * 下载统一走 ffmpeg（镜像里自带）：`ffmpeg -i <m3u8> -c copy out.mp4`。
 * AES-128 加密的 m3u8 ffmpeg 会自己拿 key（只要能访问 key URL），无需额外处理。
 * 防盗链：请求时自动带源站 Referer + 浏览器 UA，过大多数裸防盗链。
 *
 * 网络线路（1.3.0 起）：
 *   默认「直连优先」——先直连，直连不通（超时 / DNS 失败 / 连不上）才回退代理，
 *   并把这次实际走的线路记到 downloads.net_route，界面上能看到。
 *   代理地址来自设置项 m3u8_proxy，未设则回落 M3U8_BROWSER_PROXY / HTTPS_PROXY / HTTP_PROXY。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface M3u8Target {
  /** 解析后真正要喂给 ffmpeg 的 m3u8 地址 */
  m3u8Url: string;
  /** 给文件 / 目录用的标题（已清洗，安全用于路径） */
  title: string;
  /** 防盗链 Referer（源站根） */
  referer: string;
  /** 防盗链 Origin */
  origin: string;
  /** 解析阶段实际走通的线路 */
  route: NetRoute;
}

/** 是否看起来就是个 m3u8 链接 */
export function looksLikeM3u8(input: string): boolean {
  return /\.m3u8(\?[^ "'`)\s]*)?$/i.test(input.trim());
}

/** 是否是一个 http(s) 链接 */
export function isHttpUrl(input: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(input.trim());
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function refererOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return "";
  }
}

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/** 把任意字符串清洗成能安全进文件路径的名字 */
export function sanitizeName(s: string): string {
  const cleaned = String(s ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .trim();
  return cleaned.slice(0, 80) || "video";
}

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "video");
    const base = last.replace(/\.m3u8.*$/i, "").replace(/\.[^.]+$/, "") || "video";
    return sanitizeName(base);
  } catch {
    return "video";
  }
}

function titleFromHtml(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1].replace(/\s*[-–|·].*$/, "").trim();
  return sanitizeName(t) || null;
}

/* ------------------------------------------------------------------ */
/* 线路：代理从哪来、按什么顺序试                                       */
/* ------------------------------------------------------------------ */

/**
 * 解析出网页 / m3u8 下载链路要用的代理地址（无头浏览器与 ffmpeg 共用）。
 *
 * 优先级：设置项 m3u8_proxy → 环境变量 M3U8_BROWSER_PROXY → HTTPS_PROXY → HTTP_PROXY。
 * 自动跳过 127.0.0.1 / localhost / ::1 —— 这类是 WorkBuddy 等工具的内部代理，
 * 指向它们会让外网视频站访问失败，必须排除。返回 undefined 表示没有代理可用。
 */
export function pickProxy(): string | undefined {
  let setting = "";
  try {
    setting = getSettings().m3u8_proxy ?? "";
  } catch {
    setting = "";
  }
  return pickProxyFrom([
    setting,
    process.env.M3U8_BROWSER_PROXY,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]);
}

/** 当前的线路策略（auto=直连优先 / always=强制代理 / off=只直连） */
export function routeMode(): RouteMode {
  try {
    const mode = getSettings().m3u8_proxy_mode;
    return mode === "always" || mode === "off" ? mode : "auto";
  } catch {
    return "auto";
  }
}

/**
 * 按设置排出该按什么顺序试线路。
 * auto 下就是「直连 → 代理」，即「能不用代理的地方尽量直连」。
 */
export function plannedRoutes(url: string): NetRoute[] {
  const proxy = pickProxy();
  const routes = planRoutes(routeMode(), Boolean(proxy));
  return orderRoutes(routes, hostOf(url));
}

/* ------------------------------------------------------------------ */
/* 网页抓取                                                             */
/* ------------------------------------------------------------------ */

/** 从网页 HTML 里挑出 m3u8 地址（已把相对路径解析成绝对地址） */
function extractM3u8FromHtml(html: string, pageUrl: string): string | null {
  const found: string[] = [];

  const push = (candidate: string): void => {
    if (/\.m3u8(\?[^ "'`)\s]*)?$/i.test(candidate)) found.push(candidate);
  };

  // 1) "https://...m3u8" 或 'https://...m3u8'
  const re1 = /(["'`])(https?:\/\/[^"'`\s]+?\.m3u8(?:\?[^"'`\s]*)?)\1/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re1.exec(html))) push(mm[2]);

  // 2) //host/path.m3u8（协议相对）
  const re2 = /(["'`])\/\/([^"'`\s]+?\.m3u8(?:\?[^"'`\s]*)?)\1/gi;
  while ((mm = re2.exec(html))) {
    try {
      push(new URL(`https:${mm[1]}${mm[2]}`).toString());
    } catch {
      /* ignore */
    }
  }

  // 3) 裸 m3u8 片段（无引号包裹）
  const re3 = /https?:\/\/[^\s"'`)<>]+?\.m3u8(?:\?[^"'`\s<>]*)?/gi;
  while ((mm = re3.exec(html))) push(mm[0]);

  if (!found.length) return null;

  // 优先选看起来像主播放列表的（含 master/playlist/index/live/hls）
  const ranked = found
    .map((c) => ({ c, score: /(master|playlist|index|live|hls|\.m3u8$)/i.test(c) ? 2 : 1 }))
    .sort((a, b) => b.score - a.score);

  try {
    return new URL(ranked[0].c, pageUrl).toString();
  } catch {
    return ranked[0].c;
  }
}

/** 兜底：基于页面 URL 试几个常见播放器路径 */
function guessPlaylistUrls(pageUrl: string): string[] {
  try {
    const u = new URL(pageUrl);
    const base = `${u.protocol}//${u.host}${u.pathname.replace(/[^/]*$/, "")}`;
    return [
      new URL("playlist.m3u8", base).toString(),
      new URL("index.m3u8", base).toString(),
      new URL("live.m3u8", base).toString(),
      new URL("hls.m3u8", base).toString(),
    ];
  } catch {
    return [];
  }
}

/**
 * 按指定线路抓一个 URL 的正文（跟随重定向）。
 * 直连时 proxy 传 null；走代理时传 parseProxy 后的结果。
 */
async function requestText(
  rawUrl: string,
  opts: { route: NetRoute; proxy?: string; referer?: string; timeoutMs?: number; maxBody?: number },
): Promise<string> {
  const parsed = opts.route === "proxy" && opts.proxy ? parseProxy(opts.proxy) : null;
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await httpRequest(current, {
      proxy: parsed,
      timeoutMs: opts.timeoutMs ?? 15_000,
      // 抓的是公开视频站，不涉密；关掉证书校验以兼容中间人代理
      verifyTls: false,
      maxBody: opts.maxBody ?? 4 * 1024 * 1024,
      userAgent: UA,
      headers: opts.referer ? { Referer: opts.referer } : undefined,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`抓取失败：HTTP ${res.status}`);
    }
    return res.body;
  }
  throw new Error("重定向次数过多，已放弃");
}

/** 探测一个地址是不是真的 m3u8（能拿到正文且含 #EXTM3U） */
async function probeM3u8(url: string, route: NetRoute, proxy?: string): Promise<boolean> {
  try {
    const text = await requestText(url, { route, proxy, referer: refererOf(url), timeoutMs: 10_000, maxBody: 256 * 1024 });
    return /#EXTM3U/i.test(text);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 解析入口                                                             */
/* ------------------------------------------------------------------ */

/** 用指定线路解析一个网页链接 */
async function resolveViaRoute(
  pageUrl: string,
  route: NetRoute,
  proxy: string | undefined,
): Promise<M3u8Target> {
  const html = await requestText(pageUrl, { route, proxy });
  let found = extractM3u8FromHtml(html, pageUrl);
  if (!found) {
    for (const guess of guessPlaylistUrls(pageUrl)) {
      if (await probeM3u8(guess, route, proxy)) {
        found = guess;
        break;
      }
    }
  }
  if (!found) {
    // 静态解析失败：这类站很可能是 SPA / JS 动态加载 / 签名接口，
    // 用无头浏览器把页面跑起来、截获真实 m3u8 请求再试一次。
    try {
      // 短视频站的播放器要等贴片广告倒计时结束才起播，给足 30 秒
      const viaBrowser = await resolveM3u8ViaBrowser(pageUrl, 30_000, route, proxy);
      if (viaBrowser) {
        return {
          m3u8Url: viaBrowser.m3u8Url,
          title: viaBrowser.title || titleFromHtml(html) || titleFromUrl(pageUrl),
          referer: viaBrowser.referer,
          origin: viaBrowser.origin,
          route,
        };
      }
    } catch (e) {
      logger.warn("无头浏览器解析 m3u8 失败: %s", String(e));
    }
  }
  if (!found) {
    throw new Error(
      "没能从网页里解析出 m3u8 视频地址（已尝试无头浏览器渲染页面，仍未能捕获播放请求；" +
        "该站可能用了加密、签名接口，或需要登录才能看。可改用浏览器 F12 → Network → 过滤 .m3u8 → 复制直链粘贴）",
    );
  }
  return {
    m3u8Url: found,
    title: titleFromHtml(html) || titleFromUrl(found),
    referer: refererOf(pageUrl),
    origin: originOf(pageUrl),
    route,
  };
}

/**
 * 把用户输入（直接 m3u8 或网页链接）解析成真正要下载的 m3u8 地址 + 标题 + 防盗链信息。
 *
 * 线路：默认直连优先。直连抓不到（网络类错误）才换代理重试；
 * 403 / 签名失效这类换线路也没用的错误直接抛出，不浪费时间。
 */
export async function resolveM3u8Input(input: string): Promise<M3u8Target> {
  const url = input.trim();
  if (looksLikeM3u8(url)) {
    return {
      m3u8Url: url,
      title: titleFromUrl(url),
      referer: refererOf(url),
      origin: originOf(url),
      route: "direct",
    };
  }

  if (!isHttpUrl(url)) {
    throw new Error("只支持 m3u8 链接或网页链接（http/https 开头）");
  }

  const proxy = pickProxy();
  const routes = orderRoutes(planRoutes(routeMode(), Boolean(proxy)), hostOf(url));
  let lastError: Error | null = null;

  for (const route of routes) {
    try {
      const target = await resolveViaRoute(url, route, proxy);
      rememberRoute(hostOf(url), route);
      if (route === "direct") forgetDirectFailure(hostOf(url));
      return target;
    } catch (err) {
      lastError = err as Error;
      const message = lastError?.message ?? String(err);
      if (!isNetworkError(message)) throw lastError;
      logger.warn("按 %s 线路解析失败，尝试换线路: %s", route, message);
      if (route === "direct") rememberDirectFailure(hostOf(url));
    }
  }
  throw lastError ?? new Error("解析失败");
}

export interface M3u8DownloadOpts {
  referer?: string;
  origin?: string;
  signal?: AbortSignal;
  /** 进度回调：pct 0~99（无总时长时为 0），downloadedBytes 为当前输出文件字节数 */
  onProgress?: (pct: number, downloadedBytes: number) => void;
  /** 本次走哪条线路（默认直连） */
  route?: NetRoute;
  /** 代理地址；route=proxy 时必填 */
  proxy?: string;
}

/**
 * 用 ffmpeg 把 m3u8 下载并封装为 mp4。
 *
 * 先写系统临时目录下的 ASCII 临时文件，成功再 rename 到最终路径
 * （ffmpeg 的 Windows 静态版打不开含中文的输出路径）。
 */
export async function downloadM3u8To(
  m3u8Url: string,
  outFile: string,
  opts: M3u8DownloadOpts = {},
): Promise<string> {
  const info = await ffmpegInfo();
  if (!info.available || !info.ffmpeg) {
    throw new Error(
      "镜像里没有可用的 ffmpeg，无法下载 m3u8：确认用官方镜像（内置 ffmpeg），或在设置里填写 ffmpeg 路径",
    );
  }
  const ffmpegPath = info.ffmpeg;

  // ffmpeg 的 Windows 静态版无法打开含非 ASCII（中文）字符的输出路径，会报
  // “Invalid argument”。所以让 ffmpeg 先写到系统临时目录下的 ASCII 文件名，
  // 下载完成后再 rename 到最终（可能含中文）路径；node 的 rename 处理 Unicode 没问题。
  // 跨卷 rename 会失败，故失败时回退为 copy + 删源。
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const tmpPart = path.join(
    os.tmpdir(),
    `tgsub-m3u8-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`,
  );

  const headers = [`User-Agent: ${UA}`, `Referer: ${opts.referer ?? refererOf(m3u8Url)}`];
  if (opts.origin) headers.push(`Origin: ${opts.origin}`);

  const args = [
    "-headers",
    headers.join("\r\n"),
    "-i",
    m3u8Url,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-f",
    "mp4",
    "-y",
    tmpPart,
  ];

  const cleanupTmp = (): void => {
    fs.promises.unlink(tmpPart).catch(() => {
      /* ignore */
    });
  };

  // 线路：直连时必须清掉环境里的代理变量（ffmpeg 会读 http_proxy / https_proxy），
  // 否则「直连优先」根本直连不了。走代理时，SOCKS 通过本地桥转成 HTTP 代理给 ffmpeg。
  const route = opts.route ?? "direct";
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    delete env[key];
  }
  let releaseBridge: (() => void) | undefined;
  if (route === "proxy" && opts.proxy) {
    const bridge = await acquireProxyBridge(opts.proxy);
    releaseBridge = bridge.release;
    env.http_proxy = bridge.url;
    env.https_proxy = bridge.url;
    env.HTTP_PROXY = bridge.url;
    env.HTTPS_PROXY = bridge.url;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true, env });
      let total = 0;
      let stderr = "";

      const onAbort = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort);
      }

      child.stderr?.on("data", (buf: Buffer) => {
        const line = buf.toString();
        stderr += line;
        const dur = /Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/.exec(line);
        if (dur && !total) {
          total = +dur[1] * 3600 + +dur[2] * 60 + +dur[3] + (+(dur[4] ?? 0)) / 100;
        }
        const tm = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
        if (tm && opts.onProgress) {
          const cur = +tm[1] * 3600 + +tm[2] * 60 + +tm[3];
          const pct = total > 0 ? Math.min(99, Math.round((cur / total) * 100)) : 0;
          let bytes = 0;
          try {
            bytes = fs.statSync(tmpPart).size;
          } catch {
            /* ignore */
          }
          opts.onProgress(pct, bytes);
        }
      });

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        if (code === 0) resolve();
        // 被用户停掉时 stderr 里只有一堆进度行，别拿它当错误原因
        else if (opts.signal?.aborted) reject(new Error("下载已取消"));
        else reject(new Error(parseFfmpegError(stderr)));
      });
    });
  } catch (err) {
    cleanupTmp();
    throw err;
  } finally {
    releaseBridge?.();
  }

  // ffmpeg 成功：把临时文件挪到最终路径（跨卷回退 copy）
  try {
    await fs.promises.rename(tmpPart, outFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      await fs.promises.copyFile(tmpPart, outFile);
      cleanupTmp();
    } else {
      cleanupTmp();
      throw e;
    }
  }
  return outFile;
}

function parseFfmpegError(stderr: string): string {
  if (/403|Forbidden/i.test(stderr)) return "下载被拒绝（403），可能是防盗链/签名失效，试试带 Cookie 或换源";
  if (/404|Not Found/i.test(stderr)) return "视频地址已失效（404），源站可能已删除，或这是过期的临时链接";
  if (/Connection|timed out|ECONN|resolve|No route to host/i.test(stderr))
    return "网络拉取失败，确认服务器能访问该地址（必要时配置代理）";
  if (/Invalid data found|moov atom|Server returned 4|Server returned 5/i.test(stderr))
    return "无法解析该 m3u8（可能是加密 / 非常规格式 / 源站返回错误）";
  // ffmpeg 的日志里大量是「Opening '...' for reading」这类分片信息，
  // 直接取最后一行会得到一句看不懂的话；优先挑真正像报错的行。
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = lines.find(
    (line) =>
      /error|failed|invalid|refused|denied|forbidden|not found|timed out|unable/i.test(line) &&
      !/Opening .* for reading/i.test(line),
  );
  if (errorLine) return errorLine.slice(0, 300);
  return (lines[lines.length - 1] ?? "").slice(0, 300) || "ffmpeg 退出异常";
}
