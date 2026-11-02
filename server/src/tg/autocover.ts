import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logger";
import { sanitizeSegment } from "../utils";
import { writeBlurFill } from "./coverimage";
import { captureStill, ffmpegInfo, probeVideo } from "./ffmpeg";
import { loadSharp } from "./sharp";

/**
 * 封面与缩略图一律从视频里随机截帧生成，不再下载消息里的图片。
 *
 * 落盘规则：
 *  剧名/
 *    剧名S01E01.mp4
 *    剧名S01E01-thumb.jpg    ← 这一集的缩略图（每集各不相同，随机时刻）
 *    剧名S01E02-thumb.jpg
 *    poster.jpg              ← 剧集封面，取自第一集
 *    landscape.jpg           ← 剧集横版图，取自第一集
 *    fanart.jpg              ← 剧集背景图，取自第一集
 *
 * 「剧集目录的封面同第一集」靠 isFirst 实现：第一集下载完成时无条件覆盖这三张；
 * 其余集只在封面缺失时补一份（防止第一集还没下、整个剧集在 Emby 里没图）。
 *
 * 比例不符时的处理（1.2.0 起）：不再裁剪，也不留黑边 —— 画面完整居中，
 * 空出来的部分用同一帧的放大模糊版填满（见 `coverimage.writeBlurFill`）。
 */

interface ShowSlot {
  file: string;
  width: number;
  height: number;
}

/** 剧集目录级的三张图（规格固定，Emby 认这几个名字） */
const SHOW_SLOTS: ShowSlot[] = [
  { file: "poster.jpg", width: 1000, height: 1500 },
  { file: "landscape.jpg", width: 1920, height: 1080 },
  { file: "fanart.jpg", width: 1920, height: 1080 },
];

/** 单集缩略图宽度：够 Emby 各处缩略展示，又不至于占空间 */
const THUMB_WIDTH = 1280;

/** 抽几帧来挑：帧太密没意义，6 帧足够覆盖横竖两种画面并保证缩略图各不相同 */
const FRAME_COUNT = 6;
/** 最多截多大：>= 1920 宽足够出 landscape，再大只是浪费解码时间 */
const MAX_FRAME_WIDTH = 1920;

const running = new Set<string>();

function exists(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** 随机时间点，避开片头片尾（前 5% / 后 10% 常常是黑场和广告） */
function randomTimes(duration: number, count: number): number[] {
  const start = Math.max(0.5, duration * 0.05);
  const end = Math.max(start + 1, duration * 0.9);
  const times: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = start + (crypto.randomInt(1000) / 1000) * (end - start);
    times.push(Math.round(at * 10) / 10);
  }
  return times.sort((a, b) => a - b);
}

/** 比例越接近目标、朝向越一致，分数越低 */
function score(ratio: number, target: number): number {
  const sameOrientation = ratio >= 1 === target >= 1;
  return Math.abs(Math.log(ratio / target)) + (sameOrientation ? 0 : 0.8);
}

async function ratioOf(file: string, sharp: Awaited<ReturnType<typeof loadSharp>>): Promise<number | null> {
  if (!sharp) return null;
  try {
    const meta = await sharp(file).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    return w > 0 && h > 0 ? w / h : null;
  } catch {
    return null;
  }
}

export interface EpisodeCoverOptions {
  /** 本集视频基名；给了就顺带生成 `<基名>-thumb.jpg` 作为这一集的缩略图 */
  base?: string;
  /**
   * 剧集目录三张封面（poster / landscape / fanart）的处理方式：
   *  - force      覆盖重做（第一集用这个）
   *  - if-missing 缺才补（下载流程默认）
   *  - skip       完全不动
   */
  series?: "force" | "if-missing" | "skip";
  /** 剧集封面的落盘目录，默认跟视频同目录；季目录结构下要指到剧集根目录 */
  seriesDir?: string;
}

/**
 * 给一个视频生成封面：本集缩略图 + 剧集目录封面。
 * 返回生成的文件名列表（空数组 = 没生成）。失败只记日志，不影响下载主流程。
 */
