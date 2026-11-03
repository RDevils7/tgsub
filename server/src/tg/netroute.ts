/**
 * 网络线路决策：直连优先，不通再走代理。
 *
 * 「线路」指一次下载请求走的是直连还是代理：
 *   direct = 本机直接连源站
 *   proxy  = 经代理中转
 *
 * 取舍原则是「能不用代理的地方尽量直连」：
 *   - 直连能通就直连（少一跳、延迟低，也不怕代理抽风）
 *   - 直连不通（超时 / DNS 失败 / 连不上）才回退代理
 *   - 某个域名直连失败过会被记住一段时间，之后不再浪费时间重试直连
 *
 * 这个文件是纯逻辑（不读数据库、不发网络请求），方便自检；
 * 「代理从哪来」的组装放在 m3u8.ts（那边能读到设置项）。
 */

/** 一次请求实际走的线路 */
export type NetRoute = "direct" | "proxy";

/**
 * 线路策略：
 *   auto   = 直连优先，直连不通才回退代理（默认）
 *   always = 强制走代理
 *   off    = 只直连，不使用代理
 */
export type RouteMode = "auto" | "always" | "off";

/**
 * 按策略排出「该按什么顺序试线路」。
 *
 * auto 的顺序是 direct → proxy，这就是「能不用代理的地方尽量直连」：
 * 大多数国内可直连的站不必绕一圈代理 abroad。
 */
export function planRoutes(mode: RouteMode, hasProxy: boolean): NetRoute[] {
  if (mode === "always") return hasProxy ? ["proxy"] : ["direct"];
  if (mode === "off") return ["direct"];
  return hasProxy ? ["direct", "proxy"] : ["direct"];
}

/**
 * 按「上次走通的线路」重排尝试顺序。
 * 某个域名上次是靠代理才通的，这次就先用代理，省掉一次失败尝试。
 */
export function orderRoutes(routes: NetRoute[], host: string): NetRoute[] {
  const remembered = rememberedRoute(host);
  if (!remembered) return routes;
  if (!routes.includes(remembered)) return routes;
  return [remembered, ...routes.filter((r) => r !== remembered)];
}

/** 线路的中文说明（界面与日志共用） */
export function routeLabel(route: NetRoute | string | null | undefined): string {
  if (route === "direct") return "直连";
  if (route === "proxy") return "代理";
  if (route === "auto") return "自动";
  return "未知";
}

/**
 * 内部代理（127.0.0.1 / localhost / ::1）多是开发工具自带的转发口，
 * 指向它们会让外网站点访问失败，必须排除。
 */
export function isInternalProxy(raw: string | undefined | null): boolean {
  const text = String(raw ?? "").trim();
  if (!text) return false;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    // IPv6 的 hostname 会带方括号（[::1]），要去掉再比
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * 从候选列表里挑第一个可用的代理地址。
 * 空的、指向内部的都跳过；返回 undefined 表示「没有代理可用」。
 */
export function pickProxyFrom(candidates: Array<string | undefined | null>): string | undefined {
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (!text) continue;
    if (isInternalProxy(text)) continue;
    return text;
  }
  return undefined;
}

/** 取 URL 里的 host（拿不到就返回空串） */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * 判断一段报错是不是「网络不通」造成的。
 *
 * 只有这类错误才值得换一条线路重试：源站返回 403 / 签名失效之类，
 * 换代理也没用（甚至更糟），重试只是浪费时间。
 *
 * 注意两种文案都要认：netprobe 自己抛的是**中文**（「连接超时」「网络不可达」
 * 「目标拒绝连接」），chromium / ffmpeg 抛的是英文。只认英文的话，
 * 「直连优先」在超时这一步就断了 —— 明明该回退代理，却直接报错。
 */
export function isNetworkError(message: string): boolean {
  const text = String(message ?? "");
  if (!text) return false;
  if (
    /Connection|timed out|ETIMEDOUT|ECONN|ECONNRESET|resolve|Name or service not known|Could not resolve|Network is unreachable|No route to host|Connection refused|Connection reset|failed to resolve|Network is down|SSL|handshake/i.test(
      text,
    )
  ) {
    return true;
  }
  return /连接超时|读写超时|网络读写超时|连接失败|连接被(重置|拒绝|断开)|网络不可达|网络异常|网络不通|无法解析|域名解析|拒绝连接|已断开|断开连接|握手失败/.test(
    text,
  );
}

/* ------------------------------------------------------------------ */
/* 直连失败记忆                                                        */
/* ------------------------------------------------------------------ */

const DIRECT_FAIL_TTL = 30 * 60 * 1000;
/** host → 直连失败的时间戳 */
const directFailures = new Map<string, number>();

/** 记住「这个域名直连不通」，之后的请求直接走代理 */
export function rememberDirectFailure(host: string): void {
  const key = String(host ?? "").trim();
  if (!key) return;
  directFailures.set(key, Date.now());
}

/** 这个域名最近是否直连失败过 */
export function directFailedRecently(host: string): boolean {
  const key = String(host ?? "").trim();
  if (!key) return false;
  const at = directFailures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > DIRECT_FAIL_TTL) {
    directFailures.delete(key);
    return false;
  }
  return true;
}

/** 直连恢复后清掉记忆（下次又从直连开始试） */
export function forgetDirectFailure(host: string): void {
  directFailures.delete(String(host ?? "").trim());
}

/** 清空全部记忆（测试用） */
export function clearDirectFailures(): void {
  directFailures.clear();
}

/* ------------------------------------------------------------------ */
/* 线路记忆                                                            */
/* ------------------------------------------------------------------ */

const ROUTE_MEMORY_TTL = 10 * 60 * 1000;
/** host → 上次走通的线路 */
const routeMemory = new Map<string, { route: NetRoute; at: number }>();

/** 记住「这个域名上次是走哪条线路走通的」 */
export function rememberRoute(host: string, route: NetRoute): void {
  const key = String(host ?? "").trim();
  if (!key) return;
  routeMemory.set(key, { route, at: Date.now() });
}

/** 这个域名上次走通的线路（没有或过期返回 undefined） */
export function rememberedRoute(host: string): NetRoute | undefined {
  const key = String(host ?? "").trim();
  if (!key) return undefined;
  const hit = routeMemory.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ROUTE_MEMORY_TTL) {
    routeMemory.delete(key);
    return undefined;
  }
  return hit.route;
}

/** 清空线路记忆（测试用） */
export function clearRouteMemory(): void {
  routeMemory.clear();
}
