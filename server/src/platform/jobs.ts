import crypto from "node:crypto";
import path from "node:path";
import { db, ensurePlatformChannel, getPlatformCookie, getSettings, PLATFORM_CHANNEL_TITLE } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { encodeMeta, EmbyMeta } from "../tg/emby";
import { PlatformId } from "../types";
import { sanitizeSegment } from "../utils";
import { PlatformLink } from "./detect";
import { platformName, probePlatform, PlatformProbe, PlaylistEntry } from "./ytdlp";
import { downloader } from "../tg/downloader";

/**
 * 第三方链接入队。
 *
 * 任务写进 downloads 表（source='platform'），和 Telegram 下载共用一套队列、
 * 进度、重试、列表与 Emby 收尾逻辑；区别只在 run() 里换成了 yt-dlp。
 */

/** 合集 / 多P 的选择：只下第一个，或整份展开 */
export type PlaylistMode = "one" | "all";

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

/** 交给界面/机器人做二次选择：这条链接其实是个合集 */
export interface PlatformChoiceInfo {
  /** 二次提交用的短令牌（机器人按钮最多 64 字节，塞不下整条链接） */
  token: string;
  platform: PlatformId;
  url: string;
  /** 合集名（B站多P 取稿件标题） */
  title: string;
  count: number;
  /** 条目超过上限，只展开了前 count 条 */
  capped: boolean;
  firstTitle: string;
  firstUploader: string;
  firstDuration: number | null;
  firstFilesize: number | null;
}

export interface PlaylistSummary {
  count: number;
  mode: PlaylistMode;
  capped: boolean;
}

export type EnqueueOutcome =
  | { type: "queued"; tasks: PlatformTask[]; playlist: PlaylistSummary | null }
  | { type: "playlist"; choice: PlatformChoiceInfo };

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

/* ------------------------------------------------------------------ */
/* 合集选择令牌                                                        */
/* ------------------------------------------------------------------ */

const CHOICE_TTL = 30 * 60_000;
const choiceStore = new Map<string, { at: number; url: string; platform: PlatformId }>();

function rememberChoice(url: string, platform: PlatformId): string {
  const now = Date.now();
  for (const [key, value] of choiceStore) {
    if (now - value.at > CHOICE_TTL) choiceStore.delete(key);
  }
  // 6 位十六进制足够，且按钮数据短
  const token = crypto.randomBytes(3).toString("hex");
  choiceStore.set(token, { at: now, url, platform });
  if (choiceStore.size > 200) {
    const oldest = choiceStore.keys().next().value;
    if (oldest) choiceStore.delete(oldest);
  }
  return token;
}

/** 机器人按钮回调时按 token 找回原始链接；过期的返回 null */
export function resolveChoice(token: string): { url: string; platform: PlatformId } | null {
  const hit = choiceStore.get(String(token ?? ""));
  if (!hit) return null;
  if (Date.now() - hit.at > CHOICE_TTL) {
    choiceStore.delete(String(token));
    return null;
  }
  return { url: hit.url, platform: hit.platform };
}

/* ------------------------------------------------------------------ */
/* 入队                                                                */
/* ------------------------------------------------------------------ */

