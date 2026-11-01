import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { Download } from "../types";

/**
 * 媒体库目录树。
 *
 * 元数据页以「文件夹」为一条记录：一个剧集目录下面可能有 10 个视频，
 * 首级显示剧集（目录）信息，展开后子级显示目录里的每个文件。
 *
 * 文件夹有两个来源：
 *  1. 项目下载的：downloads 表里 media_kind=video 且已完成的记录，按所在目录聚合
 *  2. 手动添加的：用户在元数据页手动选中的视频文件 / 视频目录（media_sources 表）
 *
 * 为了让「手动选中的文件」和「项目下载的文件」共用一套编辑逻辑，
 * 这里统一用绝对路径描述一个文件，数据库里的 file_path 只用来补充
 * 剧集信息（简介、标签、频道等）。
 */

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|flv|wmv|ts|m4v|webm|mpeg|mpg|rmvb|rm|vob|m2ts|ogv|3gp)$/i;

/** 递归扫描视频文件的最大层级，防止误选到整块磁盘 */
const MAX_SCAN_DEPTH = 3;
/** 单个文件夹最多列出的文件数 */
const MAX_FILES_PER_FOLDER = 500;

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT_RE.test(name);
}

export interface MediaFileEntry {
  /** 绝对路径 */
  path: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 所在目录 */
  dir: string;
  /** 不带扩展名的文件名，NFO / 图片都按它命名 */
  base: string;
  size: number;
  /** 剧名（来自文件名或所在目录） */
  series: string;
  season: number | null;
  episode: number | null;
  /** 关联的下载记录（有就是项目下载的） */
  downloadId: number | null;
  channelTitle: string | null;
  messageId: number | null;
  /** 来源：download = 项目下载，manual = 手动选择 */
  source: "download" | "manual";
}

export interface MediaFolderEntry {
  /** 唯一标识：目录绝对路径 */
  key: string;
  dir: string;
  /** 展示名（目录名） */
  name: string;
  files: MediaFileEntry[];
  fileCount: number;
  totalSize: number;
  source: "download" | "manual" | "mixed";
  /**
   * 这个文件夹由哪些手动来源贡献。
   *
   * 手动添加一个上级目录（比如 D:\短剧）时，会按剧集文件夹拆成多条，
   * 这些条目的 sourceId 都指向同一个来源，删除按钮据此回溯删除。
   */
  sourceIds: number[];
  /** 贡献该文件夹的手动来源路径（去重后） */
  sourcePaths: string[];
}

/* ------------------------------------------------------------------ */
/* 手动来源                                                            */
/* ------------------------------------------------------------------ */

export interface MediaSourceRow {
  id: number;
  path: string;
  kind: "dir" | "file";
  title: string | null;
  created_at: number;
}

const stmtSources = db.prepare<[], MediaSourceRow>("SELECT * FROM media_sources ORDER BY id ASC");
const stmtSourceByPath = db.prepare<[string], MediaSourceRow>(
  "SELECT * FROM media_sources WHERE path = ? LIMIT 1",
);
const stmtInsertSource = db.prepare(
  "INSERT INTO media_sources (path, kind, title, created_at) VALUES (?, ?, ?, ?)",
);
const stmtDeleteSource = db.prepare<[number]>("DELETE FROM media_sources WHERE id = ?");

export function listSources(): MediaSourceRow[] {
  return stmtSources.all();
}

export function findSourceByPath(p: string): MediaSourceRow | undefined {
  return stmtSourceByPath.get(p);
}

export function addSource(filePath: string, kind: "dir" | "file", title: string | null): MediaSourceRow {
  const existing = findSourceByPath(filePath);
  if (existing) return existing;
  stmtInsertSource.run(filePath, kind, title, Date.now());
  return stmtSourceByPath.get(filePath) as MediaSourceRow;
}

export function removeSource(id: number): boolean {
  return stmtDeleteSource.run(id).changes > 0;
}

/* ------------------------------------------------------------------ */
/* 剧集信息推导                                                        */
/* ------------------------------------------------------------------ */

const SE_RE = /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/;
const EP_RE = /(?:^|[^a-zA-Z0-9])(?:EP|E)(\d{1,3})(?![0-9])/i;
/** 集号后面可能跟着一段序号（如「剧名S01E01-01」里的 -01），那不是剧名的一部分 */
const TRAILING_SEQ_RE = /[\s._-]\d{1,3}$/;

/**
 * 从文件名里解析剧名与集号。
 *
 *   我的妈妈徐秋曼S01E05.mp4   → 剧名「我的妈妈徐秋曼」，第 1 季第 5 集
 *   我的妈妈徐秋曼S01E01-01.mp4 → 剧名「我的妈妈徐秋曼」，第 1 季第 1 集（-01 是旧序号，忽略）
 *   第03集.mp4                 → 剧名取所在目录，第 3 集
 */
