import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import {
  collectVideos,
  episodeArtifacts,
  IMAGE_EXT_RE,
  isUnderPath,
  MAX_VIDEO_DEPTH,
} from "./mediapath";
import { excludePath, listSources, restorePath } from "./mediatree";

/**
 * 媒体条目的删除管理。
 *
 * 元数据页的目录树里每一项都能删 —— 剧集目录、单集视频，行为要像文件管理器。
 * 两种模式：
 *
 *   purge  —— 连磁盘文件一起删（视频 + NFO + 封面图），不可恢复
 *   unlink —— 只从列表移除，磁盘文件原封不动
 *
 * 两种模式都会同步清理数据库：
 *   - downloads 里指向这些文件的下载记录
 *   - media_sources 里对应的手动来源登记
 *
 * unlink 额外写一条 media_excluded（隐藏登记），这样即便文件还在磁盘上、
 * 仍被某个上级目录来源覆盖，也不会再出现在目录树里；恢复显示只需删掉这条登记。
 */

export type DeleteMode = "purge" | "unlink";

export interface DeleteItem {
  /** 绝对路径 */
  path: string;
  name: string;
  /** video = 视频本体，nfo = 元数据文件，image = 封面/缩略图，other = 其它文件 */
  kind: "video" | "nfo" | "image" | "other";
  size: number;
}

export interface DeletePlan {
  target: string;
  targetKind: "file" | "folder";
  mode: DeleteMode;
  /**
   * 目标在磁盘上是否还在。
   *
   * 元数据页的记录来自 downloads 与 media_sources 两张表，文件被外部删掉
   * （手动删、挂载盘换了、容器路径变了）之后记录仍然在 —— 这时删除操作
   * 只该清理记录，不能再因为「文件不存在」把用户挡在门外。
   */
  targetExists: boolean;
  /** 会被删除的文件 */
  items: DeleteItem[];
  /** 不会被删除、但列出来让用户知情的其它文件 */
  kept: DeleteItem[];
  totalSize: number;
  videoCount: number;
  nfoCount: number;
  imageCount: number;
  /** 会被一并清掉的下载记录 id */
  downloadIds: number[];
  /** 会被一并清掉的手动来源 id */
  sourceIds: number[];
  /** 提示信息（不可逆操作、保留的文件、来源影响等） */
  warnings: string[];
}

export interface DeleteResult {
  ok: boolean;
  mode: DeleteMode;
  /** 目标在磁盘上本来就不存在：本次只清理了数据库记录 */
  targetExists: boolean;
  /** 实际删除的磁盘文件数 */
  removedFiles: number;
  /** 实际删除的字节数 */
  removedBytes: number;
  removedVideos: number;
  removedDirs: number;
  removedDownloads: number;
  removedSources: number;
  /** 删除失败的路径 */
  failed: string[];
}

/* ------------------------------------------------------------------ */
/* 文件名约定                                                          */
/* ------------------------------------------------------------------ */

/** 剧集级的封面槽位，和元数据页一致 */
const SERIES_IMAGE_NAMES = ["poster", "landscape", "fanart", "thumb", "banner"];

/** 其它文件最多列多少条 */
const MAX_KEPT = 50;

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export { collectVideos, episodeArtifacts };

