import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Request, Response } from "express";
import { logger } from "../logger";
import { isPrivateHost, parseStrmTarget } from "./mediapath";

/**
 * strm 播放：把文件里那一行直链当成上游，服务端做一次**流式转发**。
 *
 * 为什么不让浏览器直接拉那个地址：
 *  - 常见是 http 的局域网地址（如 http://192.168.5.2:12366/...），https 页面下会被混合内容拦掉；
 *  - 播放器的「截图 / 设为封面」要 canvas.drawImage，跨域会污染画布；
 *  - 转发后同源，浏览器照常发 Range，我们把 206 原样送回，拖进度条与跳秒都能用。
 *
 * 硬约束：**只有用户真正点播放才会走到这里**。列表、详情、缩略图一律不碰上游，
 * 连 HEAD 都不发 —— 批量读取是最容易触发网盘风控的行为。
 *
 * 这里一律直连（不挂全局 m3u8_proxy）：局域网播放代理本来就在内网，
 * 塞进公网代理反而连不上；它自己去回源，风控面收敛在这一层。
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_HOPS = 5;
const TIMEOUT_MS = 15_000;
/** 上游 403/429 之后按主机熔断，别靠自动重试把账号继续往风控上推 */
const BREAKER_MS = 10 * 60_000;
const breakers = new Map<string, number>();

function breakerActive(host: string): boolean {
  const until = breakers.get(host) ?? 0;
  if (until <= Date.now()) {
    if (until) breakers.delete(host);
    return false;
  }
  return true;
}

function tripBreaker(host: string): void {
  breakers.set(host, Date.now() + BREAKER_MS);
  logger.warn({ host, minutes: BREAKER_MS / 60_000 }, "strm 上游拒绝访问，按主机熔断，期间不再发起请求");
}

function mimeOf(url: URL, upstream: string | undefined): string {
  if (upstream && /^video\//i.test(upstream)) return upstream;
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mkv: "video/x-matroska",
    ts: "video/mp2t",
    mov: "video/quicktime",
    m3u8: "application/vnd.apple.mpegurl",
  };
  return (ext && byExt[ext]) || upstream || "video/mp4";
}

function fail(res: Response, status: number, error: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ ok: false, error });
}

/**
 * 转发一跳。上游 302 时带着原来的 Range 再跟一次（播放代理常跳到真实 CDN），
 * 只把最终那一跳的响应头与数据流交给浏览器。
 */
function forward(url: string, range: string, res: Response, hop: number, hostKey: string): void {
  // 用户已经关掉播放窗口：别再把 302 链追完，也不要多打一次上游
  if (res.destroyed || res.writableEnded) return;
  if (hop > MAX_HOPS) {
    fail(res, 502, "strm 上游重定向次数过多，已放弃");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(res, 400, "strm 里的播放地址格式不对");
    return;
  }
  const lib = parsed.protocol === "https:" ? https : http;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
    // 视频流不要上游压缩；identity 也避免把 Content-Encoding 透给浏览器
    "Accept-Encoding": "identity",
    Range: range,
  };
  const upstreamReq = lib.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      method: "GET",
      // 用 URL 规范化后的 path，不做 decodeURIComponent：签名地址里的 %40 / %20
      // 与中文都是路径的一部分，解一次再拼回去上游就会 404
      path: parsed.pathname + parsed.search,
      headers,
      timeout: TIMEOUT_MS,
    },
    (up) => {
      const status = up.statusCode ?? 502;
      const location = up.headers.location;

      if (status >= 300 && status < 400 && location) {
        up.resume();
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          fail(res, 502, "strm 上游返回了无效的重定向地址");
          return;
        }
        if (!/^https?:\/\//i.test(next)) {
          fail(res, 502, "strm 上游重定向到了不支持的协议");
          return;
        }
        forward(next, range, res, hop + 1, hostKey);
        return;
      }

      if (status === 403 || status === 429) {
        up.resume();
        tripBreaker(hostKey);
        fail(res, 429, `播放源返回 HTTP ${status}（直链可能已过期或被限流）；已暂停 10 分钟，请稍后重试`);
        return;
      }
      if (status >= 400) {
        up.resume();
        fail(
          res,
          status,
          `播放源返回 HTTP ${status}：strm 里的直链可能已失效，需要回视频页重新生成一条`,
        );
        return;
      }

      res.status(status);
      res.setHeader("Content-Type", mimeOf(parsed, up.headers["content-type"]));
      res.setHeader("Accept-Ranges", up.headers["accept-ranges"] ?? "bytes");
      for (const key of ["content-length", "content-range", "etag", "last-modified"]) {
        const value = up.headers[key];
        if (typeof value === "string" && value) res.setHeader(key, value);
      }
      // 首个数据包直接流出去，不缓冲：等 res.end() 再发头会拖慢「点播放到出画面」
      up.pipe(res);
      res.on("close", () => up.destroy());
      up.on("error", () => res.destroy());
    },
  );
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("strm 上游连接超时")));
  upstreamReq.on("error", (err) => {
    const message = (err as Error).message || "连接失败";
    logger.warn({ url, err: message }, "strm 上游请求失败");
    fail(res, 502, `连不上播放源（${message}）：检查容器能否访问这个地址，或直链是否已失效`);
  });
  upstreamReq.end();
}

/** 播放一个 .strm：读第一行 URL，按 Range 转发。列表接口绝不会调到这里 */
export async function pipeStrm(file: string, req: Request, res: Response): Promise<void> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > 64 * 1024) {
    fail(res, 400, "strm 文件不存在或内容异常（超过 64KB）");
    return;
  }
  const text = await fs.promises.readFile(file, "utf8").catch(() => "");
  const target = parseStrmTarget(text);
  if (!target) {
    fail(res, 400, "strm 里没有有效的 http(s) 播放地址（第一行应是直链，注释行会被跳过）");
    return;
  }
  let hostKey = "";
  try {
    hostKey = new URL(target).host;
  } catch {
    fail(res, 400, "strm 里的播放地址格式不对");
    return;
  }
  if (breakerActive(hostKey)) {
    fail(res, 429, "播放源刚被限流，已暂停 10 分钟；请稍后再试，或重新生成 strm 直链");
    return;
  }
  const range = typeof req.headers.range === "string" ? req.headers.range : "bytes=0-";
  logger.info({ file, host: hostKey, route: isPrivateHost(target) ? "内网直连" : "直连" }, "strm 开始转发");
  forward(target, range, res, 0, hostKey);
}
