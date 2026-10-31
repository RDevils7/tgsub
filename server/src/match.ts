import { MatchMode, Subscription } from "./types";
import { splitKeywords } from "./utils";

export interface MatchResult {
  subscription: Subscription;
  keyword: string;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTester(mode: MatchMode, keyword: string): ((text: string) => boolean) | null {
  if (mode === "regex") {
    try {
      const re = new RegExp(keyword, "i");
      return (text) => re.test(text);
    } catch {
      return null;
    }
  }
  if (mode === "word") {
    // 前后不能紧跟字母/数字，中英文混合场景下比 \b 更可靠
    let re: RegExp;
    try {
      re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(keyword)}(?![\\p{L}\\p{N}])`, "iu");
    } catch {
      return (text) => text.toLowerCase().includes(keyword.toLowerCase());
    }
    return (text) => re.test(text);
  }
  const needle = keyword.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

const matcherCache = new Map<string, Array<{ keyword: string; test: (text: string) => boolean }>>();

function matchersFor(sub: Subscription) {
  const cacheKey = `${sub.id}:${sub.keywords}:${sub.match_mode}`;
  const cached = matcherCache.get(cacheKey);
  if (cached) return cached;

  const built: Array<{ keyword: string; test: (text: string) => boolean }> = [];
  for (const keyword of splitKeywords(sub.keywords)) {
    const test = buildTester(sub.match_mode, keyword);
    if (test) built.push({ keyword, test });
  }
  if (matcherCache.size > 500) matcherCache.clear();
  matcherCache.set(cacheKey, built);
  return built;
}

export function invalidateMatcherCache(): void {
  matcherCache.clear();
}

/** 判断文本是否命中任一启用的订阅，返回首个命中的订阅与关键词 */
export function matchText(text: string, subs: Subscription[], channelId: number): MatchResult | null {
  if (!text.trim()) return null;
  for (const sub of subs) {
    if (!sub.enabled) continue;
    let channelIds: number[] = [];
    try {
      const parsed = JSON.parse(sub.channel_ids || "[]");
      if (Array.isArray(parsed)) channelIds = parsed.map(Number).filter((n) => Number.isFinite(n));
    } catch {
      channelIds = [];
    }
    if (channelIds.length > 0 && !channelIds.includes(channelId)) continue;

    for (const m of matchersFor(sub)) {
      if (m.test(text)) return { subscription: sub, keyword: m.keyword };
    }
  }
  return null;
}

export function validateRegex(keywords: string): string | null {
  for (const keyword of splitKeywords(keywords)) {
    try {
      new RegExp(keyword, "i");
    } catch {
      return `正则表达式无效：${keyword}`;
    }
  }
  return null;
}
