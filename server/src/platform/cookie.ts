import { PlatformId } from "../types";

/**
 * Cookie 串的解析与体检（纯函数，进自检）。
 *
 * 用户从浏览器 F12 里复制出来的是 `k=v; k2=v2`，各平台真正决定
 * 「算不算登录态」的只有几个键。这里不判断真假，只告诉用户
 * 「认出了几项 / 关键的有没有」，省得填完一片空白不知道对不对。
 */

/** 每个平台至少要有其中一项；数组里的多个元素是「任一命中即可」 */
export const COOKIE_REQUIRED: Record<PlatformId, string[][]> = {
  bilibili: [["SESSDATA"], ["bili_jct"]],
  douyin: [["ttwid", "msToken", "odin_tt"]],
  xiaohongshu: [["web_session"], ["a1"]],
  youtube: [["SID", "SAPISID", "__Secure-3PAPISID", "LOGIN_INFO"]],
};

export interface CookieSummary {
  /** 键值对数量 */
  count: number;
  /** 认出来的键名（保持原顺序、去重） */
  keys: string[];
  /** 缺失的必要项，显示时用组内第一个键名代表 */
  missing: string[];
}

/** 拆 `k=v; k2=v2`；容忍换行、制表符、多余空格与结尾分号 */
export function parseCookiePairs(raw: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const chunk of String(raw ?? "").split(/[;\n]/)) {
    const item = chunk.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

/** 体检：认出几项、缺什么 */
export function summarizeCookie(raw: string, platform: PlatformId): CookieSummary {
  const pairs = parseCookiePairs(raw);
  const keys = [...new Set(pairs.map((p) => p.name))];
  const lower = new Set(keys.map((k) => k.toLowerCase()));
  const missing: string[] = [];
  for (const group of COOKIE_REQUIRED[platform] ?? []) {
    const hit = group.some((name) => lower.has(name.toLowerCase()));
    if (!hit) missing.push(group[0]);
  }
  return { count: pairs.length, keys, missing };
}

/** 一行摘要，直接给界面用 */
export function describeCookie(summary: CookieSummary): string {
  if (summary.count === 0) return "未识别到任何键值对";
  const head = `${summary.count} 项`;
  if (summary.missing.length === 0) {
    return `${head} · ${summary.keys.slice(0, 3).join(" / ")}${summary.keys.length > 3 ? " …" : ""}`;
  }
  return `${head} · 缺 ${summary.missing.join(" / ")}`;
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 5 天前 */
export function humanAge(ts: number | null, now = Date.now()): string | null {
  if (!ts || !Number.isFinite(ts)) return null;
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return `${Math.floor(diff / (30 * day))} 个月前`;
}
