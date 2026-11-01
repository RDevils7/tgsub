import fs from "node:fs";
import path from "node:path";
import { db, getSettings } from "../db";
import { logger } from "../logger";
import { sanitizeSegment } from "../utils";
import { autoCoversFromVideo } from "./autocover";
import { markCoversFromDownload, saveCoverFromFile } from "./covers";
import { loadSharp } from "./sharp";

/**
 * 生成 Emby 可直接识别的本地媒体信息。
 *
 * 落盘结构（一集短剧）：
 *   美人局/
 *     美人局S01E04.mp4
 *     美人局S01E04.nfo      ← episodedetails，标题/集数/简介/标签
 *     tvshow.nfo            ← 剧集信息（Emby 剧集库读这个）
 *     poster.jpg            ← 竖版 2:3
 *     landscape.jpg         ← 横版 16:9
 *     fanart.jpg            ← 背景图 16:9
 *
 * 封面来自消息里随机挑的 3 张图片（下载时先落成 .art-N.jpg，这里再统一转成
 * Emby 认识的三张图并删除临时文件）。sharp 不可用时退化为原图复制。
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

function episodeTag(meta: EmbyMeta): string {
  const season = String(meta.season || 1).padStart(2, "0");
  if (meta.episode === null) return "";
  return `S${season}E${String(meta.episode).padStart(2, "0")}`;
}

function buildEpisodeNfo(meta: EmbyMeta): string {
  const tag = episodeTag(meta);
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
  if (meta.link) lines.push(`  <uniqueid type="telegram">${esc(meta.link)}</uniqueid>`);
  lines.push("</episodedetails>", "");
  return lines.join("\n");
}

function buildShowNfo(meta: EmbyMeta): string {
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
  if (meta.link) lines.push(`  <uniqueid type="telegram">${esc(meta.link)}</uniqueid>`);
  lines.push("</tvshow>", "");
  return lines.join("\n");
}

const assembling = new Set<string>();
const assemblePending = new Set<string>();

const stmtPendingArt = db.prepare<[string], { n: number }>(
  "SELECT COUNT(*) AS n FROM downloads WHERE save_dir = ? AND save_name LIKE '.art-%' AND status IN ('queued','downloading')",
);
/** 临时封面图属于哪个频道（.art 文件名里只带相册代表消息 id，频道 id 得从库里查） */
const stmtArtChannel = db.prepare<[string, string], { channel_id: number }>(
  "SELECT channel_id FROM downloads WHERE save_dir = ? AND save_name = ? LIMIT 1",
);

/** 还有封面图没下完：这时拼图会把正在写入的临时文件卷进去，必须等 */
function hasPendingArt(dir: string): boolean {
  const row = stmtPendingArt.get(path.basename(dir));
  return (row?.n ?? 0) > 0;
}

/**
 * 把目录里下载好的 .art-<消息id>-N.* 转成 poster/landscape/fanart 三张图。
 *
 * 返回：
 *  - "art"     已用消息图片生成
 *  - "pending" 还有封面图在下载，等它们下完再来
 *  - "none"    目录里没有封面图（调用方可以改用视频截帧兜底）
 */
