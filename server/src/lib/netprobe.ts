import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { APP_VERSION } from "../version";

/**
 * 「带代理的 HTTP 请求」与「站点连通性探测」。
 *
 * 为什么不用 fetch：Node 内置的 fetch 不认识 `proxy_url` 这项设置，
 * 想让它走 SOCKS5 得额外装 undici + socks-proxy-agent；而这里只需要
 * 发一个 GET 看能不能拿到响应，手写这几十行反而更可控，也不会给镜像加依赖。
 *
 * 支持：
 *   - 直连
 *   - SOCKS4 / SOCKS4a / SOCKS5 / SOCKS5h（远程解析）
 *   - HTTP / HTTPS 代理（CONNECT 隧道，带 Basic 认证）
 *
 * 注意：Telegram 的 MTProto 是裸 TCP，gramjs 只能走 SOCKS 代理，
 * HTTP(S) 代理仅用于这里的联网检测与 Bot API 这类普通 HTTP 请求。
 */

export type ProxyScheme = "socks4" | "socks5" | "socks5h" | "http" | "https";

export interface ParsedProxy {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string;
  password: string;
  /** 规整后的完整地址，用于回显 */
  raw: string;
}

const DEFAULT_PORTS: Record<ProxyScheme, number> = {
  socks4: 1080,
  socks5: 1080,
  socks5h: 1080,
  http: 8080,
  https: 8443,
};

/** 界面上的协议选项，后端与前端共用同一份顺序 */
export const PROXY_SCHEMES: Array<{ value: ProxyScheme; label: string; hint: string }> = [
  { value: "socks5", label: "SOCKS5", hint: "最常用，Clash / v2ray 默认就是它" },
  { value: "socks5h", label: "SOCKS5H", hint: "同 SOCKS5，但域名交给代理解析（避免本地 DNS 污染）" },
  { value: "socks4", label: "SOCKS4", hint: "老代理；仅支持 IPv4" },
  { value: "http", label: "HTTP", hint: "HTTP 代理，可带用户名密码" },
  { value: "https", label: "HTTPS", hint: "代理本身走 TLS" },
];

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 解析代理地址。空串返回 null（表示直连）。
 * 不带协议时按 SOCKS5 处理，与之前的行为保持一致。
 */
export function parseProxy(raw: string): ParsedProxy | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(text) ? text : `socks5://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!(scheme in DEFAULT_PORTS)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return null;
  const port = Number(url.port || DEFAULT_PORTS[scheme as ProxyScheme]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    scheme: scheme as ProxyScheme,
    host,
    port,
    username: decodeSafe(url.username),
    password: decodeSafe(url.password),
    raw: withScheme,
  };
}

/** 规整成 `scheme://[user:pass@]host:port`，解析不了时原样返回（让用户自己看得见） */
export function normalizeProxyUrl(raw: string): string {
  const p = parseProxy(raw);
  if (!p) return String(raw ?? "").trim();
  const auth = p.username
    ? `${encodeURIComponent(p.username)}${p.password ? `:${encodeURIComponent(p.password)}` : ""}@`
    : "";
  const host = p.host.includes(":") ? `[${p.host}]` : p.host;
  return `${p.scheme}://${auth}${host}:${p.port}`;
}

/** 填了但解析不出时给一句能看懂的说明；正常或留空返回 null */
export function explainProxyProblem(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (parseProxy(text)) return null;
  return "代理地址格式不正确，应为 socks5://host:port（也支持 http / https / socks4）";
}

/** Telegram 的裸 TCP 连接只能用 SOCKS；HTTP(S) 代理只服务联网检测 */
export function telegramProxyUnsupported(raw: string): boolean {
  const p = parseProxy(raw);
  return Boolean(p && (p.scheme === "http" || p.scheme === "https"));
}

/* ------------------------------------------------------------------ */
/* 底层：带缓冲的 socket 读取                                           */
/* ------------------------------------------------------------------ */

