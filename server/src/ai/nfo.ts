import fs from "node:fs";
import path from "node:path";
import { callAIJson, isAiEnabled } from "./client";
import { logger } from "../logger";
import { mapLimit } from "../lib/async";
import { collectStrmFiles, ensureStrmNfo } from "../tg/strmnfo";
import { isStrmFile, strmNfoPath } from "../tg/mediapath";
import { deriveEpisodeInfo } from "../tg/mediatree";

/**
 * AI 补全媒体信息（功能 A）。
 *
 * 场景：`.strm` 文件的单集 NFO 现在只有剧名 / 季 / 集（从文件名推），
 * `plot / outline / genre / tag` 全是空的，Emby 详情页一片空白。
 * 这里让 AI 根据「剧名 + 集数」推测题材类型、标签与一句简介，补进 NFO。
 *
 * 三条硬约束（与 strmnfo 一致）：
 * 1. 只补「我们自己生成、且还没有 plot」的 NFO —— 用户手工改过的（有 plot）不动；
 *    已用 AI 补过的打上 `<!-- tgsub-ai -->` 标记，不再重复花额度。
 * 2. 纯文本 LLM，不读视频、不上传任何帧，契合「本地 strm 不回源」。
 * 3. 推测出来的内容会明确是「基于标题推测」，不会伪装成真实剧情。
 */

/** 注入到 NFO 的标记：有了它就不再二次补，也便于一眼区分 AI 生成内容 */
const AI_MARKER = "<!-- tgsub-ai -->";

