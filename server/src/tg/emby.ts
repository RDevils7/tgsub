import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../db";
import { logger } from "../logger";
import { sanitizeSegment } from "../utils";
import { autoCoversFromVideo } from "./autocover";
import { fixTelegramLink } from "./entity";

/**
 * 生成 Emby 可直接识别的本地媒体信息。
 *
 * 落盘结构（一集短剧）：
 *   美人局/
 *     美人局S01E01.mp4
 *     美人局S01E01.nfo       ← episodedetails，标题/集数/简介/标签
 *     美人局S01E01-thumb.jpg ← 这一集的缩略图（视频随机截帧）
 *     美人局S01E02.mp4
 *     美人局S01E02-thumb.jpg
 *     tvshow.nfo             ← 剧集信息（Emby 剧集库读这个）
 *     poster.jpg             ← 竖版 2:3，取自第一集
 *     landscape.jpg          ← 横版 16:9，取自第一集
 *     fanart.jpg             ← 背景图 16:9，取自第一集
 *
 * 所有图片都由 ffmpeg 从视频里随机截帧生成，不再下载消息中的图片：
 * 消息里的图片既占带宽，又常常是「第几集」的水印图，做封面并不好看。
 */

export interface EmbyMeta {
  series: string;
  season: number;
  episode: number | null;
  /** 正文首行，作为标题兜底 */
  firstLine: string;
  plot: string;
  tags: string[];
  /** 频道名，写进 studio */
  studio: string | null;
  /** 原消息链接 */
  link: string | null;
  airedAt: number;
  messageId: number;
  kind: "video" | "art";
}

export function encodeMeta(meta: EmbyMeta): string {
  return JSON.stringify(meta);
}

export function decodeMeta(raw: string | null | undefined): EmbyMeta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EmbyMeta;
    if (!parsed || typeof parsed.series !== "string" || !parsed.series) return null;
    return {
      ...parsed,
      season: Number(parsed.season) || 1,
      episode: parsed.episode === null || parsed.episode === undefined ? null : Number(parsed.episode),
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean) : [],
      plot: typeof parsed.plot === "string" ? parsed.plot : "",
    };
  } catch {
    return null;
  }
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

function isoDate(ts: number): string {
  const d = new Date(ts || Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `S01E04` 形式的集号；没有集数时返回空串。日志里也用它拼可读标识 */
export function formatEpisodeTag(meta: EmbyMeta): string {
  const season = String(meta.season || 1).padStart(2, "0");
  if (meta.episode === null) return "";
  return `S${season}E${String(meta.episode).padStart(2, "0")}`;
}

/** 「剧名 S01E04」；没有集数时只有剧名。日志与错误提示统一用它 */
export function describeMeta(meta: EmbyMeta): string {
  const tag = formatEpisodeTag(meta);
  return tag ? `${meta.series} ${tag}` : meta.series;
}

export function buildEpisodeNfo(meta: EmbyMeta): string {
  const tag = formatEpisodeTag(meta);
  const title = meta.episode !== null ? `${meta.series} ${tag}` : meta.series;
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<episodedetails>",
    `  <title>${esc(title)}</title>`,
    `  <originaltitle>${esc(meta.series)}</originaltitle>`,
    `  <showtitle>${esc(meta.series)}</showtitle>`,
  ];
  if (meta.episode !== null) {
    lines.push(`  <season>${meta.season || 1}</season>`);
    lines.push(`  <episode>${meta.episode}</episode>`);
  }
  if (meta.plot) {
    lines.push(`  <plot>${esc(meta.plot)}</plot>`);
    const outline = meta.plot.replace(/\s+/g, " ").slice(0, 200);
    lines.push(`  <outline>${esc(outline)}</outline>`);
  }
  for (const tagName of meta.tags) lines.push(`  <tag>${esc(tagName)}</tag>`);
  if (meta.studio) lines.push(`  <studio>${esc(meta.studio)}</studio>`);
  const date = isoDate(meta.airedAt);
  lines.push(`  <aired>${date}</aired>`);
  lines.push(`  <premiered>${date}</premiered>`);
  lines.push(`  <year>${new Date(meta.airedAt || Date.now()).getFullYear()}</year>`);
  lines.push(`  <uniqueid type="tgsub" default="true">${esc(`tgsub:${meta.series}:${tag || "movie"}`)}</uniqueid>`);
  const link = fixTelegramLink(meta.link);
  if (link) lines.push(`  <uniqueid type="telegram">${esc(link)}</uniqueid>`);
  lines.push("</episodedetails>", "");
  return lines.join("\n");
}

export function buildShowNfo(meta: EmbyMeta): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<tvshow>",
    `  <title>${esc(meta.series)}</title>`,
    `  <originaltitle>${esc(meta.series)}</originaltitle>`,
  ];
  if (meta.plot) lines.push(`  <plot>${esc(meta.plot)}</plot>`);
  for (const tagName of meta.tags) lines.push(`  <tag>${esc(tagName)}</tag>`);
  if (meta.studio) lines.push(`  <studio>${esc(meta.studio)}</studio>`);
  const date = isoDate(meta.airedAt);
  lines.push(`  <premiered>${date}</premiered>`);
  lines.push(`  <year>${new Date(meta.airedAt || Date.now()).getFullYear()}</year>`);
  lines.push("  <status>Continuing</status>");
  lines.push(`  <uniqueid type="tgsub" default="true">${esc(`tgsub:series:${meta.series}`)}</uniqueid>`);
  const link = fixTelegramLink(meta.link);
  if (link) lines.push(`  <uniqueid type="telegram">${esc(link)}</uniqueid>`);
  lines.push("</tvshow>", "");
  return lines.join("\n");
}

