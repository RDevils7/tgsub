import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../db";
import { logger } from "../logger";
import { PlatformId } from "../types";
import { sanitizeSegment } from "../utils";
import { autoCoversFromVideo } from "./autocover";
import { fixTelegramLink } from "./entity";
import { applyCoversFromImage } from "../platform/cover";

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
  /** 平台（第三方下载）：决定封面 Referer，也用于日志 */
  platform?: PlatformId | null;
  /** 平台官方封面地址；有就用它做封面，没有再回退视频截帧 */
  cover?: string | null;
  /** 播放量 / 点赞 / 时长：Emby 没有对应字段，写进简介尾部 */
  views?: number | null;
  likes?: number | null;
  duration?: number | null;
  /** 分区 / 分类，写进 Emby 的 genre */
  categories?: string[];
}

export function encodeMeta(meta: EmbyMeta): string {
  return JSON.stringify(meta);
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
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
      cover: typeof parsed.cover === "string" && parsed.cover ? parsed.cover : null,
      views: toNumber(parsed.views),
      likes: toNumber(parsed.likes),
      duration: toNumber(parsed.duration),
      categories: Array.isArray(parsed.categories)
        ? parsed.categories.filter((item): item is string => typeof item === "string" && Boolean(item))
        : [],
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

/** 播放量这种大数按中文习惯折成「1.2 万」 */
function humanCount(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, "")} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
  return String(value);
}

