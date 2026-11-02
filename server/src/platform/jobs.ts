import path from "node:path";
import { db, ensurePlatformChannel, getPlatformCookie, getSettings, PLATFORM_CHANNEL_TITLE } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { encodeMeta, EmbyMeta } from "../tg/emby";
import { PlatformId } from "../types";
import { sanitizeSegment } from "../utils";
import { PlatformLink } from "./detect";
import { platformName, probePlatform } from "./ytdlp";
import { downloader } from "../tg/downloader";

/**
 * 第三方链接入队。
 *
 * 任务写进 downloads 表（source='platform'），和 Telegram 下载共用一套队列、
 * 进度、重试、列表与 Emby 收尾逻辑；区别只在 run() 里换成了 yt-dlp。
 */

export interface PlatformTask {
  platform: PlatformId;
  url: string;
  id: string | null;
  title: string;
  uploader: string;
  duration: number | null;
  taskId: number | null;
  existing: boolean;
  saveDir: string;
  filesize: number | null;
}

/** 单条链接是否已经在队列里/下过了 */
function findExisting(url: string, fileName: string): { id: number; status: string } | null {
  const row = db
    .prepare(
      "SELECT id, status FROM downloads WHERE source = 'platform' AND (source_url = ? OR file_name = ?) " +
        "ORDER BY id DESC LIMIT 1",
    )
    .get(url, fileName) as { id: number; status: string } | undefined;
  return row ?? null;
}

/**
 * 目录：<平台根>/<平台>/<UP主>/<标题> [id]
 *
 * 每条视频一个目录：Emby 里就是一个独立条目，tvshow.nfo / 封面不会互相覆盖；
 * UP主 这一层让同一作者的内容排在一起，方便人工浏览。
 */
export function platformSaveDir(
  platform: PlatformId,
  uploader: string,
  title: string,
  id: string,
  root: string,
): string {
  const parts = [
    sanitizeSegment(root || "第三方", 40),
    platformName(platform),
    sanitizeSegment(uploader || "未知作者", 40),
    sanitizeSegment(`${title}${id ? ` [${id}]` : ""}`, 80),
  ].filter(Boolean);
  return parts.join("/");
}

