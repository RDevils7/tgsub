import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { logger } from "../logger";
import { queueEmbyUpdate } from "./embyapi";
import { episodeArtifacts, isVideoFile } from "./mediapath";
import { samePath, type RenamePlan } from "./renameplan";

/**
 * 执行「改名 / 合并剧集」的计划。
 *
 * 为什么要两阶段：把 `A.mp4` 排到第 1、`B.mp4` 排到第 2 时，B 的新名字可能正好
 * 等于 A 的旧名字，一 rename 到底必然撞车。统一先把所有文件挪到临时名
 * （`.tgsub-rn-<n>.mp4`），再落到最终名，顺序才是绝对可靠的。
 *
 * 中途失败会尽量回滚：把已经挪走的文件放回原位，不让目录里留一堆临时文件。
 */

export interface RenameOutcome {
  /** 真正动了位置的视频数 */
  moved: number;
  /** 跟着改名的副产物（nfo / 缩略图）数量 */
  sidecars: number;
  /** 同步更新的下载记录数 */
  downloads: number;
  /** 清掉的空目录数 */
  emptyDirs: number;
  /** 因为目标已存在而跳过的副产物 */
  skipped: string[];
  /** 单个文件失败（不影响其余文件） */
  failed: Array<{ path: string; error: string }>;
}

function exists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/** 路径比较键（Windows 大小写不敏感） */
function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** 移动文件：同盘 rename；跨盘（EXDEV）退化成复制后删除 */
async function moveFile(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from).catch(() => undefined);
  }
}

interface SidecarMove {
  from: string;
  to: string;
  /** 副产物自己的中转名 */
  tmp: string;
  /** 原始宿主视频路径，仅用于日志 */
  owner: string;
}

/**
 * 推导一集视频要跟着改名的副产物。
 *
 * 规则与写文件时一致：`<base>.nfo`、`<base>-thumb.jpg` 等。
 * 用 episodeArtifacts 拿清单，再把这些名字的目标前缀换成新 base。
 */
function sidecarMoves(from: string, to: string, idx: number): SidecarMove[] {
  const art = episodeArtifacts(from);
  const fromBase = path.basename(from, path.extname(from));
  const toDir = path.dirname(to);
  const toBase = path.basename(to, path.extname(to));
  const out: SidecarMove[] = [];
  const push = (src: string): void => {
    if (!exists(src)) return;
    const name = path.basename(src);
    // 前缀之后的部分原样保留：`.nfo`、`-thumb.jpg`、`-1.jpg`……
    const suffix = name.startsWith(fromBase) ? name.slice(fromBase.length) : path.extname(name);
    out.push({
      from: src,
      to: path.join(toDir, `${toBase}${suffix}`),
      tmp: path.join(path.dirname(src), `.tgsub-sc-${idx}${path.extname(src)}`),
      owner: from,
    });
  };
  push(art.nfo);
  for (const img of art.images) push(img);
  return out;
}

/** 自底向上清掉空目录（不会删 targetDir 本身之外的父级） */
async function removeEmptyDirs(dir: string, keep: string, depth = 0): Promise<number> {
  if (depth > 8) return 0;
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    removed += await removeEmptyDirs(path.join(dir, entry.name), keep, depth + 1);
  }
  if (samePath(dir, keep)) return removed;
  try {
    if (fs.readdirSync(dir).length === 0) {
      await fs.promises.rmdir(dir);
      removed += 1;
    }
  } catch {
    // 非空或已被删
  }
  return removed;
}

const stmtListPaths = db.prepare<[], { id: number; file_path: string | null }>(
  "SELECT id, file_path FROM downloads WHERE file_path IS NOT NULL",
);
const stmtUpdatePath = db.prepare<[string, string, number]>(
  "UPDATE downloads SET file_path = ?, save_name = ? WHERE id = ?",
);

/** 剧集级的固定文件名（名字不随剧名变，搬家时原名带走） */
const SERIES_SLOT_STEMS = ["poster", "landscape", "fanart", "thumb", "banner"];

/** 判断一个文件名是不是剧集级的东西（五张封面 + tvshow.nfo） */
function isSeriesLevelFile(name: string): boolean {
  if (name.startsWith(".")) return false;
  const stem = path.basename(name, path.extname(name)).toLowerCase();
  return stem === "tvshow" || SERIES_SLOT_STEMS.includes(stem);
}

/**
 * 把源目录里的剧集级文件（tvshow.nfo 与五张封面）搬到新目录。
 *
 * 这些文件的名字是 Emby 认死的槽位名，不跟着剧名变，但目录改名后必须一起搬 ——
 * 否则封面和剧集 NFO 会被留在旧目录里，旧目录也因此删不干净。
 */