export async function assembleArt(dir: string): Promise<"art" | "pending" | "none"> {
  if (assembling.has(dir)) {
    // 正在拼图时又有新图落地：记一笔，结束后再跑一遍，避免漏掉后到的封面
    assemblePending.add(dir);
    return "pending";
  }
  assembling.add(dir);
  try {
    if (hasPendingArt(dir)) return "pending";
    const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
    const arts = entries.filter((name) => /^\.art-[A-Za-z0-9-]+\.(jpe?g|png|webp)$/i.test(name)).sort();
    if (arts.length === 0) return "none";

    const sources = arts.map((name) => path.join(dir, name));
    const sharp = await loadSharp();

    // 按宽高比排序：最瘦的当竖版海报，最宽的当横版图与背景图
    const sized = await Promise.all(
      sources.map(async (file) => {
        if (!sharp) return { file, ratio: 1 };
        try {
          const meta = await sharp(file).metadata();
          const w = meta.width ?? 1;
          const h = meta.height ?? 1;
          return { file, ratio: h > 0 ? w / h : 1 };
        } catch {
          return { file, ratio: 1 };
        }
      }),
    );
    sized.sort((a, b) => a.ratio - b.ratio); // 从最宽到最瘦
    const widest = sized[0];
    const tallest = sized[sized.length - 1];
    const middle = sized.length > 1 ? sized[1] : widest;

    const plan: Array<{ target: string; source: string; width: number; height: number }> = [
      { target: "poster.jpg", source: tallest.file, width: 1000, height: 1500 },
      { target: "landscape.jpg", source: widest.file, width: 1920, height: 1080 },
      { target: "fanart.jpg", source: (middle ?? widest).file, width: 1920, height: 1080 },
    ];

    for (const item of plan) {
      const target = path.join(dir, item.target);
      try {
        if (sharp) {
          await sharp(item.source)
            .resize({ width: item.width, height: item.height, fit: "cover", position: "attention" })
            .jpeg({ quality: 90 })
            .toFile(target);
        } else {
          await fs.promises.copyFile(item.source, target);
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message, target: item.target }, "封面图生成失败，跳过");
      }
    }

    // 临时封面文件用完即删，避免混进媒体库。
    // 删之前先在监控历史的封面缓存里留一份，方便页面上回看这 3 张图。
    // 封面按「相册代表消息 id」归档：一条相册里 3 张图各自有不同的 message_id，
    // 但监控记录只有一条（组内最小 id），所以 key 取自文件名 .art-<代表id>-<序号>
    const owners = new Map<string, { channel_id: number; message_id: number }>();
    for (const name of arts) {
      const parsed = /^\.art-([A-Za-z0-9-]+?)-(\d+)\.[a-z0-9]+$/i.exec(name);
      if (!parsed) continue;
      const row = stmtArtChannel.get(path.basename(dir), name);
      if (!row) continue;
      const messageId = Number(parsed[1]);
      const index = Number(parsed[2]);
      if (!Number.isFinite(messageId) || !Number.isFinite(index)) continue;
      await saveCoverFromFile(row.channel_id, messageId, index, path.join(dir, name));
      owners.set(`${row.channel_id}-${messageId}`, { channel_id: row.channel_id, message_id: messageId });
    }
    for (const row of owners.values()) await markCoversFromDownload(row.channel_id, row.message_id);
    for (const file of sources) await fs.promises.unlink(file).catch(() => undefined);
    logger.info({ dir: path.basename(dir), art: arts.length }, "已生成 Emby 封面图");
    return "art";
  } finally {
    assembling.delete(dir);
    if (assemblePending.delete(dir)) void assembleArt(dir);
  }
}

/** 视频落盘后：写剧集 nfo + 剧集信息 + 封面 */
export async function finalizeMedia(filePath: string, rawMeta: string | null | undefined): Promise<void> {
  const meta = decodeMeta(rawMeta);
  if (!meta) return;
  const dir = path.dirname(filePath);

  try {
    if (meta.kind !== "art") {
      const base = path.basename(filePath, path.extname(filePath));
      const nfoPath = path.join(dir, `${sanitizeSegment(base, 120)}.nfo`);
      await fs.promises.writeFile(nfoPath, buildEpisodeNfo(meta), "utf8");

      const showPath = path.join(dir, "tvshow.nfo");
      if (!fs.existsSync(showPath)) {
        await fs.promises.writeFile(showPath, buildShowNfo(meta), "utf8");
      }
      logger.info({ nfo: path.basename(nfoPath) }, "已写入 Emby 媒体信息");
    }

    const art = await assembleArt(dir);
    // 消息里没有可用图片（或图片还没下完且压根没有）→ 用视频随机截帧兜底
    if (meta.kind !== "art" && art === "none") {
      let enabled = true;
      try {
        enabled = getSettings().auto_cover_frames && getSettings().emby_meta;
      } catch {
        enabled = false;
      }
      if (enabled) await autoCoversFromVideo(filePath, dir);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, dir }, "生成 Emby 媒体信息失败");
  }
}