/** 解析 + 入队一条链接；解析失败直接抛出可读原因 */
export async function enqueuePlatformLink(link: PlatformLink): Promise<PlatformTask> {
  const settings = getSettings();
  if (!settings.platform_enabled) {
    throw new Error("第三方平台下载未启用：请到设置 → 第三方平台打开开关");
  }

  const cookie = getPlatformCookie(link.platform);
  const probe = await probePlatform(link.url, link.platform, cookie);

  const fileName = `${probe.title}${probe.id ? ` [${probe.id}]` : ""}`.slice(0, 200);
  const existing = findExisting(link.url, fileName);
  const saveDir = platformSaveDir(link.platform, probe.uploader, probe.title, probe.id, settings.platform_dir);

  if (existing && existing.status !== "failed" && existing.status !== "stopped") {
    return {
      platform: link.platform,
      url: link.url,
      id: link.id,
      title: probe.title,
      uploader: probe.uploader,
      duration: probe.duration,
      taskId: existing.id,
      existing: true,
      saveDir,
      filesize: probe.filesize,
    };
  }

  // 已存在但失败/停止的：复用同一行重试，避免列表里出现两条一样的记录
  if (existing) {
    db.prepare("UPDATE downloads SET file_size = ? WHERE id = ?").run(probe.filesize ?? 0, existing.id);
    downloader.retry(existing.id);
    logger.info(
      { id: existing.id, platform: link.platform, title: probe.title },
      `第三方任务重新入队：${probe.title}`,
    );
    return {
      platform: link.platform,
      url: link.url,
      id: link.id,
      title: probe.title,
      uploader: probe.uploader,
      duration: probe.duration,
      taskId: existing.id,
      existing: false,
      saveDir,
      filesize: probe.filesize,
    };
  }

  const meta: EmbyMeta = {
    // series 用标题：每条视频一个独立剧集目录，tvshow.nfo 不会互相覆盖
    series: probe.title,
    season: 1,
    episode: null,
    firstLine: probe.title,
    plot: probe.description.slice(0, 2000),
    tags: [platformName(link.platform), ...(probe.uploader ? [probe.uploader] : [])],
    studio: probe.uploader || platformName(link.platform),
    link: link.url,
    airedAt: probe.uploadedAt ?? Date.now(),
    messageId: 0,
    kind: "video",
  };

  const channelId = ensurePlatformChannel();
  const info = db
    .prepare(
      `INSERT INTO downloads
         (channel_id, channel_title, message_id, file_name, file_size, mime_type, media_kind,
          status, progress, downloaded_bytes, created_at, save_dir, save_name, emby_json, source, source_url)
       VALUES (?, ?, 0, ?, ?, 'video/mp4', 'video', 'queued', 0, 0, ?, ?, ?, ?, 'platform', ?)`,
    )
    .run(
      channelId,
      PLATFORM_CHANNEL_TITLE,
      fileName,
      probe.filesize ?? 0,
      Date.now(),
      saveDir,
      // 真实扩展名由 yt-dlp 决定（可能是 mkv/webm），下载完成后回填
      `${sanitizeSegment(probe.title, 120)}.mp4`,
      encodeMeta(meta),
      link.url,
    );

  const taskId = Number(info.lastInsertRowid);
  downloader.enqueue([taskId]);
  logger.info(
    { id: taskId, platform: link.platform, uploader: probe.uploader, dir: saveDir },
    `第三方任务已入队：${probe.title}（${platformName(link.platform)}）`,
  );

  return {
    platform: link.platform,
    url: link.url,
    id: link.id,
    title: probe.title,
    uploader: probe.uploader,
    duration: probe.duration,
    taskId,
    existing: false,
    saveDir,
    filesize: probe.filesize,
  };
}

/** 平台状态：给设置页显示「有没有配 Cookie / yt-dlp 是哪个版本」 */
export function platformRootDir(): string {
  return path.join(env.downloadDir, getSettings().platform_dir || "第三方");
}

/* ------------------------------------------------------------------ */
/* 批量入队（手动下载页 / 机器人共用）                                  */
/* ------------------------------------------------------------------ */

export interface PlatformQueued {
  platform: PlatformId;
  url: string;
  ok: boolean;
  title: string | null;
  uploader: string | null;
  /** 之前已经在队列里或下过了 */
  existing: boolean;
  taskId: number | null;
  error: string | null;
}

/**
 * 一串链接逐个解析入队；单条失败不影响其余。
 *
 * 给「机器人收到分享口令」「手动下载页一次粘一堆」用：那边只需要结果摘要，
 * 不想为了单条失败把整批都抛出去。
 */
export async function enqueuePlatformLinks(links: PlatformLink[]): Promise<PlatformQueued[]> {
  const settings = getSettings();
  const out: PlatformQueued[] = [];
  for (const link of links) {
    if (!settings.platform_enabled) {
      out.push({
        platform: link.platform,
        url: link.url,
        ok: false,
        title: null,
        uploader: null,
        existing: false,
        taskId: null,
        error: "第三方平台下载未启用：请到设置 → 第三方平台打开开关",
      });
      continue;
    }
    try {
      const task = await enqueuePlatformLink(link);
      out.push({
        platform: link.platform,
        url: link.url,
        ok: true,
        title: task.title,
        uploader: task.uploader || null,
        existing: task.existing,
        taskId: task.taskId,
        error: null,
      });
    } catch (err) {
      out.push({
        platform: link.platform,
        url: link.url,
        ok: false,
        title: null,
        uploader: null,
        existing: false,
        taskId: null,
        error: (err as Error).message,
      });
    }
  }
  return out;
}

