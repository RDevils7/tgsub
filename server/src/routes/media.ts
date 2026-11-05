import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { asyncHandler, assert } from "../lib/http";
import { env } from "../env";
import { logger } from "../logger";
import { ffmpegInfo, hwCapability } from "../tg/ffmpeg";
import { buildTranscodeArgs } from "../tg/hwdecode";
import { isVideoFile } from "../tg/mediapath";
import {
  artUrl,
  existingEpisodeThumb,
  generateEpisodeThumb,
  libraryRoots,
  listLibrary,
  isTrialCodec,
  playModeOf,
  probeFile,
  resolveArtFile,
  seriesDetail,
  streamUrl,
  thumbCachePath,
  thumbUrl,
  type LibraryEpisode,
  type LibrarySeries,
  type PlayMode,
} from "../tg/medialib";
import { isAllowedPath } from "../tg/mediatree";
import { spawn } from "node:child_process";

/**
 * 本地媒体库接口。
 *
 * 和 /api/metadata 的分工：那边管「改」，这边只管「看和播」。
 * 路径一律先过 isAllowedPath（下载根内或已登记来源），
 * 绝不让前端传一个任意路径来读文件。
 */
export const mediaRouter = Router();

/** 目录参数：空就是下载根 */
function resolveDir(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const dir = text ? path.resolve(text) : path.resolve(env.downloadDir);
  assert(isAllowedPath(dir), 403, "目录不在允许访问的范围内");
  return dir;
}

function decorateSeries(series: LibrarySeries) {
  return {
    ...series,
    posterUrl: artUrl(series.dir, "poster", series.firstVideo),
    landscapeUrl: artUrl(series.dir, "landscape", series.firstVideo),
  };
}

function decorateEpisode(episode: LibraryEpisode) {
  return {
    ...episode,
    streamUrl: streamUrl(episode.path, episode.playMode),
    thumbUrl: thumbUrl(episode.path, episode.updatedAt || undefined),
    /**
     * 「试播」= 这一集是 HEVC，本来浏览器解不了，靠用户打开「直连」才变成直出/换封装。
     * 转码（transcode）不算试播：那条路是显卡兜住的，和解不了的情况区分开。
     */
    trial: isTrialCodec(episode.videoCodec) && (episode.playMode === "direct" || episode.playMode === "remux"),
  };
}

/** 前端「直连优先」开关会带 hevc=1，逐层透传给 playModeOf */
function allowHevcOf(req: import("express").Request): boolean {
  return String(req.query.hevc ?? "") === "1";
}

/** 硬件解码能力（缓存 10 分钟），前端用它决定工具栏徽章与文案 */
async function hwInfo() {
  const cap = await hwCapability();
  return {
    available: cap.available,
    accel: cap.accel,
    label: cap.label,
    reason: cap.reason,
  };
}

/**
 * 目录里的剧集列表。
 *
 * `isSeries` 为真表示这个目录自己就是一部剧（用户点进剧集了），
 * 这时 `loose` 是它的分集；前端据此切换「海报墙 / 分集列表」两种视图。
 */
mediaRouter.get(
  "/library",
  asyncHandler(async (req, res) => {
    const dir = resolveDir(req.query.dir);
    assert(fs.existsSync(dir), 404, "目录不存在");
    const hw = await hwCapability();
    const listing = await listLibrary(dir, { allowHevc: allowHevcOf(req), hw: hw.available });
    res.json({
      ok: true,
      dir: listing.dir,
      parent: listing.parent,
      home: listing.home,
      roots: listing.roots,
      isSeries: listing.isSeries,
      hw: await hwInfo(),
      series: listing.series.map(decorateSeries),
      loose: listing.loose.map(decorateEpisode),
    });
  }),
);