interface Reader {
  read(n: number): Promise<Buffer>;
  readUntil(delimiter: string): Promise<string>;
  /** 取走缓冲区里剩下的字节（响应头之后很可能已经混进了 body） */
  drain(): Buffer;
  /**
   * 一直读到对端关闭连接（或攒够 limit 字节）后返回已读内容。
   *
   * 有些服务器既不给 Content-Length、也不声明 chunked，
   * 这种响应只能读到连接关闭为止 —— 连通性探测要靠它拿到状态行。
   */
  readAll(limit: number): Promise<Buffer>;
  /** 拆掉监听：握手用的临时 reader 必须让位，否则后续数据会被它吞掉 */
  detach(): void;
}

function makeReader(socket: net.Socket): Reader {
  // 确保 socket 处于 flowing 状态：没有 'data' 监听时，socket 收到的字节会被直接丢掉
  socket.resume();
  let buf = Buffer.alloc(0);
  let pending: { kind: "n"; n: number } | { kind: "delim"; delim: string } | null = null;
  let waiter: { resolve: (v: Buffer | string) => void; reject: (e: Error) => void } | null = null;
  let failure: Error | null = null;
  /** readAll 期间单独收集的数据（onData 会同时往 buf 里塞一份） */
  let collecting: { chunks: Buffer[]; size: number; limit: number } | null = null;
  let allWaiter: { resolve: (v: Buffer) => void; reject: (e: Error) => void } | null = null;

  const settle = () => {
    if (!waiter || !pending) return;
    if (pending.kind === "n" && buf.length >= pending.n) {
      const out = buf.subarray(0, pending.n);
      buf = buf.subarray(pending.n);
      const w = waiter;
      waiter = null;
      pending = null;
      w.resolve(Buffer.from(out));
      return;
    }
    if (pending.kind === "delim") {
      const idx = buf.indexOf(pending.delim);
      if (idx >= 0) {
        const out = buf.subarray(0, idx + Buffer.byteLength(pending.delim));
        buf = buf.subarray(idx + Buffer.byteLength(pending.delim));
        const w = waiter;
        waiter = null;
        pending = null;
        w.resolve(out.toString("utf8"));
      }
    }
  };

  const fail = (err: Error) => {
    if (allWaiter) {
      const w = allWaiter;
      allWaiter = null;
      collecting = null;
      w.reject(err);
    }
    if (!waiter) {
      failure = err;
      return;
    }
    const w = waiter;
    waiter = null;
    pending = null;
    w.reject(err);
  };

  const onData = (chunk: Buffer) => {
    if (collecting && allWaiter) {
      collecting.chunks.push(chunk);
      collecting.size += chunk.length;
      if (collecting.size >= collecting.limit) {
        const w = allWaiter;
        allWaiter = null;
        const out = Buffer.concat(collecting.chunks).subarray(0, collecting.limit);
        collecting = null;
        w.resolve(out);
      }
    }
    buf = Buffer.concat([buf, chunk]);
    settle();
  };
  const onError = (err: Error) => fail(err);
  const onEnd = (): void => {
    // 对端正常关闭：readAll 就算读完了
    if (collecting && allWaiter) {
      const w = allWaiter;
      allWaiter = null;
      const out = Buffer.concat(collecting.chunks).subarray(0, collecting.limit);
      collecting = null;
      w.resolve(out);
    }
    fail(new Error("连接被对端关闭"));
  };
  const onClose = () => fail(new Error("连接被对端关闭"));
  const onTimeout = () => fail(new Error("网络读写超时"));

  socket.on("data", onData);
  // 没挂 error 监听时 socket 报错会直接抛出，这里兜住
  socket.on("error", onError);
  socket.on("end", onEnd);
  socket.on("close", onClose);
  socket.on("timeout", onTimeout);

  const request = (p: { kind: "n"; n: number } | { kind: "delim"; delim: string }) =>
    new Promise<Buffer | string>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      pending = p;
      waiter = { resolve, reject };
      settle();
    });

  return {
    async read(n) {
      const out = (await request({ kind: "n", n })) as Buffer;
      return out;
    },
    async readUntil(delimiter) {
      const out = (await request({ kind: "delim", delim: delimiter })) as string;
      return out;
    },
    drain() {
      const out = buf;
      buf = Buffer.alloc(0);
      return Buffer.from(out);
    },
    async readAll(limit) {
      const max = Math.max(1, Math.floor(limit));
      const initial = buf;
      buf = Buffer.alloc(0);
      if (initial.length >= max) return initial.subarray(0, max);
      if (failure) throw failure;
      return new Promise<Buffer>((resolve, reject) => {
        collecting = { chunks: [initial], size: initial.length, limit: max };
        allWaiter = { resolve, reject };
      });
    },
    detach() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onClose);
      socket.removeListener("timeout", onTimeout);
      // 交出控制权前先暂停：否则 socket 仍在 flowing、却没有任何 data 监听，
      // 这段时间到达的字节会被白白丢掉（下一步的消费者接手时就读不到了）
      socket.pause();
    },
  };
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("连接超时"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function wrapTls(socket: net.Socket, host: string, timeoutMs: number, verify: boolean): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect(
      {
        socket,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: verify,
      },
      () => {
        clearTimeout(timer);
        resolve(secure);
      },
    );
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error("TLS 握手超时"));
    }, timeoutMs);
    secure.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 代理握手                                                            */
