import fs from "node:fs";
import path from "node:path";
import { env } from "./env";
import { getSettings } from "./db";
import { logger } from "./logger";

import {
  CacheGroup,
  DEFAULT_KEEP_RATIO,
  DEFAULT_MIN_AGE_MS,
  coverGroupKey,
  humanBytes,
  selectEvictions,
} from "./lib/cacheplan";

// 纯函数在 lib/cacheplan.ts，这里重导出，路由与自检都从同一处取
export { coverGroupKey, humanBytes, selectEvictions } from "./lib/cacheplan";
export type { CacheGroup, CacheScope, EvictOptions } from "./lib/cacheplan";


/**
 * data 下的两个缓存目录，删了都能重建：
 *
 *  - covers：消息列表的「封面预览」，每组是 `<频道ID>-<消息ID>-1..3.jpg` 加一份同名 json
 *  - frames：元数据页「截帧」的候选帧，每个目标一个子目录（`f-1..f-8.jpg` + preview.jpg），
 *            另有 1.0.2 及以前自动截帧留下的 `auto/<hash>` 遗留目录
 *
 * 真正不能碰的是 tgsub.db / downloads / logs，本模块只在这两个目录里动手。
 * 清理按「组」为单位（covers 的一组封面、frames 的一个子目录），
 * 否则一组图被删掉一半，界面预览会缺图。
 */

const MB = 1024 * 1024;

export interface CacheUsage {
  bytes: number;
  files: number;
  groups: number;
}

export interface CacheStats {
  covers: CacheUsage;
  frames: CacheUsage;
  total: CacheUsage;
  limitMb: number;
  /** 超出上限的字节数；没超为 0 */
  overBytes: number;
  lastTrimAt: number | null;
  lastTrimFreed: number;
  lastTrimReason: "auto" | "manual" | "clear" | null;
}

export interface TrimResult {
  freed: number;
  removedGroups: number;
  removedFiles: number;
  /** 清理后剩余总量 */
  remaining: number;
  /** 是否因为达到上限而触发 */
  triggered: boolean;
}

/** 运行期统计，进程重启后归零（占用是实时算的，不依赖它） */
let lastTrimAt: number | null = null;
let lastTrimFreed = 0;
let lastTrimReason: "auto" | "manual" | "clear" | null = null;

/* ----------------------------- 目录扫描 ----------------------------- */

function cacheRoots(): { covers: string; frames: string } {
  return {
    covers: path.join(env.dataDir, "covers"),
    frames: path.join(env.dataDir, "frames"),
  };
}

interface ListedFile {
  file: string;
  size: number;
  mtime: number;
}

async function listFiles(dir: string): Promise<ListedFile[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ListedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(file);
      out.push({ file, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      // 扫描过程中被别的请求删掉了，跳过
    }
  }
  return out;
}

/** 递归统计一个子目录，顺带取最新 mtime */
async function measureDir(dir: string): Promise<{ bytes: number; files: number; mtime: number }> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, mtime: 0 };
  }
  let bytes = 0;
  let files = 0;
  let mtime = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measureDir(full);
      bytes += sub.bytes;
      files += sub.files;
      mtime = Math.max(mtime, sub.mtime);
      continue;
    }
    try {
      const stat = await fs.promises.stat(full);
      bytes += stat.size;
      files += 1;
      mtime = Math.max(mtime, stat.mtimeMs);
    } catch {
      /* 同上 */
    }
  }
  return { bytes, files, mtime };
}

/** 收集 covers 目录：同一条消息的几张图与 json 归成一组 */
async function collectCovers(root: string): Promise<CacheGroup[]> {
  const files = await listFiles(root);
  const map = new Map<string, CacheGroup>();
  for (const item of files) {
    const key = coverGroupKey(item.file);
    const group = map.get(key) ?? {
      key,
      scope: "covers" as const,
      paths: [],
      bytes: 0,
      files: 0,
      mtime: 0,
    };
    group.paths.push(item.file);
    group.bytes += item.size;
    group.files += 1;
    group.mtime = Math.max(group.mtime, item.mtime);
    map.set(key, group);
  }
  return [...map.values()];
}

async function collectFrames(root: string): Promise<CacheGroup[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const groups: CacheGroup[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const measured = await measureDir(full);
      if (!measured.files) continue;
      groups.push({
        key: entry.name,
        scope: "frames",
        paths: [full],
        bytes: measured.bytes,
        files: measured.files,
        mtime: measured.mtime,
      });
      continue;
    }
    try {
      const stat = await fs.promises.stat(full);
      groups.push({
        key: entry.name,
        scope: "frames",
        paths: [full],
        bytes: stat.size,
        files: 1,
        mtime: stat.mtimeMs,
      });
    } catch {
      /* ignore */
    }
  }
  return groups;
}

/** 收集两个缓存目录的所有分组，顺带算出各目录占用 */
export async function collectCache(): Promise<{
  groups: CacheGroup[];
  covers: CacheUsage;
  frames: CacheUsage;
}> {
  const roots = cacheRoots();
  const [covers, frames] = await Promise.all([collectCovers(roots.covers), collectFrames(roots.frames)]);
  const sum = (list: CacheGroup[]): CacheUsage => ({
    bytes: list.reduce((total, group) => total + group.bytes, 0),
    files: list.reduce((total, group) => total + group.files, 0),
    groups: list.length,
  });
  return { groups: [...covers, ...frames], covers: sum(covers), frames: sum(frames) };
}

