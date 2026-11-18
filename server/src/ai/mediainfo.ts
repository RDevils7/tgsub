import { callAIJson, isAiEnabled } from "./client";
import { logger } from "../logger";

/**
 * AI 媒体信息整理（增强“智能命名”）。
 *
 * 场景：手动给一个下载链接（网页 / m3u8 / 平台）时，自动识别出的标题常常是
 * 「某某视频网」「站点名」「一串 hash」这类毫无意义的名字。这里让 AI 读一读
 * 网页标题 / 描述 / 站点名 / 分享文案 / 原始文件名，整理出：
 *   - 干净的作品名（用于目录与文件名）
 *   - 剧名 / 季 / 集（系列短剧）
 *   - 简介、标签（用于 NFO / 媒体库展示）
 *
 * 只在标题“看起来不可靠”时调用，失败不影响下载（调用方沿用原解析结果）。
 */

export interface AiMediaInfo {
  title: string;
  series?: string;
  season?: number;
  episode?: number;
  plot?: string;
  tags?: string[];
}

export interface AiMediaInfoInput {
  url?: string;
  pageTitle?: string | null;
  pageDescription?: string | null;
  siteName?: string | null;
  caption?: string | null;
  guessedName?: string | null;
  platform?: string | null;
  extra?: string | null;
}

/** 站名 / 通用噪声词：命中就认为这个标题不能直接当作品名 */
const GENERIC_TITLE_RE =
  /在线观看|在线播放|免费在线|免费观看|高清|蓝光|超清|完整版|无删减|全集|最新|热门|推荐|视频|影视|影院|短剧网|视频网|资源站|资源网|网盘|下载|播放|观看|首页|官网|官方网站|客户端|app|www\.|https?:/i;

/**
 * 判断自动识别出的标题是否“不可靠”（值得交给 AI 重整）。
 *
 * 命中任一即视为不可靠：空 / 默认名 / 太短 / 含站点名 / 含域名 / 含通用噪声词 /
 * 纯 hash / 没有中英文可读字符。
 */
export function titleLooksUnreliable(
  title: string | null | undefined,
  opts: { url?: string; siteName?: string | null } = {},
): boolean {
  const t = String(title ?? "").trim();
  if (!t || t === "video" || t === "未命名视频" || t.length <= 2) return true;

  const low = t.toLowerCase();
  if (opts.siteName) {
    const s = String(opts.siteName).trim().toLowerCase();
    if (s && (low === s || low.includes(s))) return true;
  }
  if (opts.url) {
    try {
      const host = new URL(opts.url).hostname.replace(/^www\./, "");
      const bare = (host.split(".")[0] ?? "").toLowerCase();
      if (bare.length >= 3 && low.includes(bare)) return true;
    } catch {
      /* url 非法就跳过 */
    }
  }
  if (GENERIC_TITLE_RE.test(t)) return true;
  if (/^[a-f0-9]{16,}$/i.test(t)) return true; // 纯 hash
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(t)) return true; // 没有任何中英文字母
  return false;
}

/** 把 AI 给的标题清洗成可做文件 / 目录名的字符串 */
export function sanitizeAiTitle(raw: string | null | undefined): string {
  let t = String(raw ?? "")
    .replace(/[《》「」【】“”‘’]/g, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/[.。,，、\-–—_|]+$/g, "").trim();
  if (t.length > 80) t = t.slice(0, 80).trim();
  return t;
}

function clip(text: string | null | undefined, max: number): string {
  return String(text ?? "").trim().slice(0, max);
}

/**
 * 调 AI 整理媒体信息。返回 null 表示未启用 / 信息不足 / 调用失败（调用方沿用原结果）。
 */
export async function aiGenerateMediaInfo(input: AiMediaInfoInput): Promise<AiMediaInfo | null> {
  if (!isAiEnabled()) return null;

  const parts: string[] = [];
  if (input.platform) parts.push(`来源平台：${input.platform}`);
  if (input.url) parts.push(`链接：${clip(input.url, 500)}`);
  if (input.siteName) parts.push(`站点名：${clip(input.siteName, 100)}`);
  if (input.pageTitle) parts.push(`网页标题：${clip(input.pageTitle, 300)}`);
  if (input.pageDescription) parts.push(`网页描述：${clip(input.pageDescription, 900)}`);
  if (input.caption) parts.push(`分享文案/消息：${clip(input.caption, 900)}`);
  if (input.guessedName) parts.push(`自动识别的原始名称（可能不准）：${clip(input.guessedName, 200)}`);
  if (input.extra) parts.push(clip(input.extra, 600));
  const body = parts.join("\n").trim();
  if (body.length < 4) return null;

  const system =
    "你是影视 / 短剧 / 视频的媒体信息整理助手。根据给出的网页标题、描述、站点名、分享文案或原始文件名，" +
    "判断这是一个什么作品，并整理出规范的中文信息。" +
    "要求：1) title 是干净的作品名，去掉站点名 / 域名 / “在线观看”“高清”“免费”“下载”“首页”等噪声词与结尾站名；" +
    "2) 如果是系列短剧，series 为剧名、season 默认 1、能识别就填 episode 集号；单集视频 series 可与 title 相同、episode 省略；" +
    "3) plot 用 1~3 句客观简洁的中文简介（信息不足就概括主题，不要编造具体情节细节）；" +
    "4) tags 为 3~6 个中文标签（题材 / 类型 / 来源等）；" +
    "5) 不要输出链接、站名或无意义的空话。只输出 JSON：" +
    '{ "title": string, "series": string, "season": number, "episode": number, "plot": string, "tags": string[] }。';

  try {
    const r = await callAIJson<{
      title?: string;
      series?: string;
      season?: number;
      episode?: number;
      plot?: string;
      tags?: unknown;
    }>(system, body, { maxTokens: 450, temperature: 0.3, timeoutMs: 20_000 });

    const title = sanitizeAiTitle(r.title);
    if (!title) return null;

    const tags = Array.isArray(r.tags)
      ? r.tags
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => sanitizeAiTitle(x).slice(0, 20))
          .filter(Boolean)
          .slice(0, 6)
      : undefined;

    return {
      title,
      series: sanitizeAiTitle(r.series) || title,
      season: typeof r.season === "number" && r.season > 0 ? Math.round(r.season) : undefined,
      episode: typeof r.episode === "number" && r.episode > 0 ? Math.round(r.episode) : undefined,
      plot: typeof r.plot === "string" ? clip(r.plot, 1000) : undefined,
      tags,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "AI 媒体信息整理失败");
    return null;
  }
}