/* ------------------------------------------------------------------ */

async function socks5Handshake(
  socket: net.Socket,
  proxy: ParsedProxy,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const reader = makeReader(socket);
  socket.setTimeout(timeoutMs);
  try {
    const useAuth = Boolean(proxy.username);
    socket.write(Buffer.from(useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));

    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05) throw new Error("代理不是 SOCKS5 服务");
    const method = greeting[1];
    if (method === 0xff) throw new Error("代理拒绝所有认证方式");
    if (method === 0x02) {
      const user = Buffer.from(proxy.username, "utf8");
      const pass = Buffer.from(proxy.password, "utf8");
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const authReply = await reader.read(2);
      if (authReply[1] !== 0x00) throw new Error("代理用户名或密码不正确");
    } else if (method !== 0x00) {
      throw new Error(`代理要求不支持的认证方式（${method}）`);
    }

    const isIpv4 = net.isIPv4(host);
    const hostBuf = Buffer.from(host, "utf8");
    const head = isIpv4
      ? Buffer.from([0x05, 0x01, 0x00, 0x01, ...host.split(".").map(Number)])
      : Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf]);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port);
    socket.write(Buffer.concat([head, portBuf]));

    const reply = await reader.read(4);
    if (reply[0] !== 0x05) throw new Error("SOCKS5 应答异常");
    if (reply[1] !== 0x00) {
      const reasons: Record<number, string> = {
        1: "代理内部错误",
        2: "代理不允许该连接",
        3: "网络不可达",
        4: "目标主机不可达",
        5: "目标拒绝连接（端口未开）",
        6: "TTL 过期",
        7: "代理不支持该命令",
        8: "代理不支持该地址类型",
      };
      throw new Error(`代理连接目标失败：${reasons[reply[1]] ?? `错误码 ${reply[1]}`}`);
    }
    // 吃掉绑定地址，避免残留在缓冲区里被当成 HTTP 响应
    if (reply[3] === 0x01) await reader.read(4 + 2);
    else if (reply[3] === 0x04) await reader.read(16 + 2);
    else if (reply[3] === 0x03) {
      const len = (await reader.read(1))[0];
      await reader.read(len + 2);
    }
  } finally {
    // 握手结束就让位：否则这个 reader 会继续吃掉真正的 HTTP 响应
    reader.detach();
  }
}

