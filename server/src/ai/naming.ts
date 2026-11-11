import { callAIJson, isAiEnabled } from "./client";
import { logger } from "../logger";

/**
 * AI 智能命名兜底（功能 B）。
 *
 * 正则命名（tg/naming.ts）在「正文是自由文本、没有《》也没有标准集数标记」时
 * 会整条失败（返回 null），此时下载会退回原名或「一链接一文件夹」。
 * 这里在正则彻底失败、但消息里确实有视频时，让 AI 再试一次，提取剧名 / 季 / 集。
 *
 * 只在「正则失败」时触发，不会每条消息都调 AI；且要先在设置里打开 ai_naming。
 */

export interface AiSeriesParse {
  /** 剧名（已去掉《》引号等包裹符号） */
  series: string;
  season?: number;
  /** 单集号（文件本身就是这一集） */
  episode?: number;
  /** 集数数组（正文声明了「第 1-7 集」这类） */
  episodes?: number[];
}

function cleanSeries(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[《》「」【】""''‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
  return text || "";
}

/**
 * 从消息正文里提取剧集信息。看不全文——只取第一段，避免把简介里的「第X集」带进来，
 * 也省 token。返回 null 表示 AI 也没认出剧名（调用方保持原有兜底逻辑）。
 */
export async function aiParseSeries(rawText: string): Promise<AiSeriesParse | null> {
  if (!rawText || !isAiEnabled()) return null;
  const firstPara = rawText.replace(/\r\n?/g, "\n").split(/\n{2,}/)[0] || rawText;
  const text = firstPara.trim().slice(0, 800);
  if (text.length < 4) return null;

  const system =
    "你是中文短视频/短剧的剧名与集数解析器。从用户给出的消息正文里提取：" +
    "剧名(series)、季(season,默认1)、单集号(episode)、或集数数组(episodes)。" +
    "规则：剧名不要带《》或引号；如果正文声明了「第1-7集」「EP1-10」这类用 episodes 数组；" +
    "如果只有单集用 episode；认不出剧名就返回空字符串。只输出 JSON：" +
    '{ "series": string, "season": number, "episode": number, "episodes": number[] }。';
  try {
    const r = await callAIJson<{
      series?: string;
      season?: number;
      episode?: number;
      episodes?: unknown;
    }>(system, `正文：\n${text}`, { maxTokens: 200, temperature: 0 });
    const series = cleanSeries(r.series);
    if (!series) return null;

    const episodes = Array.isArray(r.episodes)
      ? (r.episodes.filter((n) => typeof n === "number" && n > 0 && n <= 9999) as number[]).slice(0, 50)
      : undefined;

    return {
      series,
      season: typeof r.season === "number" && r.season > 0 ? r.season : undefined,
      episode: typeof r.episode === "number" && r.episode > 0 ? r.episode : undefined,
      episodes,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "AI 命名兜底解析失败");
    return null;
  }
}
