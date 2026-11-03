import http from "node:http";
import net from "node:net";
import { logger } from "../logger";
import { openChannel, parseProxy, type ParsedProxy } from "../lib/netprobe";

/**
 * 「本地 HTTP 代理 → SOCKS 代理」桥。
 *
 * 为什么需要它：
 *   - ffmpeg 的 http/https 协议只认 `http_proxy` / `https_proxy` 环境变量，**不支持 socks5**
 *   - Chromium 的 `--proxy-server` 同样只支持 http/https/socks5，不支持 socks4，
 *     而且 socks5 由浏览器本地解析域名（做不到 socks5h 的远程解析）
 *
 * 所以当用户的代理是 SOCKS 时，就在本地开一个极小的 HTTP 代理：
 * 浏览器 / ffmpeg 把它当普通 HTTP 代理用，桥再把 CONNECT 隧道转给 SOCKS 代理。
 * 这样两种客户端都能用 socks4 / socks5 / socks5h，且域名交给代理解析。
 *
 * 桥是按代理地址缓存的：同一个代理只开一个端口，多个任务共用。
 * 引用计数归零后延迟关闭，避免任务之间的空档把端口反复起停。
 */

export interface ProxyBridge {
  /** 给浏览器 / ffmpeg 用的本地 HTTP 代理地址，如 http://127.0.0.1:53124 */
  url: string;
  /** 归还引用；最后一个使用者归还后，桥会在空闲一段时间后关闭 */
  release: () => void;
}

/** 同一个代理地址共用一个桥 */
const bridges = new Map<string, { bridge: ProxyBridge; refs: number; timer: NodeJS.Timeout | null }>();

/** 没人用之后多久关掉桥（秒） */
const IDLE_CLOSE_MS = 60_000;

function closeBridge(entry: { bridge: ProxyBridge; refs: number; timer: NodeJS.Timeout | null }, key: string): void {
  const server = (entry.bridge as ProxyBridge & { close?: () => void }).close;
  try {
    server?.();
  } catch {
    /* ignore */
  }
  bridges.delete(key);
  logger.info("SOCKS 桥已关闭：%s", key);
}

/**
 * 取一个指向指定 SOCKS 代理的本地 HTTP 代理。
 * 传入的代理本来就支持 http/https 时直接返回它，不必绕桥。
 */
export async function acquireProxyBridge(proxyUrl: string): Promise<ProxyBridge> {
  const parsed = parseProxy(proxyUrl);
  if (!parsed) throw new Error(`代理地址无法解析：${proxyUrl}`);
  if (parsed.scheme === "http" || parsed.scheme === "https") {
    // 本身就是 HTTP 代理，客户端直接用即可
    return { url: proxyUrl, release: () => undefined };
  }

  const key = parsed.raw;
  const existing = bridges.get(key);
  if (existing) {
    existing.refs += 1;
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    return existing.bridge;
  }

  const created = await startBridge(parsed);
  const entry = { bridge: created, refs: 1, timer: null as NodeJS.Timeout | null };
  bridges.set(key, entry);

  const release = (): void => {
    const cur = bridges.get(key);
    if (!cur) return;
    cur.refs -= 1;
    if (cur.refs > 0) return;
    if (cur.timer) clearTimeout(cur.timer);
    cur.timer = setTimeout(() => {
      const latest = bridges.get(key);
      if (latest && latest.refs <= 0) closeBridge(latest, key);
    }, IDLE_CLOSE_MS);
    cur.timer.unref?.();
  };

  return { url: created.url, release };
}

function startBridge(proxy: ParsedProxy): Promise<ProxyBridge & { close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // 普通 HTTP 请求（不是 CONNECT）：这里用不上，回 405
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("tgsub proxy bridge: only CONNECT is supported\n");
    });

    server.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
      const target = String(req.url ?? "");
      const idx = target.lastIndexOf(":");
      if (idx <= 0) {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const host = target.slice(0, idx);
      const port = Number(target.slice(idx + 1)) || 443;

      void (async () => {
        let upstream: net.Socket;
        try {
          upstream = await openChannel(proxy, host, port, 20_000);
        } catch (err) {
          logger.warn("SOCKS 桥连接 %s 失败: %s", target, String(err));
          try {
            clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          } catch {
            /* ignore */
          }
          return;
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // CONNECT 之后客户端紧接着发的首包（TLS ClientHello 等）已由 Node 读走，
        // 必须原样补发给上游。用 unshift 塞回客户端 socket 不可靠：
        // CONNECT 的 socket 往往仍处于 flowing 模式，unshift 的数据会被直接丢弃，
        // 结果就是 TLS 握手永远等不到 ServerHello（表现为握手被重置）。
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        const kill = (): void => {
          upstream.destroy();
          clientSocket.destroy();
        };
        upstream.on("error", (err) => {
          logger.warn("SOCKS 桥上游出错（%s → %s）: %s", proxy.raw, target, String(err));
          kill();
        });
        clientSocket.on("error", (err) => {
          logger.warn("SOCKS 桥客户端出错（%s → %s）: %s", proxy.raw, target, String(err));
          kill();
        });
        upstream.on("close", () => clientSocket.destroy());
        clientSocket.on("close", () => upstream.destroy());
      })();
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (!port) {
        reject(new Error("SOCKS 桥启动失败：拿不到监听端口"));
        return;
      }
      logger.info("SOCKS 桥已启动：http://127.0.0.1:%d → %s", port, proxy.raw);
      resolve({
        url: `http://127.0.0.1:${port}`,
        release: () => undefined,
        close: () => {
          server.close(() => {
            /* ignore */
          });
          server.unref?.();
        },
      });
    });
  });
}