export interface AiNfoFields {
  plot: string;
  outline: string;
  genres: string[];
  tags: string[];
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function esc(value: string): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/** 清理 AI 返回的文本：去首尾空白、折叠多余空行、限长 */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把 AI 返回的一维数组规整成合法标签（去空白、限长、限个数） */
function cleanTags(value: unknown, maxCount: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const t = cleanText(item, maxLen);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * 让 AI 根据「剧名 + 季 + 集」推测媒体信息。
 * 模型看不到视频，所以内容是「基于标题推测」的，prompt 里也要求它诚实标注。
 */
export async function aiEnrichEpisode(
  series: string,
  season: number,
  episode: number | null,
): Promise<AiNfoFields | null> {
  if (!series || !isAiEnabled()) return null;
  const epPart = episode ? ` 第 ${season} 季 第 ${episode} 集` : ` 第 ${season} 季`;
  const system =
    "你是影视元数据补全助手。用户只提供剧名和集数，你根据剧名推测这部的" +
    "题材类型(genre)、标签(tag)和一句简介(plot)，以及一句更短的概述(outline)。" +
    "注意：你看不到正片，所有内容都要基于剧名合理推测，并在 plot 开头说明「（根据标题推测）」。" +
    "genres 是 1-3 个宽泛中文类型（如 短剧/都市/悬疑/古装/甜宠/逆袭）；" +
    "tags 是 1-5 个更细的关键词；plot 2-3 句话；outline 不超过 40 字。";
  const user = `剧名：${series}${epPart}\n只输出 JSON：{ "genres": string[], "tags": string[], "outline": string, "plot": string }`;
  try {
    const r = await callAIJson<{
      genres?: unknown;
      tags?: unknown;
      outline?: unknown;
      plot?: unknown;
    }>(system, user, { maxTokens: 400, temperature: 0.4 });
    const plot = cleanText(r.plot, 600);
    if (!plot) return null;
    return {
      plot,
      outline: cleanText(r.outline, 120),
      genres: cleanTags(r.genres, 3, 12),
      tags: cleanTags(r.tags, 6, 16),
    };
  } catch (err) {
    logger.warn({ series, episode, err: (err as Error).message }, "AI 补全媒体信息失败");
    return null;
  }
}

/** 把 AI 字段拼进一段 NFO 文本（紧贴根节点闭合标签之前） */
function mergeAiFields(nfoText: string, fields: AiNfoFields): string {
  const rootClose = nfoText.includes("</tvshow>")
    ? "</tvshow>"
    : nfoText.includes("</episodedetails>")
      ? "</episodedetails>"
      : null;
  if (!rootClose) return nfoText;

  const lines: string[] = [];
  if (fields.plot) {
    lines.push(`  <plot>${esc(fields.plot)}</plot>`);
    if (fields.outline) lines.push(`  <outline>${esc(fields.outline)}</outline>`);
  }
  for (const g of fields.genres) lines.push(`  <genre>${esc(g)}</genre>`);
  for (const t of fields.tags) lines.push(`  <tag>${esc(t)}</tag>`);
  lines.push(`  ${AI_MARKER}`);

  return nfoText.replace(rootClose, `${lines.join("\n")}\n${rootClose}`);
}

/** 判断一段 NFO 是否还需要 AI 补全（有 plot 或已补过就跳过） */
function needsEnrich(nfoText: string): boolean {
  if (nfoText.includes(AI_MARKER)) return false;
  const plotMatch = nfoText.match(/<plot>([\s\S]*?)<\/plot>/i);
  if (plotMatch && plotMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim()) return false;
  return true;
}

export type EnrichResult = "enriched" | "skipped" | "failed";

/** 给单个 strm 的 NFO 补 AI 媒体信息（不存在先生成空壳 NFO） */
export async function enrichStrmNfoFile(file: string): Promise<EnrichResult> {
  const abs = path.resolve(file);
  if (!isStrmFile(abs)) return "failed";
  const nfo = strmNfoPath(abs);
  try {
    await ensureStrmNfo(abs);
    if (!fs.existsSync(nfo)) return "skipped";
    const current = fs.readFileSync(nfo, "utf8");
    if (!needsEnrich(current)) return "skipped";

    const info = deriveEpisodeInfo(path.basename(abs), path.basename(path.dirname(abs)));
    const fields = await aiEnrichEpisode(info.series, info.season ?? 1, info.episode);
    if (!fields) return "skipped";

    const next = mergeAiFields(current, fields);
    if (next === current) return "skipped";
    fs.writeFileSync(nfo, next, "utf8");
    return "enriched";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
    logger.warn({ file: abs, err: (err as Error).message }, "strm NFO 的 AI 补全写入失败");
    return "failed";
  }
}

/** 给一个剧集目录的 tvshow.nfo 补 AI 媒体信息 */
export async function enrichShowNfo(seriesDir: string): Promise<EnrichResult> {
  const abs = path.resolve(seriesDir);
  const nfo = path.join(abs, "tvshow.nfo");
  if (!fs.existsSync(nfo)) return "skipped";
  try {
    const current = fs.readFileSync(nfo, "utf8");
    if (!needsEnrich(current)) return "skipped";
    const series = path.basename(abs);
    const fields = await aiEnrichEpisode(series, 1, null);
    if (!fields) return "skipped";
    const next = mergeAiFields(current, fields);
    if (next === current) return "skipped";
    fs.writeFileSync(nfo, next, "utf8");
    return "enriched";
  } catch (err) {
    logger.warn({ dir: abs, err: (err as Error).message }, "tvshow.nfo 的 AI 补全写入失败");
    return "failed";
  }
}

export interface StrmAiNfoSummary {
  scanned: number;
  enriched: number;
  skipped: number;
  failed: number;
  truncated: boolean;
}

/** 一个目录下所有缺媒体信息的 strm：先补单集 NFO，再补剧集 NFO，并发受控 */
export async function enrichStrmNfos(dir: string): Promise<StrmAiNfoSummary> {
  const root = path.resolve(dir);
  const files = collectStrmFiles(root);
  const truncated = files.length >= 5000;

  const epResults = await mapLimit(files, 3, (file) => enrichStrmNfoFile(file));
  const dirs = [...new Set(files.map((f) => path.dirname(f)))];
  const showResults = await mapLimit(dirs, 3, (d) => enrichShowNfo(d));

  const summary: StrmAiNfoSummary = {
    scanned: files.length,
    enriched: 0,
    skipped: 0,
    failed: 0,
    truncated,
  };
  for (const r of [...epResults, ...showResults]) {
    if (r === "enriched") summary.enriched += 1;
    else if (r === "skipped") summary.skipped += 1;
    else summary.failed += 1;
  }
  if (summary.enriched > 0 || summary.failed > 0) {
    logger.info({ dir: root, ...summary }, "strm AI 媒体信息补全");
  }
  return summary;
}