/* ----------------------------- 清理策略 ----------------------------- */

async function removeGroup(group: CacheGroup): Promise<void> {
  for (const target of group.paths) {
    try {
      const stat = await fs.promises.stat(target);
      if (stat.isDirectory()) {
        await fs.promises.rm(target, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(target);
      }
    } catch {
      // 已经不存在了，当作删成功
    }
  }
}

/**
 * 按上限清理一次。limitMb 为 0 表示不限制（直接返回）。
 * force=true 时忽略 minAgeMs，用于用户点「立即清理」。
 */
export async function trimCache(opts: {
  reason?: "auto" | "manual";
  force?: boolean;
} = {}): Promise<TrimResult & { limitMb: number }> {
  const limitMb = Math.max(0, Math.round(Number(getSettings().cache_limit_mb) || 0));
  const { groups, covers, frames } = await collectCache();
  const before = covers.bytes + frames.bytes;
  const empty: TrimResult & { limitMb: number } = {
    freed: 0,
    removedGroups: 0,
    removedFiles: 0,
    remaining: before,
    triggered: false,
    limitMb,
  };
  if (!limitMb) return empty;

  const evicted = selectEvictions(groups, limitMb * MB, {
    minAgeMs: opts.force ? 0 : DEFAULT_MIN_AGE_MS,
  });
  if (!evicted.length) return empty;

  for (const group of evicted) {
    await removeGroup(group);
  }

  const after = await collectCache();
  const remaining = after.covers.bytes + after.frames.bytes;
  // 以实际前后差为准，兜底值只用于日志展示
  const actualFreed = Math.max(0, before - remaining);

  lastTrimAt = Date.now();
  lastTrimFreed = actualFreed;
  lastTrimReason = opts.reason ?? "manual";

  logger.info(
    {
      freed: humanBytes(actualFreed),
      groups: evicted.length,
      files: evicted.reduce((sum, group) => sum + group.files, 0),
      remaining: humanBytes(remaining),
      limit: `${limitMb} MB`,
    },
    `缓存清理完成：删除 ${evicted.length} 组 / 释放 ${humanBytes(actualFreed)}，剩余 ${humanBytes(remaining)}`,
  );

  return {
    freed: actualFreed,
    removedGroups: evicted.length,
    removedFiles: evicted.reduce((sum, group) => sum + group.files, 0),
    remaining,
    triggered: true,
    limitMb,
  };
}

/** 一键清空：两个缓存目录里的东西全删，目录本身保留 */
export async function clearCache(): Promise<TrimResult> {
  const roots = cacheRoots();
  const { covers, frames } = await collectCache();
  const before = covers.bytes + frames.bytes;

  let removedGroups = 0;
  let removedFiles = 0;
  for (const root of [roots.covers, roots.frames]) {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      try {
        if (entry.isDirectory()) {
          const measured = await measureDir(full);
          removedFiles += measured.files;
          removedGroups += 1;
          await fs.promises.rm(full, { recursive: true, force: true });
        } else {
          removedFiles += 1;
          removedGroups += 1;
          await fs.promises.unlink(full);
        }
      } catch {
        /* 并发删除，忽略 */
      }
    }
  }

  const after = await collectCache();
  const remaining = after.covers.bytes + after.frames.bytes;
  const freed = Math.max(0, before - remaining);

  lastTrimAt = Date.now();
  lastTrimFreed = freed;
  lastTrimReason = "clear";

  logger.info(
    { freed: humanBytes(freed), files: removedFiles },
    `已清空缓存：删除 ${removedFiles} 个文件，释放 ${humanBytes(freed)}`,
  );

  return {
    freed,
    removedGroups,
    removedFiles,
    remaining,
    triggered: true,
  };
}

export async function cacheStats(): Promise<CacheStats> {
  const limitMb = Math.max(0, Math.round(Number(getSettings().cache_limit_mb) || 0));
  const { covers, frames } = await collectCache();
  const totalBytes = covers.bytes + frames.bytes;
  return {
    covers,
    frames,
    total: {
      bytes: totalBytes,
      files: covers.files + frames.files,
      groups: covers.groups + frames.groups,
    },
    limitMb,
    overBytes: limitMb ? Math.max(0, totalBytes - limitMb * MB) : 0,
    lastTrimAt,
    lastTrimFreed,
    lastTrimReason,
  };
}

/* ----------------------------- 自动触发 ----------------------------- */

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * 下载完成 / 截帧之后调用。攒 3 秒再算一次，避免连下多集时反复扫目录。
 * 没设上限就直接跳过。
 */
export function requestCacheTrim(delayMs = 3000): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runAutoTrim();
  }, delayMs);
  timer.unref?.();
}

async function runAutoTrim(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!Number(getSettings().cache_limit_mb)) return;
    await trimCache({ reason: "auto" });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "缓存自动清理失败");
  } finally {
    running = false;
  }
}
