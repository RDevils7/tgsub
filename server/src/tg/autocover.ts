import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { logger } from "../logger";
import { captureStill, ffmpegInfo, probeVideo } from "./ffmpeg";
import { loadSharp } from "./sharp";

/**
 * 没有可用图片时的封面兜底：从视频里随机截几帧，自动挑出横版、竖版画面。
 *
 * 规则：
 *  - 竖版槽位（poster 2:3）优先挑竖版画面，横版槽位（landscape / fanart 16:9）优先挑横版画面
 *  - 朝向一致的帧直接裁剪铺满；整段视频只有一种朝向时，另一种朝向用留黑边保住完整画面
 *  - 已经存在的图不覆盖：只补缺的那几张，避免覆盖用户手动换过的封面
 */

interface CoverSlot {
  file: string;
  width: number;
  height: number;
}

const SLOTS: CoverSlot[] = [
  { file: "poster.jpg", width: 1000, height: 1500 },
  { file: "landscape.jpg", width: 1920, height: 1080 },
  { file: "fanart.jpg", width: 1920, height: 1080 },
];

/** 抽几帧来挑：帧太密没意义，6 帧足够覆盖横竖两种画面 */
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

/**
 * 给一个目录补封面。返回生成的图片文件名（空数组 = 没补）。
 * 失败只记日志，绝不影响下载主流程。
 */
export async function autoCoversFromVideo(video: string, dir: string): Promise<string[]> {
  if (running.has(dir)) return [];
  const missing = SLOTS.filter((slot) => !exists(path.join(dir, slot.file)));
  if (!missing.length) return [];
  if (!exists(video)) return [];

  running.add(dir);
  const tmpDir = path.join(
    env.dataDir,
    "frames",
    "auto",
    crypto.createHash("sha1").update(dir).digest("hex").slice(0, 12),
  );
  try {
    const info = await ffmpegInfo();
    if (!info.available) return [];

    const probe = await probeVideo(video);
    const duration = probe?.duration && probe.duration > 1 ? probe.duration : 60;

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
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
    for (const slot of missing) {
      const target = slot.width / slot.height;
      const ranked = [...frames].sort((a, b) => score(a.ratio, target) - score(b.ratio, target));
      // landscape 与 fanart 规格相同，用第二名挑一帧，两张图不至于一模一样
      const pick = made.includes("landscape.jpg") ? (ranked[1] ?? ranked[0]) : ranked[0];
      const dest = path.join(dir, slot.file);
      try {
        if (!sharp) {
          await fs.promises.copyFile(pick.file, dest);
        } else {
          const sameOrientation = pick.ratio >= 1 === target >= 1;
          await sharp(pick.file)
            .resize({
              width: slot.width,
              height: slot.height,
              // 朝向一致就裁满，朝向不符就留黑边，别把画面裁没了
              fit: sameOrientation ? "cover" : "contain",
              position: "attention",
              background: "#000000",
            })
            .jpeg({ quality: 90 })
            .toFile(dest);
        }
        made.push(slot.file);
      } catch (err) {
        logger.warn({ err: (err as Error).message, file: slot.file }, "自动截帧封面写入失败");
      }
    }
    if (made.length) {
      logger.info({ dir: path.basename(dir), made, frames: frames.length }, "已用视频截帧生成封面");
    }
    return made;
  } catch (err) {
    logger.warn({ err: (err as Error).message, dir }, "自动截帧封面失败");
    return [];
  } finally {
    running.delete(dir);
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
