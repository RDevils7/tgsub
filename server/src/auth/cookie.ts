/**
 * Cookie 头解析（只取一个名字）。
 *
 * 为什么不装 cookie-parser：整站只有一个 cookie，为它加一个中间件和依赖不划算。
 * 抽成独立模块是为了能被自检直接调用 —— 解析手写 cookie 的地方最容易出错：
 * 值里有 `=`、有别的 cookie 干扰、URL 编码过的值。
 */
export function parseCookie(header: string | undefined | null, name: string): string {
  if (!header) return "";
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // 去掉可能存在的包裹引号（有些客户端会写成 name="value"）
    const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
    try {
      return decodeURIComponent(unquoted);
    } catch {
      // 值里有孤立的 % 时 decode 会抛错，此时按原样返回，好过当没这个 cookie
      return unquoted;
    }
  }
  return "";
}
