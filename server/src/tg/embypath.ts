import path from "node:path";

/**
 * Emby 入库用到的两个纯函数：地址规整与路径映射。
 *
 * 单独拆出来（不 import db）是为了能直接进自检脚本：
 * 这是最容易填错、又最难排查的两处 —— Emby 对不存在的路径只会静默忽略，
 * 返回 204 什么都不说，只能靠单元测试把边界钉住。
 */

export interface EmbyPathRule {
  from: string;
  to: string;
}

/**
 * 规整用户填的地址：
 * - 没写协议就补 http://（NAS 上几乎都是 http）
 * - 去掉末尾斜杠
 * - 去掉管理页后缀 /web、/web/index.html —— 用户复制浏览器地址栏时常常带着
 */
export function normalizeEmbyUrl(raw: string): string {
  let value = (raw || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, "");
  value = value.replace(/\/web(\/.*)?$/i, "");
  value = value.replace(/\/+$/, "");
  return value;
}

function normalizePrefix(value: string): string {
  let out = value.trim();
  if (!out) return "";
  // Windows 盘符：Emby 跑在 Windows 上时提交反斜杠路径
  if (/^[a-zA-Z]:[\\/]/.test(out)) {
    return out.replace(/\//g, "\\").replace(/\\+$/, "");
  }
  out = out.replace(/\\/g, "/").replace(/\/+$/, "");
  return out || "/";
}

/**
 * 解析一行映射。
 *
 * 必须优先按 `=` / `->` 切，最后才考虑冒号 ——
 * `D:\media=D:\Emby\media` 里的盘符冒号如果先被当成分隔符，
 * 左边会被切成 `D`，整条规则就废了（Emby 只会静默忽略，很难查）。
 */
function splitRule(text: string): [string, string] | null {
  for (const re of [/\s*(?:->|=>)\s*/, /\s*=\s*/]) {
    const match = text.match(re);
    if (!match || match.index === undefined || match.index <= 0) continue;
    const left = text.slice(0, match.index).trim();
    const right = text.slice(match.index + match[0].length).trim();
    if (left && right) return [left, right];
  }
  // 冒号（含中文冒号）：允许左边带盘符，例如 D:\media：/mnt/media
  const colon = text.match(/^((?:[a-zA-Z]:)?[^:：]+)\s*[:：]\s*(.+)$/);
  if (colon) return [colon[1].trim(), colon[2].trim()];
  return null;
}

/**
 * 解析路径映射，每行 `本机=Emby`。
 * 也接受 `本机 -> Emby`、`本机：Emby`（中文冒号），这三种写法都常见。
 */
export function parsePathMap(raw: string): EmbyPathRule[] {
  const rules: EmbyPathRule[] = [];
  for (const line of (raw || "").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const parts = splitRule(text);
    if (!parts) continue;
    const from = normalizePrefix(parts[0]);
    const to = normalizePrefix(parts[1]);
    if (!from || !to || from === to) continue;
    rules.push({ from, to });
  }
  // 长前缀优先，避免 /media 抢在 /media/tgsub 前面匹配
  return rules.sort((a, b) => b.from.length - a.from.length);
}

/** 把本机绝对路径换成 Emby 视角的路径；没命中任何规则时原样返回（统一 / 分隔） */
export function mapEmbyPath(absPath: string, rules: EmbyPathRule[]): string {
  const input = absPath || "";
  for (const rule of rules) {
    const { from, to } = rule;
    const sep = from.includes("\\") ? "\\" : "/";
    const probe = sep === "/" ? input.replace(/\\/g, "/") : input.replace(/\//g, "\\");
    if (probe === from) return to;
    const prefix = from.endsWith(sep) ? from : from + sep;
    if (probe.startsWith(prefix)) {
      const rest = probe.slice(from.length).replace(/^[\\/]+/, "");
      return rest ? `${to}${sep}${rest}` : to;
    }
  }
  return input.split(path.sep).join("/");
}
