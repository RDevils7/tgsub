import path from "node:path";

/**
 * 缓存清理的纯函数部分：分组、挑要删的组、字节格式化。
 * 不碰文件系统、不读设置，自检可以直接 import（cache.ts 会重导出这些）。
 */

export type CacheScope = "covers" | "frames";

export interface CacheGroup {
  /** 展示名：covers 是 `channel-message`，frames 是子目录名 */
  key: string;
  scope: CacheScope;
  /** 组内所有待删路径：covers 是若干个文件，frames 是子目录本身 */
  paths: string[];
  bytes: number;
  files: number;
  /** 组内最新一次写入时间（ms） */
  mtime: number;
}

export interface EvictOptions {
  /** 清到上限的这个比例即停手，默认 0.8 */
  keepRatio?: number;
  /** 最近这么久内改动的组先不删，默认 10 分钟 */
  minAgeMs?: number;
  /** 判定「现在」的时间戳，便于测试 */
  now?: number;
}

/** 自动清理时，最近这么久的组先不动，避免删掉用户正在挑的候选帧 */
export const DEFAULT_MIN_AGE_MS = 10 * 60_000;
/** 清到上限的这个比例就停手，留出余量，免得每下一集都触发一次清理 */
export const DEFAULT_KEEP_RATIO = 0.8;

const MB = 1024 * 1024;

export function humanBytes(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

/** `<频道ID>-<消息ID>-1.jpg` / `<频道ID>-<消息ID>.json` → `<频道ID>-<消息ID>` */
export function coverGroupKey(fileName: string): string {
  const match = /^(-?\d+-\d+)/.exec(path.basename(fileName));
  return match ? match[1] : path.basename(fileName);
}

/**
 * 给定分组与上限，挑出要删的组（按 mtime 从旧到新），不碰文件系统。
 *
 * 超过上限才动手，并且一次清到 keepRatio × 上限，避免频繁触发；
 * minAgeMs 内的组跳过，免得删掉用户正在挑选的候选帧。
 */
export function selectEvictions(
  groups: CacheGroup[],
  limitBytes: number,
  opts: EvictOptions = {},
): CacheGroup[] {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return [];
  const keepRatio = Math.min(0.99, Math.max(0.1, opts.keepRatio ?? DEFAULT_KEEP_RATIO));
  const minAgeMs = Math.max(0, opts.minAgeMs ?? DEFAULT_MIN_AGE_MS);
  const now = opts.now ?? Date.now();

  const total = groups.reduce((sum, group) => sum + group.bytes, 0);
  if (total <= limitBytes) return [];

  const target = Math.floor(limitBytes * keepRatio);
  const candidates = groups
    .filter((group) => now - group.mtime >= minAgeMs)
    .sort((a, b) => a.mtime - b.mtime);

  const evicted: CacheGroup[] = [];
  let remaining = total;
  for (const group of candidates) {
    if (remaining <= target) break;
    evicted.push(group);
    remaining -= group.bytes;
  }
  return evicted;
}