async function socks4Handshake(
  socket: net.Socket,
  proxy: ParsedProxy,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const reader = makeReader(socket);
  socket.setTimeout(timeoutMs);
  try {
    // SOCKS4 只认 IPv4，域名先在本机解析；解析失败就直接报错
    const ip = net.isIPv4(host) ? host : (await dns.lookup(host, { family: 4 })).address;
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port);
    const user = Buffer.from(proxy.username || "", "utf8");
    socket.write(
      Buffer.concat([
        Buffer.from([0x04, 0x01]),
        portBuf,
        Buffer.from(ip.split(".").map(Number)),
        user,
        Buffer.from([0x00]),
      ]),
    );
    const reply = await reader.read(8);
    if (reply[1] !== 0x5a) throw new Error("SOCKS4 代理拒绝了该连接");
  } finally {
    reader.detach();
  }
}

async function httpConnect(
  proxy: ParsedProxy,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  let socket: net.Socket;
  try {
    socket = await connectTcp(proxy.host, proxy.port, timeoutMs);
  } catch (err) {
    throw new Error(`代理 ${proxy.host}:${proxy.port} 连不上（${describeNetError(err)}）`);
  }
  if (proxy.scheme === "https") {
    socket = await wrapTls(socket, proxy.host, timeoutMs, false);
  }
  const reader = makeReader(socket);
  socket.setTimeout(timeoutMs);
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, "Proxy-Connection: keep-alive"];
  if (proxy.username) {
    const token = Buffer.from(`${proxy.username}:${proxy.password}`, "utf8").toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  try {
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    const head = await reader.readUntil("\r\n\r\n");
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1] ?? 0);
    if (status === 407) {
      socket.destroy();
      throw new Error("代理需要认证（用户名或密码不对）");
    }
    if (status !== 200) {
      socket.destroy();
      throw new Error(status ? `代理拒绝建立隧道（HTTP ${status}）` : "代理返回了无法识别的内容");
    }
    return socket;
  } finally {
    reader.detach();
  }
}

/**
 * 建立到 host:port 的通道；代理为 null 时直连。返回未加密的 socket
 *
 * 对外导出：m3u8 下载链路要用它搭一个「本地 HTTP 代理 → SOCKS 代理」的桥，
 * 因为 ffmpeg 只认 http_proxy 环境变量，不支持 socks5。
 */
export async function openChannel(
  proxy: ParsedProxy | null,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  if (!proxy) return connectTcp(host, port, timeoutMs);
  if (proxy.scheme === "http" || proxy.scheme === "https") {
    return httpConnect(proxy, host, port, timeoutMs);
  }
  // socks：先连代理，再让代理连目标。连不上代理时把「是谁不通」说清楚，
  // 否则用户只会看到「连接被拒绝」，分不清是代理没开还是目标网站挂了
  let socket: net.Socket;
  try {
    socket = await connectTcp(proxy.host, proxy.port, timeoutMs);
  } catch (err) {
    throw new Error(`代理 ${proxy.host}:${proxy.port} 连不上（${describeNetError(err)}）`);
  }
  try {
    if (proxy.scheme === "socks4") await socks4Handshake(socket, proxy, host, port, timeoutMs);
    else await socks5Handshake(socket, proxy, host, port, timeoutMs);
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 请求与探测                                                          */
/* ------------------------------------------------------------------ */

export interface HttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /** 从发出请求到收到响应头的毫秒数 */
  ms: number;
  viaProxy: boolean;
}

export interface HttpOptions {
  proxy?: ParsedProxy | null;
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  /** 为 true 时校验证书；探测连通性时用 false，免得自签/中间人代理一律判失败 */
  verifyTls?: boolean;
  maxBody?: number;
  /** 自定义 User-Agent；有些站点会按 UA 判断「是不是浏览器」 */
  userAgent?: string;
  /** 额外的请求头 */
  headers?: Record<string, string>;
}

function describeNetError(err: unknown): string {
  const e = err as Error & { code?: string };
  const code = e?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败";
  if (code === "ECONNREFUSED") return "连接被拒绝（端口没开）";
  if (code === "ECONNRESET") return "连接被重置";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "网络不可达";
  if (code === "ETIMEDOUT" || /超时/.test(e?.message ?? "")) return "超时";
  if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || /certificate/i.test(e?.message ?? "")) {
    return "证书校验失败";
  }
  return e?.message || String(err);
}