async function moveSeriesLevelFiles(
  fromDirs: string[],
  targetDir: string,
  moved: Set<string>,
  result: RenameOutcome,
): Promise<void> {
  const taken = new Set<string>();
  for (const dir of fromDirs) {
    if (samePath(dir, targetDir)) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    // 这个目录里还有本次不搬的视频 → 它仍是一部在用的剧，
    // 别把它的 tvshow.nfo / 封面顺手搬到目标目录（那是另一部剧的元数据）。
    const remains = names.some(
      (name) => isVideoFile(name) && !moved.has(canonicalPath(path.join(dir, name))),
    );
    if (remains) continue;
    for (const name of names) {
      if (!isSeriesLevelFile(name)) continue;
      const to = path.join(targetDir, name);
      if (taken.has(name.toLowerCase()) || exists(to)) {
        result.skipped.push(`${name}（目标已有同名文件，保留在 ${dir}）`);
        continue;
      }
      try {
        await moveFile(path.join(dir, name), to);
        taken.add(name.toLowerCase());
        result.sidecars += 1;
      } catch (err) {
        result.skipped.push(`${name}（${(err as Error).message}）`);
      }
    }
  }
}

export async function executeRenamePlan(plan: RenamePlan): Promise<RenameOutcome> {
  const result: RenameOutcome = {
    moved: 0,
    sidecars: 0,
    downloads: 0,
    emptyDirs: 0,
    skipped: [],
    failed: [],
  };

  await fs.promises.mkdir(plan.targetDir, { recursive: true });

  // 原地已经叫对的不用动（重复执行同一份计划时不会瞎折腾）
  const effective = plan.items.filter((item) => !samePath(item.from, item.to));
  /** 本次真正要搬走的视频（用于判断源目录是否还有留下没搬的剧集） */
  const moved = new Set(effective.map((item) => canonicalPath(item.from)));
  /** 有文件搬走的源目录（剧集级封面要从这里一起搬） */
  const sourceDirs = [...new Set(effective.map((item) => path.dirname(item.from)))];

  // 副产物清单必须在移动视频之前算 —— 移动后就找不到它了
  const sidecars: SidecarMove[] = [];
  let scIdx = 0;
  for (const item of effective) {
    for (const move of sidecarMoves(item.from, item.to, (scIdx += 1))) sidecars.push(move);
  }

  // 记录每个文件当前在哪，回滚时按实际位置放回去
  const tracked = new Map<string, string>();
  for (const item of effective) tracked.set(item.from, item.from);
  const trackedSide = new Map<SidecarMove, string>();
  for (const move of sidecars) trackedSide.set(move, move.from);

  try {
    // 第一阶段：视频 → 临时名
    for (const item of effective) {
      await moveFile(item.from, item.tmp);
      tracked.set(item.from, item.tmp);
    }
    // 第二阶段：临时名 → 最终名
    for (const item of effective) {
      await moveFile(item.tmp, item.to);
      tracked.set(item.from, item.to);
      result.moved += 1;
    }

    // 副产物同样两阶段，避免新旧名字互相占位
    const alive: SidecarMove[] = [];
    for (const move of sidecars) {
      try {
        await moveFile(move.from, move.tmp);
        trackedSide.set(move, move.tmp);
        alive.push(move);
      } catch (err) {
        result.skipped.push(`${path.basename(move.from)}（${(err as Error).message}）`);
      }
    }
    for (const move of alive) {
      try {
        await moveFile(move.tmp, move.to);
        trackedSide.set(move, move.to);
        result.sidecars += 1;
      } catch (err) {
        result.skipped.push(`${path.basename(move.to)}（${(err as Error).message}）`);
      }
    }

    // 剧集级封面与 tvshow.nfo：文件名是 Emby 认死的槽位，原样搬进新目录
    await moveSeriesLevelFiles(sourceDirs, plan.targetDir, moved, result);
  } catch (err) {
    // 回滚：把所有动过的文件放回原位
    const rollbackErrors: string[] = [];
    for (const [from, current] of tracked) {
      if (samePath(current, from)) continue;
      try {
        if (exists(current)) await moveFile(current, from);
      } catch (e) {
        rollbackErrors.push(`${path.basename(from)}：${(e as Error).message}`);
      }
    }
    for (const [move, current] of trackedSide) {
      if (samePath(current, move.from)) continue;
      try {
        if (exists(current)) await moveFile(current, move.from);
      } catch (e) {
        rollbackErrors.push(`${path.basename(move.from)}：${(e as Error).message}`);
      }
    }
    logger.error(
      { err: (err as Error).message, rollbackErrors },
      "改名失败，已尝试回滚到原状态",
    );
    throw err;
  }

  // 下载记录：file_path 与 save_name 一起改成新位置
  const rows = stmtListPaths.all();
  for (const item of effective) {
    const hit = rows.find((row) => row.file_path && samePath(row.file_path, item.from));
    if (!hit) continue;
    stmtUpdatePath.run(item.to, path.basename(item.to), hit.id);
    result.downloads += 1;
  }

  // 旧目录空了就收走（keep 目标目录本身）
  for (const dir of sourceDirs) {
    if (samePath(dir, plan.targetDir)) continue;
    result.emptyDirs += await removeEmptyDirs(dir, plan.targetDir);
  }

  // 让 Emby 重新识别这个剧集目录
  queueEmbyUpdate(plan.targetDir, "Modified");

  logger.info(
    {
      dir: plan.targetDir,
      title: plan.title,
      moved: result.moved,
      sidecars: result.sidecars,
      downloads: result.downloads,
    },
    "剧集改名完成",
  );

  return result;
}
