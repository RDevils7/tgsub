import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { logger } from "../logger";
import { addSource } from "./mediatree";
import { replacePrefix, type TransferAction, type TransferPlanItem } from "./transferplan";

/**
 * 移动 / 复制的执行层。
 *
 * 磁盘操作之外，还要把数据库里指向旧位置的路径一起搬走：
 *  - downloads.file_path    下载记录（元数据页的文件夹主要靠它）
 *  - media_sources.path     手动登记的来源
 *  - media_excluded.path    「仅从列表移除」的隐藏登记
 *
 * 漏掉任何一张表，移动完的剧集就会从列表里消失（或者反过来，旧位置留下一堆幽灵）。
 */

export interface TransferResult {
  from: string;
  to: string;
  ok: boolean;
  error?: string;
  /** 同步过来的下载记录数 */
  downloads: number;
  /** 同步过来的来源登记数 */
  sources: number;
}

const stmtDownloadPaths = db.prepare<[], { id: number; file_path: string | null }>(
  "SELECT id, file_path FROM downloads WHERE file_path IS NOT NULL",
);
const stmtSetDownloadPath = db.prepare<[string, number]>("UPDATE downloads SET file_path = ? WHERE id = ?");
const stmtSourceRows = db.prepare<[], { id: number; path: string }>("SELECT id, path FROM media_sources");
const stmtSetSourcePath = db.prepare<[string, number]>("UPDATE media_sources SET path = ? WHERE id = ?");
const stmtExcludedRows = db.prepare<[], { path: string }>("SELECT path FROM media_excluded");
const stmtInsertExcluded = db.prepare<[string, number]>(
  "INSERT INTO media_excluded (path, created_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING",
);
const stmtDeleteExcluded = db.prepare<[string]>("DELETE FROM media_excluded WHERE path = ?");

/** 把数据库里所有以 from 开头的路径换成 to */
function syncPaths(from: string, to: string): { downloads: number; sources: number } {
  let downloads = 0;
  let sources = 0;

  for (const row of stmtDownloadPaths.all()) {
    if (!row.file_path) continue;
    const next = replacePrefix(row.file_path, from, to);
    if (!next) continue;
    stmtSetDownloadPath.run(next, row.id);
    downloads += 1;
  }

  for (const row of stmtSourceRows.all()) {
    const next = replacePrefix(row.path, from, to);
    if (!next) continue;
    // 目标路径可能已经被另一条来源登记过（唯一索引），撞了就先删旧的
    try {
      stmtSetSourcePath.run(next, row.id);
    } catch {
      continue;
    }
    sources += 1;
  }

  for (const row of stmtExcludedRows.all()) {
    const next = replacePrefix(row.path, from, to);
    if (!next) continue;
    stmtInsertExcluded.run(next, Date.now());
    stmtDeleteExcluded.run(row.path);
  }

  return { downloads, sources };
}

/** 跨盘移动：复制完再删源 */
async function moveAcrossDevices(from: string, to: string): Promise<void> {
  await fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  await fs.promises.rm(from, { recursive: true, force: true });
}

export async function executeTransfer(item: TransferPlanItem, action: TransferAction): Promise<TransferResult> {
  const { from, to } = item;
  try {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });

    if (action === "copy") {
      await fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    } else {
      try {
        await fs.promises.rename(from, to);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // 跨盘（EXDEV）或被占用时 rename 会失败，退回「复制 + 删源」
        if (code === "EXDEV" || code === "EPERM" || code === "EACCES") {
          await moveAcrossDevices(from, to);
        } else {
          throw err;
        }
      }
    }

    let stats = { downloads: 0, sources: 0 };
    if (action === "move") {
      stats = syncPaths(from, to);
    } else {
      // 复制出来的副本没有下载记录，登记一条来源它才会出现在元数据页
      addSource(to, item.kind === "folder" ? "dir" : "file", item.name);
    }

    logger.info({ from, to, action, ...stats }, "已搬运媒体条目");
    return { from, to, ok: true, ...stats };
  } catch (err) {
    logger.warn({ from, to, action, err }, "搬运媒体条目失败");
    return { from, to, ok: false, error: (err as Error).message, downloads: 0, sources: 0 };
  }
}