/** 统计目录里不会被删除的其它文件数量（递归，含季目录） */
function countOtherFiles(dir: string, planned: Set<string>, depth = 0): number {
  if (depth > MAX_VIDEO_DEPTH) return 0;
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countOtherFiles(full, planned, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (planned.has(full)) continue;
    count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* 删除计划                                                            */
/* ------------------------------------------------------------------ */

const stmtDownloads = db.prepare<[], { id: number; file_path: string | null }>(
  "SELECT id, file_path FROM downloads WHERE file_path IS NOT NULL",
);

/** 目标是否在另一个路径之下（含相等） */
const under = isUnderPath;

export function planDelete(targetPath: string, kind: "file" | "folder", mode: DeleteMode): DeletePlan {
  const target = path.resolve(targetPath);
  const targetExists = exists(target);
  const items: DeleteItem[] = [];
  const kept: DeleteItem[] = [];
  const warnings: string[] = [];

  if (kind === "file") {
    // 目标已经不在了就别列进「将删除的文件」，否则预览会显示一个 0 字节的幽灵文件
    if (targetExists) {
      items.push({ path: target, name: path.basename(target), kind: "video", size: statSize(target) });
      const art = episodeArtifacts(target);
      if (exists(art.nfo)) {
        items.push({ path: art.nfo, name: path.basename(art.nfo), kind: "nfo", size: statSize(art.nfo) });
      }
      for (const img of art.images) {
        items.push({ path: img, name: path.basename(img), kind: "image", size: statSize(img) });
      }
    }
  } else if (targetExists) {
    const videos = collectVideos(target);
    for (const video of videos) {
      items.push({ path: video, name: path.basename(video), kind: "video", size: statSize(video) });
      const art = episodeArtifacts(video);
      if (exists(art.nfo)) {
        items.push({ path: art.nfo, name: path.basename(art.nfo), kind: "nfo", size: statSize(art.nfo) });
      }
      for (const img of art.images) {
        items.push({ path: img, name: path.basename(img), kind: "image", size: statSize(img) });
      }
    }

    // 剧集级：tvshow.nfo 与五张封面
    let names: string[] = [];
    try {
      names = fs.readdirSync(target);
    } catch {
      names = [];
    }
    const showNfo = path.join(target, "tvshow.nfo");
    if (exists(showNfo)) {
      items.push({ path: showNfo, name: "tvshow.nfo", kind: "nfo", size: statSize(showNfo) });
    }
    for (const file of names) {
      const stem = path.basename(file, path.extname(file));
      if (!SERIES_IMAGE_NAMES.includes(stem)) continue;
      if (!IMAGE_EXT_RE.test(file)) continue;
      const full = path.join(target, file);
      items.push({ path: full, name: file, kind: "image", size: statSize(full) });
    }

    // 其它文件（字幕、说明、logo 等）不删，列出来让用户心里有数
    const planned = new Set(items.map((item) => item.path));
    for (const file of names) {
      if (file.startsWith(".")) continue;
      const full = path.join(target, file);
      if (planned.has(full)) continue;
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) continue;
      kept.push({ path: full, name: file, kind: "other", size: statSize(full) });
    }
    kept.sort((a, b) => b.size - a.size);
    if (kept.length > MAX_KEPT) kept.length = MAX_KEPT;
  }

  // 数据库里要跟着清理的记录
  const downloadIds: number[] = [];
  for (const row of stmtDownloads.all()) {
    if (!row.file_path) continue;
    const abs = path.resolve(row.file_path);
    if (kind === "file" ? abs === target : under(abs, target)) downloadIds.push(row.id);
  }
  const sourceIds: number[] = [];
  for (const source of listSources()) {
    const abs = path.resolve(source.path);
    if (kind === "file" ? abs === target : under(abs, target)) sourceIds.push(source.id);
  }

  // 提示
  const plannedSet = new Set(items.map((item) => item.path));
  const otherCount = kind === "folder" && targetExists ? countOtherFiles(target, plannedSet) : 0;
  if (!targetExists) {
    warnings.push("磁盘上已经找不到这个位置了，本次只清理数据库里的记录。");
  } else if (mode === "purge") {
    warnings.push("磁盘文件会被真正删除，无法恢复。");
  } else {
    warnings.push("磁盘文件保留，只是不再显示和管理。");
  }
  if (otherCount > 0) {
    warnings.push(`目录里还有 ${otherCount} 个其它文件不会删除（如字幕、说明）。`);
  }
  if (downloadIds.length > 0) {
    warnings.push(`同时清除 ${downloadIds.length} 条下载记录。`);
  }
  if (sourceIds.length > 0) {
    warnings.push(`同时注销 ${sourceIds.length} 个手动来源登记。`);
  }

  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  return {
    target,
    targetKind: kind,
    mode,
    targetExists,
    items,
    kept,
    totalSize,
    videoCount: items.filter((item) => item.kind === "video").length,
    nfoCount: items.filter((item) => item.kind === "nfo").length,
    imageCount: items.filter((item) => item.kind === "image").length,
    downloadIds,
    sourceIds,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 执行删除                                                            */
/* ------------------------------------------------------------------ */

/** 自底向上清掉空目录（删完视频后把空壳收走） */
async function removeEmptyDirs(dir: string): Promise<number> {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    removed += await removeEmptyDirs(path.join(dir, entry.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0) {
      await fs.promises.rmdir(dir);
      removed += 1;
    }
  } catch {
    // 目录非空或已被删，忽略
  }
  return removed;
}

/**
 * 删除记录之后，是否还有「上级目录型」来源覆盖这个位置。
 *
 * 例：登记了来源 `D:\短剧`，其中 `D:\短剧\合租室友` 被外部删掉了。
 * 把记录清干净也没用 —— 下次展开 `D:\短剧` 时，那个空壳目录又会被
 * 重新登记出来（collectFolders 在「一层都没拆出来」时会补一条）。
 * 所以这种情况必须写一条隐藏登记把它压住。
 */
function hasAncestorSource(target: string): boolean {
  const abs = path.resolve(target);
  for (const source of listSources()) {
    if (source.kind !== "dir") continue;
    const root = path.resolve(source.path);
    if (root !== abs && abs.startsWith(root + path.sep)) return true;
  }
  return false;
}

/**
 * 执行删除。
 *
 * purge  —— 删磁盘文件（视频 + NFO + 图片）+ 清数据库
 * unlink —— 只清数据库 + 登记隐藏
 *
 * 目标本来就不在磁盘上时（记录残留），两种模式都只清记录，不再报错。
 */
export async function executeDelete(plan: DeletePlan): Promise<DeleteResult> {
  const failed: string[] = [];
  let removedFiles = 0;
  let removedBytes = 0;
  let removedVideos = 0;
  let removedDirs = 0;

  if (plan.mode === "purge") {
    for (const item of plan.items) {
      try {
        await fs.promises.unlink(item.path);
        removedFiles += 1;
        removedBytes += item.size;
        if (item.kind === "video") removedVideos += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // 文件已经不在了（ENOENT）不算失败
        if (code !== "ENOENT") failed.push(item.path);
      }
    }
    if (plan.targetKind === "folder") {
      removedDirs = await removeEmptyDirs(plan.target);
    }
  }

  // 数据库：下载记录
  let removedDownloads = 0;
  if (plan.downloadIds.length > 0) {
    const stmt = db.prepare("DELETE FROM downloads WHERE id = ?");
    for (const id of plan.downloadIds) removedDownloads += stmt.run(id).changes;
  }

  // 数据库：手动来源登记
  let removedSources = 0;
  if (plan.sourceIds.length > 0) {
    const stmt = db.prepare("DELETE FROM media_sources WHERE id = ?");
    for (const id of plan.sourceIds) removedSources += stmt.run(id).changes;
  }

  // 隐藏登记：
  //   unlink              → 写一条隐藏，压住还在磁盘上的文件
  //   purge 且目标缺失    → 若还有上级来源覆盖，也得压住，否则空壳会重新冒出来
  //   其余                → 文件真删了，把旧的隐藏登记一并清掉
  const needsHide = plan.mode === "unlink" || (!plan.targetExists && hasAncestorSource(plan.target));
  if (needsHide) {
    excludePath(plan.target);
  } else {
    restorePath(plan.target);
  }

  return {
    ok: failed.length === 0,
    mode: plan.mode,
    targetExists: plan.targetExists,
    removedFiles,
    removedBytes,
    removedVideos,
    removedDirs,
    removedDownloads,
    removedSources,
    failed,
  };
}