export async function autoCoversFromVideo(
  video: string,
  dir: string,
  opts: EpisodeCoverOptions = {},
): Promise<string[]> {
  if (!exists(video)) return [];
  if (running.has(dir)) return [];

  const seriesDir = opts.seriesDir ?? dir;
  const thumbName = opts.base ? `${sanitizeSegment(opts.base, 120)}-thumb.jpg` : null;
  const seriesMode = opts.series ?? "if-missing";
  const targets: Array<{ file: string; width: number; height: number; keepRatio: boolean; dir: string }> = [];

  if (thumbName && !exists(path.join(dir, thumbName))) {
    targets.push({ file: thumbName, width: THUMB_WIDTH, height: 720, keepRatio: true, dir });
  }
  if (seriesMode !== "skip") {
    for (const slot of SHOW_SLOTS) {
      // force 无条件重做，if-missing 只补缺的
      if (seriesMode === "force" || !exists(path.join(seriesDir, slot.file))) {
        targets.push({
          file: slot.file,
          width: slot.width,
          height: slot.height,
          keepRatio: false,
          dir: seriesDir,
        });
      }
    }
  }
  if (!targets.length) return [];

  running.add(dir);
  // 每次用自己的临时目录：复用同一个目录时，「先删再建」在某些环境（回收站式删除）
  // 会失败，进而让整次截帧直接报废。用完即删，删不掉也只是系统临时目录里的残渣
  const tmpDir = path.join(os.tmpdir(), "tgsub-frames", crypto.randomUUID());
  try {
    const info = await ffmpegInfo();
    if (!info.available) return [];

    const probe = await probeVideo(video);
    const duration = probe?.duration && probe.duration > 1 ? probe.duration : 60;

    await fs.promises.mkdir(tmpDir, { recursive: true });

    const sharp = await loadSharp();
    const frames: Array<{ file: string; ratio: number }> = [];
    for (const [index, at] of randomTimes(duration, FRAME_COUNT).entries()) {
      const out = path.join(tmpDir, `f-${index + 1}.jpg`);
      try {
        await captureStill(video, at, out, MAX_FRAME_WIDTH);
      } catch {
        continue;
      }
      const ratio = await ratioOf(out, sharp);
      if (ratio) frames.push({ file: out, ratio });
    }
    if (!frames.length) return [];

    const made: string[] = [];
    for (const slot of targets) {
      const dest = path.join(slot.dir, slot.file);
      try {
        if (slot.keepRatio) {
          // 单集缩略图保持画面原始比例：竖版剧集截出来的就是竖版，不硬裁
          const frame = frames[0];
          if (!sharp) {
            await fs.promises.copyFile(frame.file, dest);
          } else {
            await sharp(frame.file)
              .resize({ width: slot.width, withoutEnlargement: true })
              .jpeg({ quality: 88 })
              .toFile(dest);
          }
        } else {
          const target = slot.width / slot.height;
          const ranked = [...frames].sort((a, b) => score(a.ratio, target) - score(b.ratio, target));
          // landscape 与 fanart 规格相同，用第二名挑一帧，两张图不至于一模一样。
          // 朝向一致的帧优先：竖版海报用竖版帧，模糊填充的面积最小、观感最好
          const pick = made.includes("landscape.jpg") ? (ranked[1] ?? ranked[0]) : ranked[0];
          await writeBlurFill(pick.file, dest, { width: slot.width, height: slot.height, quality: 90 });
        }
        made.push(slot.file);
      } catch (err) {
        logger.warn({ err: (err as Error).message, file: slot.file, dir: path.basename(slot.dir) }, "截帧封面写入失败");
      }
    }
    if (made.length) {
      const kind = made.some((f) => f.endsWith("-thumb.jpg"))
        ? made.some((f) => SHOW_SLOTS.some((slot) => slot.file === f))
          ? "缩略图与剧集封面"
          : "单集缩略图"
        : "剧集封面";
      logger.info(
        {
          dir: path.basename(dir),
          base: opts.base ?? null,
          series: seriesMode,
          files: made,
          frames: frames.length,
        },
        `已用视频截帧生成${kind}：${made.join("、")}`,
      );
    }
    return made;
  } catch (err) {
    logger.warn({ err: (err as Error).message, dir: path.basename(dir) }, "自动截帧封面失败");
    return [];
  } finally {
    running.delete(dir);
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