export function deriveEpisodeInfo(fileName: string, dirName: string): {
  series: string;
  season: number | null;
  episode: number | null;
} {
  const base = fileName.replace(VIDEO_EXT_RE, "");
  /** 去掉集号标记后，把尾巴上的序号一并去掉 */
  const cleanSeries = (raw: string): string => {
    const trimmed = raw.replace(TRAILING_SEQ_RE, "").replace(/[\s._-]+$/, "").trim();
    return trimmed || dirName;
  };
  const se = SE_RE.exec(base);
  if (se) {
    return {
      series: cleanSeries(base.replace(SE_RE, "")),
      season: Number(se[1]) || 1,
      episode: Number(se[2]) || null,
    };
  }
  const ep = EP_RE.exec(base);
  if (ep) {
    return {
      series: cleanSeries(base.replace(EP_RE, "")),
      season: null,
      episode: Number(ep[1]) || null,
    };
  }
  const cn = /第\s*([0-9]{1,4})\s*[集话話期]/.exec(base);
  if (cn) {
    return {
      series: cleanSeries(base.replace(/第\s*[0-9]{1,4}\s*[集话話期]/, "")),
      season: null,
      episode: Number(cn[1]) || null,
    };
  }
  return { series: dirName, season: null, episode: null };
}

/* ------------------------------------------------------------------ */
/* 目录扫描                                                            */
/* ------------------------------------------------------------------ */

/** 递归列出目录下的视频文件（最多 MAX_SCAN_DEPTH 层） */
export function scanVideoFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanVideoFiles(full, depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isVideoFile(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * 找出目录树里的剧集文件夹，并带上它们各自的视频。
 *
 * 手动添加一个上级目录（比如 D:\短剧）时，用户想看到的是里面每一剧一目录，
 * 而不是把所有视频平铺成一条。所以这里逐层往下找：
 *
 * - 目录里直接有视频 → 自己就是剧集文件夹
 * - 目录下的子目录全是「季目录」（Season 01 / S01 / 第1季）→ 自己仍是剧集文件夹，
 *   视频收季目录里的（Emby 常见的 剧名/Season 01/ep.mkv 结构）
 * - 其余情况 → 继续往子目录里找
 *
 * 返回值按层级从浅到深排序。
 */
export function collectSeriesDirs(root: string, depth = 0): Array<{ dir: string; files: string[] }> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const subDirs: string[] = [];
  const directVideos: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      subDirs.push(path.join(root, entry.name));
      continue;
    }
    if (entry.isFile() && isVideoFile(entry.name)) directVideos.push(path.join(root, entry.name));
  }

  // 子目录里还有视频的，先看看是不是「季目录」
  const subResults = subDirs.map((sub) => ({ sub, result: collectSeriesDirs(sub, depth + 1) }));
  const seasonSubs = subResults.filter((r) => r.result.length > 0 && isSeasonDir(path.basename(r.sub)));

  // 自己就装着视频 → 自己是一个剧集文件夹
  if (directVideos.length > 0) {
    const out: Array<{ dir: string; files: string[] }> = [{ dir: root, files: directVideos }];
    // 季目录归到自己名下，其余子目录另起一条
    const seasonSet = new Set(seasonSubs.map((r) => r.sub));
    for (const r of subResults) {
      if (seasonSet.has(r.sub)) continue;
      out.push(...r.result);
    }
    return out;
  }

  // 自己没视频，但子目录全是季目录 → 整季归到自己名下
  if (seasonSubs.length > 0 && seasonSubs.length === subResults.filter((r) => r.result.length > 0).length) {
    const files: string[] = [];
    for (const r of seasonSubs) for (const item of r.result) files.push(...item.files);
    return [{ dir: root, files }];
  }

  // 其余情况：展开子目录里找到的剧集文件夹
  const out: Array<{ dir: string; files: string[] }> = [];
  for (const r of subResults) out.push(...r.result);
  return out;
}

/** 季目录名：Season 01 / Season1 / S01 / 第1季 */
const SEASON_DIR_RE = /^(?:season|s)[\s._-]*\d{1,2}$|^第\s*\d{1,2}\s*季$/i;

export function isSeasonDir(name: string): boolean {
  return SEASON_DIR_RE.test(String(name ?? "").trim());
}

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const stmtDoneVideos = db.prepare<[], Download>(
  "SELECT * FROM downloads WHERE status = 'done' AND media_kind = 'video' AND file_path IS NOT NULL",
);

/**
 * 汇总所有可见的文件夹。
 *
 * - 项目下载的：按 file_path 所在目录聚合
 * - 手动添加的目录：按剧集文件夹拆开（里面的每一剧各成一条）
 * - 手动添加的文件：并入它所在的目录
 *
 * 手动来源的归属记在 folder.sourceIds / sourcePaths 上，
 * 供前端显示「删除」按钮——删的是来源，不是磁盘文件。
 */
