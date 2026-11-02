import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSettings } from "../db";
import { downloadFile, parseProxy } from "../lib/netprobe";
import { logger } from "../logger";
import { loadSharp } from "../tg/sharp";
import { sanitizeSegment } from "../utils";
import { PlatformId } from "../types";

/**
 * 平台官方封面 → Emby 封面。
 *
 * yt-dlp 解析时已经拿到了封面地址（B站横版大图、YouTube maxresdefault、
 * 抖音 dynamic cover…），比从视频里随机截帧好看得多：截帧经常拍到人脸特写、
 * 字幕条或者过场黑屏。这里把官方图下下来，按 Emby 认的文件名重新裁一遍：
 *
 *   poster.jpg      1000×1500（2:3，Emby 首选竖版）
 *   landscape.jpg   1920×1080
 *   fanart.jpg      1920×1080
 *   标题-thumb.jpg  1280 宽，保持原始比例
 *
 * 下载或裁剪失败一律只记日志：调用方随后还会用视频截帧兜底，
 * 封面这种附属品不该影响下载本身。
 */

interface CoverSlot {
  file: string;
  width: number;
  height: number;
  keepRatio: boolean;
}

const THUMB_WIDTH = 1280;

const SHOW_SLOTS: CoverSlot[] = [
  { file: "poster.jpg", width: 1000, height: 1500, keepRatio: false },
  { file: "landscape.jpg", width: 1920, height: 1080, keepRatio: false },
  { file: "fanart.jpg", width: 1920, height: 1080, keepRatio: false },
];

/** 图床基本都校验 Referer，不带就 403；按平台给一个主页地址 */
const REFERER: Record<PlatformId, string> = {
  bilibili: "https://www.bilibili.com/",
  douyin: "https://www.douyin.com/",
  xiaohongshu: "https://www.xiaohongshu.com/",
  youtube: "https://www.youtube.com/",
};

const running = new Set<string>();

function exists(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

export interface ImageCoverOptions {
  /** 本集视频基名；给了就顺带生成 `<基名>-thumb.jpg` */
  base?: string;
  /** true = 第一集，目录级三张封面覆盖重做 */
  isFirst?: boolean;
  platform?: PlatformId | null;
}

/**
 * 用平台官方封面生成 Emby 封面文件。
 * 返回实际写入的文件名（空数组 = 没写成，调用方应回退到视频截帧）。
 */
export async function applyCoversFromImage(
  url: string | null | undefined,
  dir: string,
  opts: ImageCoverOptions = {},
): Promise<string[]> {
  const source = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(source)) return [];
  if (running.has(dir)) return [];

  const targets: CoverSlot[] = [];
  const thumbName = opts.base ? `${sanitizeSegment(opts.base, 120)}-thumb.jpg` : null;
  if (thumbName && !exists(path.join(dir, thumbName))) {
    targets.push({ file: thumbName, width: THUMB_WIDTH, height: 720, keepRatio: true });
  }
  for (const slot of SHOW_SLOTS) {
    if (opts.isFirst || !exists(path.join(dir, slot.file))) targets.push(slot);
  }
  if (!targets.length) return [];

  running.add(dir);
  const tmpFile = path.join(os.tmpdir(), "tgsub-covers", `${crypto.randomUUID()}.img`);
  try {
    await fs.promises.mkdir(path.dirname(tmpFile), { recursive: true });
    let proxy = null;
    try {
      proxy = parseProxy(getSettings().platform_proxy);
    } catch {
      proxy = null;
    }

    await downloadFile(source, tmpFile, {
      proxy,
      timeoutMs: 25_000,
      maxBytes: 24 * 1024 * 1024,
      verifyTls: true,
      headers: {
        Referer: REFERER[(opts.platform ?? "bilibili") as PlatformId] ?? "https://www.bilibili.com/",
        Accept: "image/avif,image/webp,image/jpeg,image/png,*/*",
      },
    });

    const sharp = await loadSharp();
    const made: string[] = [];
    for (const slot of targets) {
      const dest = path.join(dir, slot.file);
      try {
        if (!sharp) {
          // 没有 sharp 就原样落地：Emby 会自己缩放，总比没有封面强
          await fs.promises.copyFile(tmpFile, dest);
        } else {
          await sharp(tmpFile)
            .resize({
              width: slot.width,
              ...(slot.keepRatio ? {} : { height: slot.height }),
              fit: slot.keepRatio ? "inside" : "cover",
              position: "attention",
              background: "#000000",
              withoutEnlargement: slot.keepRatio,
            })
            .jpeg({ quality: 90 })
            .toFile(dest);
        }
        made.push(slot.file);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, file: slot.file, dir: path.basename(dir) },
          "官方封面写入失败",
        );
      }
    }

    if (made.length) {
      logger.info(
        { dir: path.basename(dir), platform: opts.platform ?? null, files: made },
        `已用平台官方封面生成媒体图片：${made.join("、")}`,
      );
    }
    return made;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, host: safeHost(source), dir: path.basename(dir) },
      "官方封面下载失败，改用视频截帧",
    );
    return [];
  } finally {
    running.delete(dir);
    await fs.promises.unlink(tmpFile).catch(() => undefined);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
