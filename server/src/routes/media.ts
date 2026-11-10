import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { asyncHandler, assert } from "../lib/http";
import { env } from "../env";
import { logger } from "../logger";
import { ffmpegInfo, hwCapability } from "../tg/ffmpeg";
import { buildTranscodeArgs } from "../tg/hwdecode";
import {
  decodePosterDataUrl,
  isStrmFile,
  isUnsafeLibraryRoot,
  isVideoFile,
  strmPosterPath,
} from "../tg/mediapath";
import { pipeStrm } from "../tg/strmstream";
import { ensureStrmNfo, ensureStrmNfos } from "../tg/strmnfo";
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
import { addSource, isAllowedPath } from "../tg/mediatree";
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
  if (!isAllowedPath(dir)) {
    const home = path.resolve(env.downloadDir);
    const roots = libraryRoots().map((root) => root.path);
    // 「为什么被拒」必须留痕：NAS 上路径前缀、大小写、挂载点差一个字就看不出来
    logger.warn({ dir, home, roots }, "媒体库目录被拒绝：不在允许访问的范围内");
    assert(
      false,
      403,
      `目录不在允许访问的范围内：${dir}。请在「选择目录」里重新选择一次（会自动登记），或回到下载目录。`,
    );
  }
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
  // strm 的封面是播放时用浏览器 canvas 截下来、落在 strm 同级的本地图片。
  // 没有封面时不下发 thumbUrl：前端据此判断「这集需要播放时自动截一张」。
  const localPoster = episode.isStrm ? existingEpisodeThumb(episode.path) : null;
  return {
    ...episode,
    streamUrl: streamUrl(episode.path, episode.playMode),
    thumbUrl: episode.isStrm && !localPoster ? null : thumbUrl(episode.path, episode.updatedAt || undefined),
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

/** 硬件解码能力（探测结果在 ffmpeg.ts 里缓存 10 分钟） */
function hwInfo(cap: Awaited<ReturnType<typeof hwCapability>>) {
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
      hw: hwInfo(hw),
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
      hw: hwInfo(hw),
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
 * 抽帧是重活（每次起一个 ffmpeg 解码）。海报墙一屏十几个不同文件同时请求时，
 * 不设上限会瞬间拉起十几个解码进程，NAS 上 CPU 占满，连正在播的视频都卡住。
 * 这里全局只放行 2 个，其余排队；同文件仍然共用上面那一个 job。
 */
const THUMB_CONCURRENCY = 2;
let thumbRunning = 0;
const thumbQueue: Array<() => void> = [];

async function withThumbSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (thumbRunning >= THUMB_CONCURRENCY) await new Promise<void>((resolve) => thumbQueue.push(resolve));
  thumbRunning += 1;
  try {
    return await fn();
  } finally {
    thumbRunning -= 1;
    thumbQueue.shift()?.();
  }
}

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
    assert(isVideoFile(file) || isStrmFile(file), 400, "只能取视频或 strm 的缩略图");
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

    /**
     * strm 绝不做服务端抽帧：那会真的回源拉视频，几百个文件批量跑一次
     * 就是一次全量刮削。封面只由播放器在播放时用 canvas 截、落本地。
     */
    if (isStrmFile(file)) {
      res.status(404).json({ ok: false, error: "strm 的封面会在播放时自动截取，这里不做服务端抽帧" });
      return;
    }

    const cacheFile = thumbCachePath(file, stat);
    if (!fs.existsSync(cacheFile)) {
      let job = thumbJobs.get(cacheFile);
      if (!job) {
        const probe = await probeFile(file).catch(() => null);
        job = withThumbSlot(() => generateEpisodeThumb(file, cacheFile, probe?.duration ?? null)).finally(() =>
          thumbJobs.delete(cacheFile),
        );
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
    assert(isVideoFile(file) || isStrmFile(file), 400, "只能播放视频文件或 strm 链接");
    assert(isAllowedPath(file), 403, "文件不在允许访问的范围内");

    const stat = await fs.promises.stat(file).catch(() => null);
    assert(stat && stat.isFile(), 404, "文件不存在或已被删除");

    /**
     * strm 走服务端流式转发，必须放在探测之前：
     * 这里的 probeFile / hwCapability 会起 ffmpeg，对一个文本文件既没用，
     * 更会把「点播放」变成额外的上游请求。
     */
    if (isStrmFile(file)) {
      await pipeStrm(file, req, res);
      return;
    }

    /**
     * direct 是列表接口已经算好的结论，回传过来就别再探测一遍了：
     * `probeFile` 冷缓存时要起一次 ffmpeg，硬解能力探测更可能真编一帧，
     * 全压在「点播放」到「出画面」这段时间里。
     */
    const modeParam = String(req.query.mode ?? "");
    const probe = modeParam === "direct" ? null : await probeFile(file).catch(() => null);
    const startSec = Math.max(0, Number(req.query.start ?? 0) || 0);
    let hw: Awaited<ReturnType<typeof hwCapability>> | null = null;
    let wanted: PlayMode;
    if (modeParam === "remux" || modeParam === "transcode") {
      wanted = modeParam;
    } else if (modeParam === "direct") {
      wanted = "direct";
    } else {
      hw = await hwCapability();
      wanted = playModeOf(file, probe, { allowHevc: allowHevcOf(req), hw: hw.available });
    }
    const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";

    if (wanted === "transcode") {
      const cap = hw ?? (await hwCapability());
      if (!cap.available || !cap.accel) {
        res.status(503).json({
          ok: false,
          error: `这个文件的编码浏览器解不了，需要显卡转码，但服务端没有可用的硬件解码（${cap.reason ?? "未检测到显卡"}）。`,
        });
        return;
      }
      await pipeTranscode(file, res, {
        accel: cap.accel,
        device: cap.device,
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

/* ------------------------------------------------------------------ */
/* strm 封面与 NFO                                                     */
/* ------------------------------------------------------------------ */

/**
 * 选中媒体目录后，给这个目录下**所有还没有单集 NFO 的 .strm** 补一份。
 *
 * 纯本地写盘：只按文件名推剧名 / 季 / 集，不解析 strm 正文里的直链，
 * 不抽帧、不探测、不请求播放源，哪怕几千个文件也不会碰到网盘风控。
 * 目录先过 isAllowedPath，写出去的 NFO 一定在允许范围内。
 */
mediaRouter.post(
  "/strm/nfo",
  asyncHandler(async (req, res) => {
    const dir = resolveDir(req.body?.dir);
    assert(fs.existsSync(dir), 404, "目录不存在");
    const summary = await ensureStrmNfos(dir);
    res.json({ ok: true, dir, ...summary });
  }),
);

/**
 * 保存 strm 的封面。
 *
 * 图片来自**播放器里已经解码的那一帧**（canvas），不是服务端 ffmpeg 抽帧：
 * 播放本来就要拉流，截一帧不产生任何额外请求，也不会有批量刮削特征。
 * 落盘位置固定在 strm 同级的 `<基名>-thumb.jpg`，前端传不了文件名，
 * 配合 isStrmFile + isAllowedPath 不会变成「写任意文件」。
 *
 * overwrite=false 用于播放时的自动截取（已有封面就不动），
 * overwrite=true 是用户手动挑好画面后覆盖自动封面。
 * NFO 只在不存在时补一次，不覆盖用户手工编辑过的内容。
 */
mediaRouter.post(
  "/poster",
  asyncHandler(async (req, res) => {
    const raw = String(req.body?.path ?? "").trim();
    assert(raw, 400, "缺少 strm 文件路径");
    const file = path.resolve(raw);
    assert(isStrmFile(file), 400, "只能给 strm 文件设置封面");
    assert(isAllowedPath(file), 403, "文件不在允许访问的范围内");

    const stat = await fs.promises.stat(file).catch(() => null);
    assert(stat?.isFile(), 404, "strm 文件不存在或已被删除");

    const image = decodePosterDataUrl(String(req.body?.image ?? ""));
    assert(image, 400, "封面图片格式不对（只接受 JPEG，且不能超过 1MB 请求体）");
    const overwrite = req.body?.overwrite === true;

    const poster = strmPosterPath(file);
    const existed = fs.existsSync(poster);
    let posterCreated = false;
    if (!existed || overwrite) {
      // 原子写：临时文件 + rename，别让海报墙读到半张图
      const tmp = `${poster}.tgsub-${process.pid}-${Date.now()}.tmp`;
      try {
        await fs.promises.writeFile(tmp, image);
        await fs.promises.rename(tmp, poster);
        posterCreated = true;
        logger.info({ file, bytes: image.length, overwrite }, "strm 封面已保存");
      } catch (err) {
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw new Error(`封面写入失败（检查媒体目录的写权限）：${(err as Error).message}`);
      }
    }

    // 与「选中目录后批量补齐」共用一套生成逻辑：只补不存在的，失败不影响封面与播放
    const nfoCreated = (await ensureStrmNfo(file)) === "created";

    res.json({
      ok: true,
      existed: existed && !overwrite,
      posterCreated,
      nfoCreated,
      // 带上新版本号，浏览器不会因为长缓存还显示旧封面
      thumbUrl: thumbUrl(file, Date.now()),
    });
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

/**
 * 把「选择目录」里挑中的目录登记成媒体来源。
 *
 * 目录浏览接口（/metadata/browse）本来就允许翻到下载根之外（元数据页靠它添加外部视频），
 * 但媒体库的读接口只认下载根 + media_sources。以前两边没打通：用户挑了别的盘，
 * 列表接口立刻 403「目录不在允许访问的范围内」。现在选中即登记，之后就一直可访问。
 *
 * 只在**当前不允许**时才写库：下载根内的子目录不产生垃圾来源记录。
 */
mediaRouter.post(
  "/roots",
  asyncHandler(async (req, res) => {
    const raw = String(req.body?.dir ?? "").trim();
    assert(raw, 400, "请提供目录路径");
    const dir = path.resolve(raw);
    const stat = await fs.promises.stat(dir).catch(() => null);
    assert(stat?.isDirectory(), 404, "目录不存在，或选中的不是文件夹");
    if (isAllowedPath(dir)) {
      res.json({ ok: true, dir, created: false });
      return;
    }
    assert(
      !isUnsafeLibraryRoot(dir, [env.dataDir]),
      403,
      "不能把系统目录或数据目录设为媒体库目录",
    );
    const source = addSource(dir, "dir", path.basename(dir) || dir);
    logger.info({ dir, sourceId: source.id }, "媒体库已登记新的来源目录");
    res.json({ ok: true, dir, created: true });
  }),
);