export function collectFolders(): MediaFolderEntry[] {
  const folders = new Map<string, MediaFolderEntry>();
  const seenFiles = new Set<string>();

  const ensureFolder = (dir: string): MediaFolderEntry => {
    const key = path.resolve(dir);
    let folder = folders.get(key);
    if (!folder) {
      folder = {
        key,
        dir: key,
        name: path.basename(key) || key,
        files: [],
        fileCount: 0,
        totalSize: 0,
        source: "manual",
        sourceIds: [],
        sourcePaths: [],
      };
      folders.set(key, folder);
    }
    return folder;
  };

  const addFile = (folder: MediaFolderEntry, filePath: string, row?: Download): void => {
    const abs = path.resolve(filePath);
    if (seenFiles.has(abs)) return;
    seenFiles.add(abs);
    const dirName = path.basename(path.dirname(abs));
    const info = deriveEpisodeInfo(path.basename(abs), dirName);
    const size = row?.file_size ?? statSize(abs);
    folder.files.push({
      path: abs,
      name: path.basename(abs),
      dir: path.dirname(abs),
      base: path.basename(abs, path.extname(abs)),
      size,
      series: info.series,
      season: info.season,
      episode: info.episode,
      downloadId: row?.id ?? null,
      channelTitle: row?.channel_title ?? null,
      messageId: row?.message_id ?? null,
      source: row ? "download" : "manual",
    });
    folder.fileCount += 1;
    folder.totalSize += size;
  };

  /** 记住这个文件夹是被哪些手动来源带出来的 */
  const linkSource = (folder: MediaFolderEntry, source: MediaSourceRow): void => {
    if (!folder.sourceIds.includes(source.id)) folder.sourceIds.push(source.id);
    if (!folder.sourcePaths.includes(source.path)) folder.sourcePaths.push(source.path);
    // 手动来源只带出「文件」时，整条都是手动来源
    if (folder.source === "download") folder.source = "mixed";
    else folder.source = "manual";
  };

  // 1) 项目下载的文件
  for (const row of stmtDoneVideos.all()) {
    if (!row.file_path) continue;
    const dir = path.dirname(path.resolve(row.file_path));
    const folder = ensureFolder(dir);
    if (folder.source === "manual") folder.source = "download";
    addFile(folder, row.file_path, row);
  }

  // 2) 手动添加的来源
  for (const source of stmtSources.all()) {
    const abs = path.resolve(source.path);
    if (source.kind === "dir") {
      // 上级目录 → 拆成里面每一剧（剧集文件夹）
      const seriesDirs = collectSeriesDirs(abs);
      if (seriesDirs.length === 0) {
        // 一层都没拆出来（目录里没有视频），仍然登记一条，方便用户看到来源
        const folder = ensureFolder(abs);
        linkSource(folder, source);
        continue;
      }
      for (const item of seriesDirs) {
        const folder = ensureFolder(item.dir);
        linkSource(folder, source);
        for (const file of item.files) addFile(folder, file);
      }
    } else {
      const dir = path.dirname(abs);
      const folder = ensureFolder(dir);
      linkSource(folder, source);
      addFile(folder, abs);
    }
  }

  const list = [...folders.values()];
  for (const folder of list) {
    folder.files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    if (folder.files.length > MAX_FILES_PER_FOLDER) {
      folder.files = folder.files.slice(0, MAX_FILES_PER_FOLDER);
      folder.fileCount = folder.files.length;
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  return list;
}

/* ------------------------------------------------------------------ */
/* 路径校验                                                            */
/* ------------------------------------------------------------------ */

/** 允许操作的路径：下载目录内，或手动添加过的来源（含其子目录） */
export function isAllowedPath(target: string): boolean {
  const abs = path.resolve(target);
  const downloadRoot = path.resolve(env.downloadDir);
  if (abs === downloadRoot || abs.startsWith(downloadRoot + path.sep)) return true;

  for (const source of stmtSources.all()) {
    const root = path.resolve(source.path);
    if (source.kind === "file") {
      if (abs === root) return true;
      continue;
    }
    if (abs === root || abs.startsWith(root + path.sep)) return true;
  }
  return false;
}

/** 按文件名反查下载记录（用于补充剧集信息） */
export function findDownloadByPath(filePath: string): Download | undefined {
  const abs = path.resolve(filePath);
  const stmt = db.prepare<[string], Download>("SELECT * FROM downloads WHERE file_path = ? LIMIT 1");
  const direct = stmt.get(abs);
  if (direct) return direct;
  // Windows 上盘符大小写/分隔符可能不一致，做一次宽松匹配
  const loose = db
    .prepare<[string], Download>(
      "SELECT * FROM downloads WHERE file_path = ? COLLATE NOCASE LIMIT 1",
    )
    .get(abs.replace(/\//g, path.sep));
  return loose;
}