/** 把一次解析结果写成一条下载任务（已存在则复用原记录） */
function enqueueProbe(platform: PlatformId, url: string, probe: PlatformProbe): PlatformTask {
  const settings = getSettings();
  const fileName = `${probe.title}${probe.id ? ` [${probe.id}]` : ""}`.slice(0, 200);
  const existing = findExisting(url, fileName);
  const saveDir = platformSaveDir(platform, probe.uploader, probe.title, probe.id, settings.platform_dir);

  if (existing && existing.status !== "failed" && existing.status !== "stopped") {
    return {
      platform,
      url,
      id: probe.id,
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
    logger.info({ id: existing.id, platform, title: probe.title }, `第三方任务重新入队：${probe.title}`);
    return {
      platform,
      url,
      id: probe.id,
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
    tags: [platformName(platform), ...(probe.uploader ? [probe.uploader] : [])],
    studio: probe.uploader || platformName(platform),
    link: url,
    airedAt: probe.uploadedAt ?? Date.now(),
    messageId: 0,
    kind: "video",
    platform,
    cover: probe.thumbnail,
    views: probe.viewCount,
    likes: probe.likeCount,
    duration: probe.duration,
    categories: probe.categories,
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
      url,
    );

  const taskId = Number(info.lastInsertRowid);
  downloader.enqueue([taskId]);
  logger.info(
    { id: taskId, platform, uploader: probe.uploader, dir: saveDir },
    `第三方任务已入队：${probe.title}（${platformName(platform)}）`,
  );

  return {
    platform,
    url,
    id: probe.id,
    title: probe.title,
    uploader: probe.uploader,
    duration: probe.duration,
    taskId,
    existing: false,
    saveDir,
    filesize: probe.filesize,
  };
}

/** 合集展开时，flat 条目只有标题/作者/封面，够命名和写 NFO 了 */
function entryToProbe(platform: PlatformId, entry: PlaylistEntry): PlatformProbe {
  return {
    platform,
    id: entry.id,
    title: entry.title,
    uploader: entry.uploader,
    duration: entry.duration,
    thumbnail: entry.thumbnail,
    description: "",
    uploadedAt: null,
    webpageUrl: entry.url,
    filesize: null,
    viewCount: null,
    likeCount: null,
    categories: [],
    playlist: null,
  };
}

/**
 * 解析 + 入队一条链接。
 *
 * 合集 / 多P 在没指定 mode 时**不下载**，只返回一个选择项：让用户决定
 * 「只要这一个」还是「整份都下」。这条规则对界面和机器人都成立 ——
 * 直接闷头下 200 个视频是最容易把人劝退的体验。
 */
export async function enqueuePlatformLink(link: PlatformLink, mode?: PlaylistMode): Promise<EnqueueOutcome> {
  const settings = getSettings();
  if (!settings.platform_enabled) {
    throw new Error("第三方平台下载未启用：请到设置 → 第三方平台打开开关");
  }

  const cookie = getPlatformCookie(link.platform);
  const probe = await probePlatform(link.url, link.platform, cookie);

  if (probe.playlist && !mode) {
    return {
      type: "playlist",
      choice: {
        token: rememberChoice(link.url, link.platform),
        platform: link.platform,
        url: link.url,
        title: probe.title,
        count: probe.playlist.count,
        capped: probe.playlist.capped,
        firstTitle: probe.playlist.entries[0]?.title ?? probe.title,
        firstUploader: probe.playlist.entries[0]?.uploader || probe.uploader,
        firstDuration: probe.playlist.entries[0]?.duration ?? probe.duration,
        firstFilesize: probe.filesize,
      },
    };
  }

  if (probe.playlist && mode === "all") {
    const entries = probe.playlist.entries;
    const tasks = entries.map((entry, index) =>
      // 第一条已经有完整信息（简介、精确封面），不用重复解析
      enqueueProbe(link.platform, entry.url, index === 0 ? { ...probe, playlist: null } : entryToProbe(link.platform, entry)),
    );
    logger.info(
      { platform: link.platform, title: probe.title, count: tasks.length },
      `合集已展开入队：${probe.title}（${tasks.length} 个）`,
    );
    return {
      type: "queued",
      tasks,
      playlist: { count: tasks.length, mode, capped: probe.playlist.capped },
    };
  }

  // mode === "one"：合集只取第一条
  const target = probe.playlist ? probe.playlist.entries[0] : null;
  const task = enqueueProbe(
    link.platform,
    target?.url ?? link.url,
    probe.playlist ? { ...probe, playlist: null } : probe,
  );
  return {
    type: "queued",
    tasks: [task],
    playlist: probe.playlist ? { count: probe.playlist.count, mode: "one", capped: probe.playlist.capped } : null,
  };
}

/** 机器人按钮回调：按 token + 选择入队 */
export async function enqueueFromChoice(token: string, mode: PlaylistMode): Promise<EnqueueOutcome> {
  const saved = resolveChoice(token);
  if (!saved) throw new Error("这次选择已经过期，请重新把链接发给我");
  const link: PlatformLink = {
    platform: saved.platform,
    url: saved.url,
    id: null,
    key: saved.url,
  };
  return enqueuePlatformLink(link, mode);
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
  /** 这次一共入队了几个（合集展开后 > 1） */
  count: number;
  /** 需要用户选「只下一个 / 全部下载」 */
  choice: PlatformChoiceInfo | null;
}

/**
 * 一串链接逐个解析入队；单条失败不影响其余。
 *
 * 给「机器人收到分享口令」「手动下载页一次粘一堆」用：那边只需要结果摘要，
 * 不想为了单条失败把整批都抛出去。遇到合集时把选择项带回给调用方。
 */
export async function enqueuePlatformLinks(links: PlatformLink[], mode?: PlaylistMode): Promise<PlatformQueued[]> {
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
        count: 0,
        choice: null,
      });
      continue;
    }
    try {
      const outcome = await enqueuePlatformLink(link, mode);
      if (outcome.type === "playlist") {
        out.push({
          platform: link.platform,
          url: link.url,
          ok: true,
          title: outcome.choice.title,
          uploader: outcome.choice.firstUploader || null,
          existing: false,
          taskId: null,
          error: null,
          count: outcome.choice.count,
          choice: outcome.choice,
        });
        continue;
      }
      const first = outcome.tasks[0];
      out.push({
        platform: link.platform,
        url: link.url,
        ok: true,
        title: first?.title ?? null,
        uploader: first?.uploader || null,
        existing: outcome.tasks.every((task) => task.existing),
        taskId: first?.taskId ?? null,
        error: null,
        count: outcome.tasks.length,
        choice: null,
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
        count: 0,
        choice: null,
      });
    }
  }
  return out;
}