/** 一部剧的详情 + 全部分集 */
mediaRouter.get(
  "/series",
  asyncHandler(async (req, res) => {
    const dir = resolveDir(req.query.dir);
    const stat = await fs.promises.stat(dir).catch(() => null);
    assert(stat?.isDirectory(), 404, "目录不存在");
    const hw = await hwCapability();
    const detail = await seriesDetail(dir, { allowHevc: allowHevcOf(req), hw: hw.available });
    res.json({
      ok: true,
      dir,
      hw: await hwInfo(),
      series: decorateSeries(detail.series),
      episodes: detail.episodes.map(decorateEpisode),
    });
  }),
);

/**
 * 封面。
 *
 * 不接收文件路径，只接收剧集目录 + 槽位（poster / landscape），
 * 由服务端按固定优先顺序找 —— 避免把「读任意文件」的能力开出去。
 */
mediaRouter.get(
  "/art",
  asyncHandler(async (req, res) => {
    const dir = resolveDir(req.query.dir);
    const kind = req.query.kind === "landscape" ? "landscape" : "poster";
    const file = resolveArtFile(dir, kind);
    if (!file) {
      res.status(404).json({ ok: false, error: "这个目录没有封面" });
      return;
    }
    // 封面文件名固定、内容基本不变，换图时 URL 上的 v 会变，可以放心长缓存
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(file);
  }),
);

/* ------------------------------------------------------------------ */
/* 单集缩略图                                                          */
/* ------------------------------------------------------------------ */

/** 同一文件的并发抽帧请求合并成一次（海报墙一次滑过去会打十几个请求） */
const thumbJobs = new Map<string, Promise<void>>();

/**
 * 单集缩略图。
 *
 * 优先级：下载时生成好的 `<base>-thumb.jpg` → 抽帧缓存 → 现场抽一帧（落缓存）。
 * 接收视频路径，但必须过 isVideoFile + isAllowedPath，不能变成「读任意文件」。
 */
mediaRouter.get(
  "/thumb",
  asyncHandler(async (req, res) => {
    const raw = String(req.query.path ?? "").trim();
    assert(raw, 400, "缺少文件路径");
    const file = path.resolve(raw);
    assert(isVideoFile(file), 400, "只能取视频的缩略图");
    assert(isAllowedPath(file), 403, "文件不在允许访问的范围内");

    const stat = await fs.promises.stat(file).catch(() => null);
    assert(stat && stat.isFile(), 404, "文件不存在或已被删除");

    // 抽帧结果按「文件路径 + 大小 + mtime」缓存，文件换了 URL 上的 v 会变
    res.setHeader("Cache-Control", "private, max-age=86400");

    const ready = existingEpisodeThumb(file);
    if (ready) {
      res.sendFile(ready);
      return;
    }

    const cacheFile = thumbCachePath(file, stat);
    if (!fs.existsSync(cacheFile)) {
      let job = thumbJobs.get(cacheFile);
      if (!job) {
        const probe = await probeFile(file).catch(() => null);
        job = generateEpisodeThumb(file, cacheFile, probe?.duration ?? null).finally(() => thumbJobs.delete(cacheFile));
        thumbJobs.set(cacheFile, job);
      }
      try {
        await job;
      } catch (err) {
        logger.warn({ err: (err as Error).message, file }, "单集缩略图抽帧失败");
        if (!res.headersSent && !res.writableEnded) {
          // 不把 ffmpeg 的 stderr 原样丢给浏览器（里面带宿主机绝对路径），细节只进日志
          res.status(404).json({ ok: false, error: "这个视频抽不出缩略图，可能已损坏或不完整" });
        }
        return;
      }
    }

    if (!fs.existsSync(cacheFile)) {
      res.status(404).json({ ok: false, error: "缩略图生成失败" });
      return;
    }
    res.sendFile(cacheFile);
  }),
);

/* ------------------------------------------------------------------ */
/* 播放                                                                */
/* ------------------------------------------------------------------ */

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
  ".ts": "video/mp2t",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
};