/**
 * 删掉老版本留下的临时封面图（`.art-<消息id>-N.jpg`）。
 * 1.0.2 起封面改为视频截帧，这些文件不再产生；留着会混进媒体库，顺手清理。
 */
async function cleanupLegacyArt(dir: string): Promise<void> {
  const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    if (!/^\.art-[A-Za-z0-9-]+\.(jpe?g|png|webp)$/i.test(name)) continue;
    await fs.promises.unlink(path.join(dir, name)).catch(() => undefined);
    removed += 1;
  }
  if (removed > 0) {
    logger.info({ dir: path.basename(dir), removed }, `清理老版本遗留的临时封面图 ${removed} 个`);
  }
}

/** 视频落盘后：写剧集 nfo + 剧集信息 + 本集缩略图与剧集封面 */
export async function finalizeMedia(filePath: string, rawMeta: string | null | undefined): Promise<void> {
  const meta = decodeMeta(rawMeta);
  if (!meta) return;
  const dir = path.dirname(filePath);
  const label = describeMeta(meta);
  const base = path.basename(filePath, path.extname(filePath));

  try {
    if (meta.kind !== "art") {
      const nfoPath = path.join(dir, `${sanitizeSegment(base, 120)}.nfo`);
      await fs.promises.writeFile(nfoPath, buildEpisodeNfo(meta), "utf8");

      const showPath = path.join(dir, "tvshow.nfo");
      if (!fs.existsSync(showPath)) {
        await fs.promises.writeFile(showPath, buildShowNfo(meta), "utf8");
      }
      logger.info(
        {
          series: meta.series,
          season: meta.season,
          episode: meta.episode,
          messageId: meta.messageId,
          dir: path.basename(dir),
          nfo: path.basename(nfoPath),
        },
        `已写入 Emby 媒体信息：${label} → ${path.basename(nfoPath)}`,
      );

      await cleanupLegacyArt(dir);

      // 封面一律来自视频截帧：本集生成 <剧集集名>-thumb.jpg，
      // 第一集顺便定下剧集目录的 poster / landscape / fanart
      let enabled = true;
      try {
        enabled = getSettings().emby_meta && getSettings().auto_cover_frames;
      } catch {
        enabled = false;
      }
      if (enabled) {
        await autoCoversFromVideo(filePath, dir, {
          base,
          isFirst: meta.episode === 1,
        });
      }
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, dir: path.basename(dir), series: meta.series, episode: meta.episode },
      `生成 Emby 媒体信息失败：${label}`,
    );
  }
}