function clock(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 简介。
 *
 * 小红书 的分享页很多时候没有正文，这时至少把标题和作者填进去，
 * 免得 Emby 详情页是一片空白。
 */
function plotOf(meta: EmbyMeta): string {
  const body = (meta.plot || "").trim();
  if (body) return body;
  const who = meta.studio ? `，来自 ${meta.studio}` : "";
  return `${meta.series}${who}`;
}

/** 播放量 / 点赞 / 时长：Emby 的 NFO 没有这几个标准字段，追加在简介尾部 */
function statsOf(meta: EmbyMeta): string {
  const parts: string[] = [];
  if (meta.views) parts.push(`播放 ${humanCount(meta.views)}`);
  if (meta.likes) parts.push(`点赞 ${humanCount(meta.likes)}`);
  if (meta.duration) parts.push(`时长 ${clock(meta.duration)}`);
  return parts.join(" · ");
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
  const plot = plotOf(meta);
  if (plot) {
    const stats = statsOf(meta);
    lines.push(`  <plot>${esc(stats ? `${plot}\n\n${stats}` : plot)}</plot>`);
    const outline = plot.replace(/\s+/g, " ").slice(0, 200);
    lines.push(`  <outline>${esc(outline)}</outline>`);
  }
  for (const genre of meta.categories ?? []) lines.push(`  <genre>${esc(genre)}</genre>`);
  for (const tagName of meta.tags) lines.push(`  <tag>${esc(tagName)}</tag>`);
  if (meta.studio) lines.push(`  <studio>${esc(meta.studio)}</studio>`);
  if (meta.duration) lines.push(`  <runtime>${Math.max(1, Math.round(meta.duration / 60))}</runtime>`);
  const date = isoDate(meta.airedAt);
  lines.push(`  <aired>${date}</aired>`);
  lines.push(`  <premiered>${date}</premiered>`);
  lines.push(`  <year>${new Date(meta.airedAt || Date.now()).getFullYear()}</year>`);
  lines.push(`  <uniqueid type="tgsub" default="true">${esc(`tgsub:${meta.series}:${tag || "movie"}`)}</uniqueid>`);
  const link = fixTelegramLink(meta.link);
  // 平台视频的「原链接」不是 Telegram 消息，标成 platform，Emby 详情页不会显示成 Telegram
  if (link) lines.push(`  <uniqueid type="${meta.platform ? "platform" : "telegram"}">${esc(link)}</uniqueid>`);
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
  const plot = plotOf(meta);
  if (plot) {
    const stats = statsOf(meta);
    lines.push(`  <plot>${esc(stats ? `${plot}\n\n${stats}` : plot)}</plot>`);
  }
  for (const genre of meta.categories ?? []) lines.push(`  <genre>${esc(genre)}</genre>`);
  for (const tagName of meta.tags) lines.push(`  <tag>${esc(tagName)}</tag>`);
  if (meta.studio) lines.push(`  <studio>${esc(meta.studio)}</studio>`);
  const date = isoDate(meta.airedAt);
  lines.push(`  <premiered>${date}</premiered>`);
  lines.push(`  <year>${new Date(meta.airedAt || Date.now()).getFullYear()}</year>`);
  lines.push("  <status>Continuing</status>");
  lines.push(`  <uniqueid type="tgsub" default="true">${esc(`tgsub:series:${meta.series}`)}</uniqueid>`);
  const link = fixTelegramLink(meta.link);
  // 平台视频的「原链接」不是 Telegram 消息，标成 platform，Emby 详情页不会显示成 Telegram
  if (link) lines.push(`  <uniqueid type="${meta.platform ? "platform" : "telegram"}">${esc(link)}</uniqueid>`);
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

/** errno 是否属于「没有写权限」这一类 */
export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function hasUserWrite(mode: number): boolean {
  return (mode & 0o200) !== 0;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/**
 * 权限类错误的可读诊断：哪个目录、当前身份、目录属主、怎么修。
 *
 * 写 .nfo 失败不等于下载失败——视频已经在盘上了，不说清这点用户会以为整条废了。
 */
export function buildWritePermissionHint(dir: string, file: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "EACCES";
  const uid = currentUid();
  const gid = typeof process.getgid === "function" ? process.getgid() : -1;
  let owner = "未知（目录 stat 失败）";
  try {
    const st = fs.statSync(dir);
    owner =
      process.platform === "win32"
        ? `权限 ${modeText(st.mode)}`
        : `uid=${st.uid} gid=${st.gid} 权限 ${modeText(st.mode)}`;
  } catch {
    // 目录都读不到时保持未知，下面的通用建议仍然成立
  }

  const lines = [
    `视频已落盘，只是媒体信息写不进去：${file}`,
    `目录：${dir}`,
    `运行身份：uid=${uid} gid=${gid}；目录属主：${owner}`,
  ];

  if (code === "EROFS") {
    lines.push(
      "原因：这个挂载点是只读的，容器没有写权限。",
      "处理：docker-compose.yml 里对应卷去掉 `:ro`，再 docker compose up -d。",
    );
    return lines.join("\n");
  }

  lines.push(
    "原因：目录或同名 .nfo 属于别的账号（老版本以 root 跑过、或文件是从别处拷进来的），当前用户写不进去。",
    "处理（任选其一，都不用重新下载，重跑该条目即可补上）：",
    '  1) 容器加 CHOWN_RECURSE: "1" 重启一次，把历史文件属主一起改成运行账号；',
    "  2) 宿主机上直接改属主（1000:1000 换成你的 PUID/PGID）：",
    `       sudo chown -R 1000:1000 <宿主机上 ${path.basename(dir)} 对应的目录>`,
    "  3) 目录来自 SMB/CIFS 共享时 chown 无效，把 PUID/PGID 改成该共享账号的 uid/gid。",
  );
  return lines.join("\n");
}

/**
 * 属主是当前用户、但权限位缺写时补上，返回 true 表示值得重试一次。
 *
 * 属主不是自己时不做无用功（改了也会被拒），这种情况只能由用户改属主。
 */
async function relaxWriteTarget(file: string, dir: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  const uid = currentUid();
  if (uid < 0) return false;

  // 先看文件本身：老版本以 root 写的 .nfo 可能是 0444，目录能写也覆盖不了
  try {
    const st = await fs.promises.stat(file);
    if (st.uid === uid && !hasUserWrite(st.mode)) {
      await fs.promises.chmod(file, st.mode | 0o200);
      logger.info({ file: path.basename(file) }, "媒体信息文件是只读的，已自动加上写权限并重试");
      return true;
    }
  } catch {
    // 文件不存在，问题只可能在目录
  }

  try {
    const st = await fs.promises.stat(dir);
    if (st.uid === uid && !hasUserWrite(st.mode)) {
      await fs.promises.chmod(dir, st.mode | 0o200);
      logger.info({ dir: path.basename(dir) }, "剧集目录缺少写权限位，已自动补上并重试");
      return true;
    }
  } catch {
    // 目录不可 stat：交给上层报错
  }
  return false;
}

/** 写媒体信息文件；权限类失败先尝试自救，再重试一次 */
async function writeMediaFile(file: string, data: string, dir: string): Promise<void> {
  try {
    await fs.promises.writeFile(file, data, "utf8");
  } catch (err) {
    if (!isPermissionError(err) || !(await relaxWriteTarget(file, dir))) throw err;
    await fs.promises.writeFile(file, data, "utf8");
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
      await writeMediaFile(nfoPath, buildEpisodeNfo(meta), dir);

      const showPath = path.join(dir, "tvshow.nfo");
      if (!fs.existsSync(showPath)) {
        await writeMediaFile(showPath, buildShowNfo(meta), dir);
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

      // 封面优先用平台的官方封面（构图和画质都比截帧好），没有再回退视频截帧。
      // 第三方平台的每条视频是独立目录、没有集号，所以 isFirst 用「目录里还没有图」来判断
      let enabled = true;
      try {
        enabled = getSettings().emby_meta && getSettings().auto_cover_frames;
      } catch {
        enabled = false;
      }
      if (enabled) {
        const isFirst = meta.episode === 1 || meta.episode === null;
        const fromImage = await applyCoversFromImage(meta.cover ?? null, dir, {
          base,
          isFirst,
          platform: meta.platform ?? null,
        });
        // 官方封面已经写好的文件名，截帧不会再覆盖（autoCoversFromVideo 只补缺的）
        await autoCoversFromVideo(filePath, dir, {
          base,
          // 第一集（或无集号的单视频）才动剧集目录的三张封面
          series: isFirst && fromImage.length === 0 ? "force" : "if-missing",
        });
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const hint = isPermissionError(err) ? `\n${buildWritePermissionHint(dir, path.basename(filePath), err)}` : "";
    logger.warn(
      { err: e.message, code: e.code ?? null, dir: path.basename(dir), series: meta.series, episode: meta.episode },
      `生成 Emby 媒体信息失败：${label}${hint}`,
    );
  }
}
