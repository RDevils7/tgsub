import fs from "node:fs";
import path from "node:path";
import { sanitizeSegment } from "../utils";

/**
 * 媒体路径的纯函数工具。
 *
 * 单独拆出来是为了让「删除管理」的核心规则（怎么找视频、副产物怎么命名）
 * 可以在不碰数据库的情况下自检 —— 这个模块不 import db / env。
 */

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|flv|wmv|ts|m4v|webm|mpeg|mpg|rmvb|rm|vob|m2ts|ogv|3gp)$/i;

/** 视频后缀正则（解析剧名时要把后缀去掉） */
export { VIDEO_EXT_RE };

/** 图片后缀（封面、缩略图都算） */
export const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

/** 递归找视频的最大层级（剧集 / 季 / 集 三层足够，再深就当异常目录） */
export const MAX_VIDEO_DEPTH = 6;

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT_RE.test(name);
}

/** 目标是否在另一个路径之下（含相等） */
export function isUnderPath(child: string, parent: string): boolean {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
}

/** 递归收集目录下的视频文件 */
export function collectVideos(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > MAX_VIDEO_DEPTH) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectVideos(full, depth + 1, acc);
      continue;
    }
    if (entry.isFile() && isVideoFile(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * 单集视频的副产物：<base>.nfo 与 <base>-*.图片。
 *
 * 命名规则与元数据页写文件时完全一致（都走 sanitizeSegment），
 * 所以删视频时能准确带走它的 NFO 与缩略图。
 */
export function episodeArtifacts(videoPath: string): { nfo: string; images: string[] } {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const safe = sanitizeSegment(base, 120);
  const images: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.startsWith(`${safe}-`)) continue;
    if (!IMAGE_EXT_RE.test(name)) continue;
    images.push(path.join(dir, name));
  }
  return { nfo: path.join(dir, `${safe}.nfo`), images };
}