/** 解析 `bytes=start-end`；返回 null 表示这个头用不了（按整段发） */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  let start: number;
  let end: number;
  if (!rawStart) {
    // bytes=-500 表示最后 500 字节
    const tail = Number(rawEnd);
    if (!Number.isFinite(tail) || tail <= 0) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start < 0) return { start: size, end: size - 1 };
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 播放本地视频。
 *
 * - 默认（direct）：按 Range 直出原文件，能拖进度条，mp4 / webm 走这条
 * - `mode=remux`：容器不对但编码能解（mkv / ts 里的 h264），
 *   用 ffmpeg 把流换封装成 fragmented MP4 吐出来。这条路没有 Content-Length，
 *   也拖不了进度条 —— 实时转封装就是这个特性，界面上会说明。
 */
mediaRouter.get(
  "/stream",
  asyncHandler(async (req, res) => {
    const raw = String(req.query.path ?? "").trim();
    assert(raw, 400, "缺少文件路径");
    const file = path.resolve(raw);
    assert(isVideoFile(file), 400, "只能播放视频文件");
    assert(isAllowedPath(file), 403, "文件不在允许访问的范围内");

    const stat = await fs.promises.stat(file).catch(() => null);
    assert(stat && stat.isFile(), 404, "文件不存在或已被删除");

    const probe = await probeFile(file).catch(() => null);
    const startSec = Math.max(0, Number(req.query.start ?? 0) || 0);
    const modeParam = String(req.query.mode ?? "");
    let wanted: PlayMode;
    if (modeParam === "remux" || modeParam === "transcode") {
      wanted = modeParam;
    } else {
      const hw = await hwCapability();
      wanted = playModeOf(file, probe, { allowHevc: allowHevcOf(req), hw: hw.available });
    }
    const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";

    if (wanted === "transcode") {
      const hw = await hwCapability();
      if (!hw.available || !hw.accel) {
        res.status(503).json({
          ok: false,
          error: `这个文件的编码浏览器解不了，需要显卡转码，但服务端没有可用的硬件解码（${hw.reason ?? "未检测到显卡"}）。`,
        });
        return;
      }
      await pipeTranscode(file, res, {
        accel: hw.accel,
        device: hw.device,
        sourceHeight: probe?.height ?? null,
        startSec,
      });
      return;
    }

    if (wanted === "remux") {
      await pipeRemux(file, res, probe?.videoCodec ?? null, startSec);
      return;
    }

    const total = stat.size;
    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "bytes");

    const range = req.headers.range;
    if (range) {
      const parsed = parseRange(range, total);
      if (!parsed) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`);
        res.end();
        return;
      }
      const { start, end } = parsed;
      if (start >= total) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(end - start + 1));
      const stream = fs.createReadStream(file, { start, end });
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    res.setHeader("Content-Length", String(total));
    const stream = fs.createReadStream(file);
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }),
);

/** ffmpeg 换封装成 fMP4 直接管道输出；客户端断开就 kill，别留僵尸进程 */
async function pipeRemux(
  file: string,
  res: import("express").Response,
  videoCodec: string | null = null,
  startSec = 0,
): Promise<void> {
  const info = await ffmpegInfo();
  if (!info.available || !info.ffmpeg) {
    res.status(503).json({
      ok: false,
      error: `这个格式浏览器播不了，需要 ffmpeg 换封装，但服务端没有可用的 ffmpeg（${info.error ?? "未安装"}）。`,
    });
    return;
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    // 拖动进度条：输入侧 seek（关键帧对齐），换封装也是秒开
    ...(startSec > 0 ? ["-ss", startSec.toFixed(3)] : []),
    "-i",
    file,
    // 只带首条视频 + 首条音频：数据轨、多音轨留在原文件里，浏览器用不到还添乱
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-c",
    "copy",
    // HEVC 进 MP4 要写 hvc1：Apple 系与部分浏览器只认这个标签，默认的 hev1 会被判成解不了
    ...(isTrialCodec(videoCodec) ? ["-tag:v", "hvc1"] : []),
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ];

  await pipeFfmpeg(info.ffmpeg, args, file, res, "换封装");
}

/**
 * 显卡转码：HEVC / ProRes 这类浏览器解不了的编码，硬解 + 硬编成 H.264 实时吐出去。
 *
 * 参数由 `buildTranscodeArgs()`（纯函数，自检覆盖）拼；
 * 这里只负责起进程、把 stdout 管道给浏览器、失败时说清楚原因。
 */
async function pipeTranscode(
  file: string,
  res: import("express").Response,
  opts: { accel: "vaapi" | "qsv" | "software"; device: string | null; sourceHeight: number | null; startSec: number },
): Promise<void> {
  const info = await ffmpegInfo();
  if (!info.available || !info.ffmpeg) {
    res.status(503).json({
      ok: false,
      error: `这个文件需要转码，但服务端没有可用的 ffmpeg（${info.error ?? "未安装"}）。`,
    });
    return;
  }

  const args = buildTranscodeArgs({
    input: file,
    accel: opts.accel,
    device: opts.device,
    sourceHeight: opts.sourceHeight,
    startSec: opts.startSec,
  });

  logger.info(
    { file, accel: opts.accel, device: opts.device, start: opts.startSec },
    "开始硬件转码（浏览器解不了的编码）",
  );
  await pipeFfmpeg(info.ffmpeg, args, file, res, "转码");
}

/** 共用的「ffmpeg → HTTP」管道；首块数据到了才发响应头，失败时把 stderr 最后一行的原因回给前端 */
async function pipeFfmpeg(
  bin: string,
  args: string[],
  file: string,
  res: import("express").Response,
  label: string,
): Promise<void> {
  let stderr = "";
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const cleanup = () => {
    if (!child.killed) child.kill("SIGKILL");
  };
  res.on("close", cleanup);

  /**
   * 等 ffmpeg 真吐出第一块数据再发响应头。
   *
   * 直接 `stdout.pipe(res)` 的话，进程还没解出任何东西就先发 200；
   * 万一 ffmpeg 立刻失败（文件损坏、编码不支持、显卡没权限），客户端拿到的是
   * 「200 空响应」，只能看到播放器转圈 —— 说清楚失败原因比这有用得多。
   */
  let started = false;
  const startStream = (first: Buffer) => {
    started = true;
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    // 实时换封装 / 转码没有确定长度，也不能 Range
    res.setHeader("Cache-Control", "no-store");
    res.write(first);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (!started) startStream(chunk);
    else res.write(chunk);
  });
  // 一个字节都没出就 end 了，别急着结束响应 —— 让 close handler 把原因写清楚
  child.stdout.on("end", () => {
    if (started) res.end();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.on("error", (err) => {
    logger.warn({ err: err.message, file }, `ffmpeg ${label}启动失败`);
    if (!started && !res.headersSent) res.status(500).json({ ok: false, error: `ffmpeg 启动失败：${err.message}` });
    else res.destroy();
  });
  child.on("close", (code) => {
    const failed = (code !== null && code !== 0) || !started;
    if (failed) {
      logger.warn({ code, file, stderr: stderr.slice(-500) }, `ffmpeg ${label}退出`);
      const detail = stderr.split("\n").filter(Boolean).slice(-1)[0];
      if (!res.headersSent && !res.writableEnded) {
        res.status(500).json({
          ok: false,
          error: detail
            ? `这个文件无法${label}播放：${detail}`
            : `ffmpeg 没有输出任何数据，这个文件可能已损坏（${label}失败）`,
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });
}

/** 可切换的库位置（下载根 + 各平台目录 + 手动来源） */
mediaRouter.get(
  "/roots",
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, roots: libraryRoots(), home: path.resolve(env.downloadDir) });
  }),
);
