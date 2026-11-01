import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { stripLegacyIndex } from "./naming";

/**
 * 历史命名修复。
 *
 * 旧版给剧集文件加了一截序号：「美人局S01E04-04.mp4」；
 * 新规则只要「美人局S01E04.mp4」。命名逻辑本身已经改对，
 * 但 downloads.save_name 是入队时就写死的，重试不会重算，
 * 所以历史记录（以及磁盘上已经下好的文件）还得单独收拾一遍。
 */

/** 目标路径必须落在下载目录内，防止数据库里的脏数据把文件写到别处 */
function isInsideDownloadDir(target: string): boolean {
  const root = path.resolve(env.downloadDir);
  const full = path.resolve(target);
  return full === root || full.startsWith(root + path.sep);
}

interface LegacyRow {
  id: number;
  save_dir: string | null;
  save_name: string;
  file_path: string | null;
}

/**
 * 把历史下载记录里的旧命名纠正过来，并同步重命名磁盘上的文件。
 *
 * - 数据库：save_name 去掉 -NN 序号
 * - 磁盘：正片与配套的 .nfo 一起改名，避免重下时生成「(2)」副本或留下孤儿文件
 * - 已经下好的任务不受影响：文件名变了，file_path 同步跟着变
 *
 * 幂等：改完再跑一次不会重复改名。
 */
export function repairLegacySeriesNames(): number {
  const rows = db
    .prepare<[], LegacyRow>(
      "SELECT id, save_dir, save_name, file_path FROM downloads WHERE save_name IS NOT NULL",
    )
    .all();

  let fixed = 0;
  for (const row of rows) {
    const nextName = stripLegacyIndex(row.save_name);
    if (!nextName || nextName === row.save_name) continue;

    const dir = row.save_dir ? path.join(env.downloadDir, row.save_dir) : env.downloadDir;
    const oldPath = path.join(dir, row.save_name);
    const newPath = path.join(dir, nextName);
    if (!isInsideDownloadDir(oldPath) || !isInsideDownloadDir(newPath)) continue;

    let renamed = false;
    let filePath: string | null = row.file_path;
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      try {
        fs.renameSync(oldPath, newPath);
        renamed = true;
        // 配套的 .nfo 跟着改名（finalizeMedia 按视频基名写 .nfo）
        const oldStem = path.basename(row.save_name, path.extname(row.save_name));
        const newStem = path.basename(nextName, path.extname(nextName));
        const oldNfo = path.join(dir, `${oldStem}.nfo`);
        const newNfo = path.join(dir, `${newStem}.nfo`);
        if (oldStem !== newStem && fs.existsSync(oldNfo) && !fs.existsSync(newNfo)) {
          fs.renameSync(oldNfo, newNfo);
        }
        if (row.file_path && isInsideDownloadDir(row.file_path)) filePath = newPath;
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, file: row.save_name },
          "历史剧集文件改名失败，已跳过磁盘改名",
        );
      }
    }

    db.prepare("UPDATE downloads SET save_name = ?, file_path = ? WHERE id = ?").run(
      nextName,
      filePath,
      row.id,
    );
    fixed += 1;
    logger.info(
      { id: row.id, from: row.save_name, to: nextName, renamed },
      "已修正剧集文件名（去掉多余的序号）",
    );
  }
  return fixed;
}
