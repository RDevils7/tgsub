import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSharp } from "./sharp";

/**
 * 把一张图铺进固定的封面规格。
 *
 * Emby 的 poster / landscape / fanart 比例是固定的（2:3、16:9），而视频画面
 * 横竖不一定：硬裁（cover）会把画面切掉一大半，硬留黑边（contain）又难看。
 *
 * 这里改成「模糊填充」：画面按原始比例完整居中显示，空出来的边用同一张图
 * 放大 + 高斯模糊 + 压暗填满 —— 不丢内容，也不出现刺眼黑块，看着像原图的延续。
 * 这是 1.2.0 起所有自动封面的默认做法（手动编辑器里对应 fit=blur）。
 */

export interface BlurFillSpec {
  width: number;
  height: number;
  /** JPEG 质量，默认 90 */
  quality?: number;
}

/** 模糊半径跟着目标尺寸走：小图别糊成一坨，大图别看不出模糊 */
export function blurSigma(width: number, height: number): number {
  const base = Math.min(width, height) / 28;
  return Math.min(40, Math.max(8, Math.round(base)));
}

/** 底图压暗程度：太亮会抢画面，太暗又变成「黑边」 */
export const BLUR_BRIGHTNESS = 0.62;

/**
 * 生成一张模糊填充的封面。
 * 返回 true 表示走了 sharp（正常路径），false 表示 sharp 不可用、已原样复制。
 */
export async function writeBlurFill(
  src: string,
  dest: string,
  spec: BlurFillSpec,
): Promise<boolean> {
  const width = Math.max(1, Math.round(spec.width));
  const height = Math.max(1, Math.round(spec.height));
  const quality = spec.quality ?? 90;

  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  const sharp = await loadSharp();
  if (!sharp) {
    // 没有 sharp 就原样落地：Emby 会自己缩放，总比没有封面强
    await fs.promises.copyFile(src, dest);
    return false;
  }

  const tmpDir = path.join(os.tmpdir(), "tgsub-blurfill", crypto.randomUUID());
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const bgFile = path.join(tmpDir, "bg.jpg");
    const fgFile = path.join(tmpDir, "fg.png");

    // 底：铺满 + 模糊 + 压暗（cover 会裁，但裁的是背景，丢内容无所谓）
    await sharp(src)
      .resize({ width, height, fit: "cover", position: "attention" })
      .blur(blurSigma(width, height))
      .modulate({ brightness: BLUR_BRIGHTNESS, saturation: 0.92 })
      .jpeg({ quality: 82 })
      .toFile(bgFile);

    // 前景：完整画面，按比例缩放，空出来的部分留透明
    await sharp(src)
      .resize({
        width,
        height,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(fgFile);

    await sharp(bgFile)
      .composite([{ input: fgFile, top: 0, left: 0 }])
      .jpeg({ quality })
      .toFile(dest);
    return true;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 读一张图的宽高；读不到返回 null（调用方据此决定要不要换来源） */
export async function imageSizeOf(src: string): Promise<{ width: number; height: number } | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(src).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}
