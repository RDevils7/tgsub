/**
 * Cookie 头解析。
 *
 * 为什么不装 cookie-parser：整站只有一个 cookie，为它加一个中间件和依赖不划算。
 * 抽成独立模块是为了能被自检直接调用 —— 解析手写 cookie 的地方最容易出错：
 * 值里有 `=`、有别的 cookie 干扰、URL 编码过的值。
 */

/** 解出同名的全部 cookie 值（顺序与浏览器发送顺序一致） */
export function parseCookies(header: string | undefined | null, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // 去掉可能存在的包裹引号（有些客户端会写成 name="value"）
    const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
    if (!unquoted) continue;
    try {
      out.push(decodeURIComponent(unquoted));
    } catch {
      // 值里有孤立的 % 时 decode 会抛错，此时按原样留着，好过当没这个 cookie
      out.push(unquoted);
    }
  }
  return out;
}

/**
 * 只取第一个同名 cookie。
 *
 * 注意：浏览器可能同时发出**多个同名 cookie**（历史遗留的旧 cookie 路径/域不同，
 * 新登录又写了一个）。谁排在前面由浏览器决定，不一定是我们刚写进去的那个 ——
 * 校验会话时要用 `parseCookies()` 挨个试，不能只看第一个。
 */
export function parseCookie(header: string | undefined | null, name: string): string {
  return parseCookies(header, name)[0] ?? "";
}
