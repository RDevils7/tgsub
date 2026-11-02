import { PlatformId } from "../types";

/**
 * 第三方链接识别：B站 / 小红书 / YouTube。
 *
 * 只做「这条链接该交给谁」的判断，不展开短链、不请求网络 —— 短链
 * （b23.tv / xhslink.com）交给 yt-dlp 自己重定向，
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
  { platform: "bilibili", host: ["bilibili.com", "b23.tv", "bili2233.cn"] },
  // 小红书有 .com 与 .cn 两套短链域名，App 现在默认给的是 xhslink.cn
  { platform: "xiaohongshu", host: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"] },
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
 * 解析一条链接。不是这几个平台就返回 null。
 *
 * 顺带剥掉分享口令带上的包装：`<https://…>`、末尾的「，」「）」等。
 */
export function parsePlatformLink(raw: string): PlatformLink | null {
  const cleaned = cleanUrlText(raw);
  const url = toUrl(cleaned);
  if (!url) return null;
  const platform = detectPlatform(cleaned);
  if (!platform) return null;
  const id = extractPlatformId(platform, url);
  // 短链没有 ID：用「域名 + 路径」当键，同一段短链重复粘贴仍能去重
  const key = id ?? `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  return { platform, url: url.toString(), id, key };
}

/** 从一大段文字里挑出所有平台链接（分享口令、一行一个、混着说明文字都能认） */
export function splitPlatformLinks(raw: string): PlatformLink[] {
  const seen = new Set<string>();
  const out: PlatformLink[] = [];
  for (const candidate of extractUrls(raw)) {
    const parsed = parsePlatformLink(candidate);
    if (!parsed || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    out.push(parsed);
  }
  return out;
}

/**
 * 从任意文字里捞链接用的正则。
 *
 * 平台的「分享口令」长这样（都是 App 里点「复制链接」原样出来的）：
 *
 *   小红书：举手大喊：姐姐看我！… <https://xhslink.cn/o/8c7hpV57rvQ> 复制文本后进入【小红书】
 *   B站：   【李世民已经是太子，为什么还要强行继位？-哔哩哔哩】 <https://b23.tv/29inbIp>
 *
 * 共同点：链接被尖括号包着、紧贴中文没有空格、前后一堆无关文字。
 * 所以不能按空白切词 —— 按「域名 + 路径允许的字符集」扫，中文天然成为边界。
 */
const URL_RE =
  /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>"'“”‘’（）【】《》，。；：、！!？?…]*)?/gi;

/** 去掉分享口令里包在链接外面/粘在尾部的东西：尖括号、中文标点、句末英文标点 */
export function cleanUrlText(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^[<（(“"‘【《]+/, "")
    .replace(/[>）)”"’】》。，,；;、！!？?…]+$/g, "")
    .replace(/[.:]+$/, "");
}

/**
 * 从一段文字里取出所有链接（含没有 http:// 前缀的裸域名）。
 *
 * 顺序按出现顺序、去重；不做平台判断 —— 那是 parsePlatformLink 的事。
 */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of String(text ?? "").match(URL_RE) ?? []) {
    const cleaned = cleanUrlText(hit);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/** 判断这段文字里有没有平台链接，用于界面上给提示 */
export function hasPlatformLink(raw: string): boolean {
  return splitPlatformLinks(raw).length > 0;
}