/** 解 chunked 编码：`c\r\nhello\r\n0\r\n\r\n` → `hello` */
function decodeChunked(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const lineEnd = raw.indexOf("\r\n", i);
    if (lineEnd < 0) break;
    const size = parseInt(raw.slice(i, lineEnd).split(";")[0], 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    out += raw.slice(start, start + size);
    i = start + size + 2;
  }
  return out;
}

/**
 * 发一个 HTTP(S) 请求。只实现到「够用」的程度：
 * 按 Content-Length 读 body，chunked 就解码到终止块，不做连接复用。
 */
export async function httpRequest(rawUrl: string, options: HttpOptions = {}): Promise<HttpResult> {
  const url = new URL(rawUrl);
  const isHttps = url.protocol === "https:";
  const host = url.hostname;
  const port = Number(url.port || (isHttps ? 443 : 80));
  const timeoutMs = options.timeoutMs ?? 8000;
  const proxy = options.proxy ?? null;
  const path = `${url.pathname || "/"}${url.search}`;
  const started = Date.now();

  let socket = await openChannel(proxy, host, port, timeoutMs);
  if (isHttps) {
    socket = await wrapTls(socket, host, timeoutMs, options.verifyTls ?? false);
  }
  const reader = makeReader(socket);
  socket.setTimeout(timeoutMs);

  const requestLines = [
    `${options.method ?? "GET"} ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    `User-Agent: ${options.userAgent ?? `tgsub/${APP_VERSION}`}`,
    "Accept: */*",
    "Accept-Encoding: identity",
    "Connection: close",
  ];
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    requestLines.push(`${key}: ${value}`);
  }
  socket.write(`${requestLines.join("\r\n")}\r\n\r\n`);

  try {
    const head = await reader.readUntil("\r\n\r\n");
    const ms = Date.now() - started;
    const lines = head.split("\r\n");
    const statusLine = lines.shift() ?? "";
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
    const statusText = statusLine.split(/\s+/).slice(2).join(" ");
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    let body = "";
    if ((options.method ?? "GET") !== "HEAD") {
      const limit = options.maxBody ?? 64 * 1024;
      const length = Number(headers["content-length"] ?? 0);
      if (Number.isFinite(length) && length > 0) {
        const chunk = await reader.read(Math.min(length, limit));
        body = chunk.toString("utf8");
      } else if (headers["transfer-encoding"]?.includes("chunked")) {
        const raw = await reader.readUntil("\r\n0\r\n\r\n").catch(() => "");
        body = decodeChunked(raw).slice(0, limit);
      } else {
        // 既没有 Content-Length 也没有 chunked：读到连接关闭为止
        const chunk = await reader.readAll(limit);
        body = chunk.toString("utf8");
      }
    }
    return { status, statusText, headers, body, ms, viaProxy: Boolean(proxy) };
  } finally {
    socket.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* 大文件下载（自动更新 yt-dlp 用）                                      */
/* ------------------------------------------------------------------ */

export interface FileDownloadResult {
  bytes: number;
  finalUrl: string;
  /** 服务端给的大小，没给就是 null */
  contentLength: number | null;
}

export interface FileDownloadOptions {
  proxy?: ParsedProxy | null;
  timeoutMs?: number;
  /** 上限，防止误下成一个巨大的 HTML 或死循环 */
  maxBytes?: number;
  verifyTls?: boolean;
  onProgress?: (got: number, total: number) => void;
  /** 额外请求头：平台的图床大多要 Referer，否则返回 403 */
  headers?: Record<string, string>;
}

/**
 * 把远端文件流式写进 dest。
 *
 * 与 httpRequest 的差别：body 不进内存，而是 pipe 到文件；跟随 3xx
 * （GitHub Release 会跳到 objects.githubusercontent.com）。
 * 代理、TLS、握手逻辑与 httpRequest 完全共用同一套。
 */
export async function downloadFile(
  rawUrl: string,
  dest: string,
  options: FileDownloadOptions = {},
): Promise<FileDownloadResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  let current = rawUrl;

  for (let hop = 0; hop < 6; hop += 1) {
    const url = new URL(current);
    const isHttps = url.protocol === "https:";
    const host = url.hostname;
    const port = Number(url.port || (isHttps ? 443 : 80));
    const pathname = `${url.pathname || "/"}${url.search}`;

    let socket = await openChannel(options.proxy ?? null, host, port, timeoutMs);
    if (isHttps) socket = await wrapTls(socket, host, timeoutMs, options.verifyTls ?? true);
    const reader = makeReader(socket);
    socket.setTimeout(timeoutMs);

    socket.write(
      [
        `GET ${pathname} HTTP/1.1`,
        `Host: ${host}`,
        `User-Agent: tgsub/${APP_VERSION} (yt-dlp updater)`,
        "Accept: */*",
        "Accept-Encoding: identity",
        "Connection: close",
        ...Object.entries(options.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
      ].join("\r\n") + "\r\n\r\n",
    );

    let head: string;
    try {
      head = await reader.readUntil("\r\n\r\n");
    } catch (err) {
      reader.detach();
      socket.destroy();
      throw err;
    }

    const lines = head.split("\r\n");
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    if (status >= 300 && status < 400 && headers.location) {
      reader.detach();
      socket.destroy();
      current = new URL(headers.location, current).toString();
      continue;
    }

    if (status !== 200) {
      reader.detach();
      socket.destroy();
      throw new Error(`下载失败：HTTP ${status || "无响应"}`);
    }

    const total = Number(headers["content-length"] ?? 0) || null;
    if (total && total > maxBytes) {
      reader.detach();
      socket.destroy();
      throw new Error(`文件过大（${Math.round(total / 1024 / 1024)}MB），已取消`);
    }

    // 头部之后缓冲区里已经可能混了 body：暂停 → 取走 → 让位 → 塞回 → pipe
    socket.pause();
    const leftover = reader.drain();
    reader.detach();

    const ws = fs.createWriteStream(dest);
    let got = 0;
    // pipe 阶段没有 makeReader 兜底，单独挂一个空闲超时
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error("下载超时"));
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) {
          ws.destroy();
          reject(err);
        } else {
          resolve();
        }
      };
      socket.on("data", (chunk: Buffer) => {
        got += chunk.length;
        options.onProgress?.(got, total ?? 0);
        if (got > maxBytes) done(new Error("文件超过大小上限，已中断"));
      });
      socket.once("error", (err) => done(err));
      ws.once("error", (err) => done(err));
      ws.once("finish", () => done());
      if (leftover.length) socket.unshift(leftover);
      socket.pipe(ws);
    });

    if (total && got < total) {
      throw new Error(`下载不完整（${got}/${total} 字节）`);
    }
    return { bytes: got, finalUrl: current, contentLength: total };
  }

  throw new Error("重定向次数过多，已放弃");
}

export interface ProbeSite {
  id: string;
  label: string;
  url: string;
  note: string;
}

/** 「ping」用的固定站点：两个国外、一个国内、一个 Telegram 自己的 API */
export const PROBE_SITES: ProbeSite[] = [
  { id: "telegram", label: "Telegram API", url: "https://api.telegram.org/", note: "下载与登录都靠它" },
  { id: "google", label: "Google", url: "https://www.google.com/generate_204", note: "国外网络参照" },
  { id: "github", label: "GitHub", url: "https://github.com/", note: "镜像与更新" },
  { id: "baidu", label: "百度", url: "https://www.baidu.com/", note: "国内网络参照" },
];

export interface ProbeOutcome {
  id: string;
  label: string;
  note: string;
  url: string;
  ok: boolean;
  status: number | null;
  ms: number | null;
  error: string | null;
  viaProxy: boolean;
}

async function probeOne(site: ProbeSite, proxy: ParsedProxy | null, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    // 拿得到状态行就算通：403 / 404 也说明链路是好的
    const res = await httpRequest(site.url, { proxy, timeoutMs, method: "GET", maxBody: 1024 });
    return {
      id: site.id,
      label: site.label,
      note: site.note,
      url: site.url,
      ok: res.status > 0,
      status: res.status || null,
      ms: res.ms,
      error: res.status > 0 ? null : "没有收到 HTTP 响应",
      viaProxy: res.viaProxy,
    };
  } catch (err) {
    return {
      id: site.id,
      label: site.label,
      note: site.note,
      url: site.url,
      ok: false,
      status: null,
      ms: null,
      error: describeNetError(err),
      viaProxy: Boolean(proxy),
    };
  }
}

/** 并发探测（最多 4 个同时），返回顺序与 PROBE_SITES 一致 */
export async function probeSites(
  proxy: ParsedProxy | null,
  timeoutMs = 8000,
  sites: ProbeSite[] = PROBE_SITES,
): Promise<ProbeOutcome[]> {
  const out: ProbeOutcome[] = new Array(sites.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= sites.length) return;
      out[index] = await probeOne(sites[index], proxy, timeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sites.length) }, worker));
  return out;
}

/* ------------------------------------------------------------------ */
/* Telegram Bot API                                                    */
/* ------------------------------------------------------------------ */

export interface BotIdentity {
  ok: boolean;
  id: string | null;
  username: string | null;
  name: string | null;
  ms: number | null;
  error: string | null;
}

/**
 * 用 Bot API 的 getMe 验证 token。
 *
 * 走的是普通 HTTPS，所以能被 HTTP(S) / SOCKS 代理接管 —— 机器人进程本身
 * （gramjs）走 SOCKS，两者可以互相对照：getMe 通但机器人连不上，
 * 说明是 MTProto 那条路被挡了，不是 token 的问题。
 */
export async function telegramGetMe(token: string, proxy: ParsedProxy | null): Promise<BotIdentity> {
  const value = String(token ?? "").trim();
  if (!value) return { ok: false, id: null, username: null, name: null, ms: null, error: "没有可用的 Bot Token" };
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) {
    return { ok: false, id: null, username: null, name: null, ms: null, error: "Token 格式不对，应为 123456789:AAH…" };
  }
  try {
    const res = await httpRequest(`https://api.telegram.org/bot${value}/getMe`, {
      proxy,
      timeoutMs: 12_000,
      verifyTls: true,
      maxBody: 16 * 1024,
    });
    let parsed: {
      ok?: boolean;
      description?: string;
      error_code?: number;
      result?: { id?: number; username?: string; first_name?: string };
    } = {};
    try {
      parsed = JSON.parse(res.body) as typeof parsed;
    } catch {
      /* 非 JSON：交给下面统一报错 */
    }
    if (res.status === 401 || parsed.error_code === 401) {
      return { ok: false, id: null, username: null, name: null, ms: res.ms, error: "Token 无效或已被 BotFather 重置" };
    }
    if (!parsed.ok || !parsed.result) {
      return {
        ok: false,
        id: null,
        username: null,
        name: null,
        ms: res.ms,
        error: parsed.description || `Bot API 返回 HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      id: parsed.result.id ? String(parsed.result.id) : null,
      username: parsed.result.username ?? null,
      name: parsed.result.first_name ?? null,
      ms: res.ms,
      error: null,
    };
  } catch (err) {
    return { ok: false, id: null, username: null, name: null, ms: null, error: describeNetError(err) };
  }
}

/** 供路由层复用的错误文案 */
export { describeNetError };
