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
  xiaohongshu: [["web_session"], ["a1"]],
  youtube: [["SID", "SAPISID", "__Secure-3PAPISID", "__Secure-3PSID", "LOGIN_INFO", "SIDCC"]],
};

export interface CookiePair {
  name: string;
  value: string;
}

/** Cookie-Editor 之类扩展导出的 JSON（数组或 {k: v}） */
function fromJson(text: string): CookiePair[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: CookiePair[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      // 空值（退出登录后残留的 "sid="）没有意义，直接丢掉
      if (typeof rec.name === "string" && typeof rec.value === "string" && rec.name && rec.value) {
        out.push({ name: rec.name, value: rec.value });
      }
    }
    return out;
  }
  if (data && typeof data === "object") {
    for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === "string" && name && value) out.push({ name, value });
    }
  }
  return out;
}

/** 浏览器扩展导出的 cookies.txt（Netscape 格式，TAB 分隔 7 列） */
function isNetscape(text: string): boolean {
  if (/^#\s*(Netscape|HttpOnly_)/i.test(text)) return true;
  return text.split(/\r?\n/).some((line) => line.split("\t").length >= 7);
}

function fromNetscape(text: string): CookiePair[] {
  const out: CookiePair[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^#HttpOnly_/i, "").trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const name = parts[5].trim();
    const value = parts[6].trim();
    if (name) out.push({ name, value });
  }
  return out;
}

/**
 * 把用户可能粘进来的几种格式统一成 `k=v; k2=v2`：
 * 普通 Cookie 串（可能带换行）、`Cookie: ...` 前缀、JSON 导出、Netscape cookies.txt。
 * 之后所有解析都基于统一格式，避免「界面认得出、写文件时认不出」。
 */
export function normalizeCookie(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text.startsWith("[") || text.startsWith("{")) {
    const pairs = fromJson(text);
    if (pairs.length) return pairs.map((p) => `${p.name}=${p.value}`).join("; ");
  }
  if (isNetscape(text)) {
    const pairs = fromNetscape(text);
    if (pairs.length) return pairs.map((p) => `${p.name}=${p.value}`).join("; ");
  }
  return text.replace(/^cookie\s*:\s*/i, "");
}

/** 拆 `k=v; k2=v2`；容忍换行、制表符、多余空格与结尾分号 */
export function parseCookiePairs(raw: string): CookiePair[] {
  const out: CookiePair[] = [];
  for (const chunk of normalizeCookie(raw).split(/[;\n]/)) {
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

export interface CookieSummary {
  /** 键值对数量 */
  count: number;
  /** 认出来的键名（保持原顺序、去重） */
  keys: string[];
  /** 缺失的必要项，显示时用组内第一个键名代表 */
  missing: string[];
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
