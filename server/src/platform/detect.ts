import { PlatformId } from "../types";

/**
 * 第三方链接识别：B站 / 抖音 / 小红书。
 *
 * 只做「这条链接该交给谁」的判断，不展开短链、不请求网络 —— 短链
 * （b23.tv / v.douyin.com / xhslink.com）交给 yt-dlp 自己重定向，
 * 我们在这一层保持纯函数，好进自检。
 */

export interface PlatformLink {
  platform: PlatformId;
  /** 补全协议后的链接，直接交给 yt-dlp */
  url: string;
  /** 视频/笔记 ID；短链认不出来是 null */
  id: string | null;
  /** 去重用的稳定键：有 ID 用 ID，否则退回规范化后的链接 */
  key: string;
}

const HOSTS: Array<{ platform: PlatformId; host: string[] }> = [
  { platform: "bilibili", host: ["bilibili.com", "b23.tv"] },
  { platform: "douyin", host: ["douyin.com", "iesdouyin.com"] },
  { platform: "xiaohongshu", host: ["xiaohongshu.com", "xhslink.com"] },
  { platform: "youtube", host: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
];

/** 补协议后解析；不是合法 URL 返回 null */
export function toUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/** host 必须精确匹配或以 .host 结尾，不能用 includes（避免 notbilibili.com 这类冒充） */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function detectPlatform(raw: string): PlatformId | null {
  const url = toUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  for (const entry of HOSTS) {
    if (entry.host.some((domain) => hostMatches(host, domain))) return entry.platform;
  }
  return null;
}

/** 从路径里抠出平台自己的 ID（认不出就给 null，短链都属于这种） */
export function extractPlatformId(platform: PlatformId, url: URL): string | null {
  const pathname = url.pathname;
  if (platform === "bilibili") {
    const bv = pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (bv) return bv[1];
    const av = pathname.match(/\/video\/av(\d+)/i);
    if (av) return `av${av[1]}`;
    const ep = pathname.match(/\/bangumi\/play\/((?:ep|ss)\d+)/i);
    if (ep) return ep[1];
    return null;
  }
  if (platform === "douyin") {
    const video = pathname.match(/\/(?:video|note|slides)\/(\d{6,})/);
    if (video) return video[1];
    // https://www.iesdouyin.com/share/video/7xxxxxxxx/
    const share = pathname.match(/\/share\/(?:video|note)\/(\d{6,})/);
    return share ? share[1] : null;
  }
  if (platform === "youtube") {
    // watch?v=ID / shorts/ID / live/ID / embed/ID；youtu.be/ID 走路径
    const v = url.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
    const path = pathname.match(/\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,})/);
    if (path) return path[1];
    const short = pathname.match(/^\/([A-Za-z0-9_-]{6,})\/?$/);
    return short ? short[1] : null;
  }
  const note = pathname.match(/\/(?:explore|discovery\/item|item)\/([0-9a-zA-Z]{8,})/);
  return note ? note[1] : null;
}

/**
 * 解析一条链接。不是这三个平台就返回 null。
 *
 * 顺带去掉末尾的中文标点：从微信/聊天记录里复制常常带着「，」「）」。
 */
export function parsePlatformLink(raw: string): PlatformLink | null {
  const cleaned = raw.trim().replace(/[，,。；;、）)】》"']+$/g, "");
  const url = toUrl(cleaned);
  if (!url) return null;
  const platform = detectPlatform(cleaned);
  if (!platform) return null;
  const id = extractPlatformId(platform, url);
  // 短链没有 ID：用「域名 + 路径」当键，同一段短链重复粘贴仍能去重
  const key = id ?? `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  return { platform, url: url.toString(), id, key };
}

/** 从一大段文字里挑出所有三平台链接（一行一个、空格分隔、混着说明文字都能认） */
export function splitPlatformLinks(raw: string): PlatformLink[] {
  const tokens = raw.split(/[\s\r\n]+/).filter(Boolean);
  const seen = new Set<string>();
  const out: PlatformLink[] = [];
  for (const token of tokens) {
    const parsed = parsePlatformLink(token);
    if (!parsed || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    out.push(parsed);
  }
  return out;
}

/** 判断这段文字里有没有三平台链接，用于界面上给提示 */
export function hasPlatformLink(raw: string): boolean {
  return splitPlatformLinks(raw).length > 0;
}
