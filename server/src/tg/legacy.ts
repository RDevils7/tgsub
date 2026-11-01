import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { decodeMeta, encodeMeta } from "./emby";
import { fixTelegramLink, repairNfoText } from "./entity";
import { stripLegacyIndex } from "./naming";

/**
 * 历史数据修复。
 *
 * 两件事，都是同一个根因带来的：
 *
 * 1. 旧版给剧集文件加了一截序号（「美人局S01E04-04.mp4」）。命名逻辑本身已经改对，
 *    但 downloads.save_name 是入队时就写死的，重试不会重算，
 *    所以历史记录（以及磁盘上已经下好的文件）还得单独收拾一遍。
 *
 * 2. 旧版给私有频道生成的消息链接是 t.me/<裸号>/<消息ID>，那个地址根本打不开，
 *    被写进了 nfo 的 uniqueid。
 */

/** 目标路径必须落在下载目录内，防止数据库里的脏数据把文件写到别处 */
function isInsideDownloadDir(target: string): boolean {
  const root = path.resolve(env.downloadDir);
  const full = path.resolve(target);
  return full === root || full.startsWith(root + path.sep);
}

/** 同一目录下与媒体文件配套的 nfo 路径 */
function nfoPathOf(dir: string, fileName: string): string {
  return path.join(dir, `${path.basename(fileName, path.extname(fileName))}.nfo`);
}

interface LegacyRow {
  id: number;
  save_dir: string | null;
  save_name: string;
  file_path: string | null;
  emby_json: string | null;
}

export interface RepairReport {
  /** 修正了文件名的记录数 */
  renamed: number;
  /** 修正了失效链接的记录数 */
  links: number;
  /** 修正了链接的 nfo 文件数 */
  nfos: number;
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
export function repairLegacyArtifacts(): RepairReport {
  const rows = db
    .prepare<[], LegacyRow>(
      "SELECT id, save_dir, save_name, file_path, emby_json FROM downloads WHERE save_name IS NOT NULL",
    )
    .all();

  const report: RepairReport = { renamed: 0, links: 0, nfos: 0 };
  for (const row of rows) {
    const dir = row.save_dir ? path.join(env.downloadDir, row.save_dir) : env.downloadDir;
    const nextName = stripLegacyIndex(row.save_name);

    let filePath: string | null = row.file_path;
    if (nextName && nextName !== row.save_name) {
      const oldPath = path.join(dir, row.save_name);
      const newPath = path.join(dir, nextName);
      if (isInsideDownloadDir(oldPath) && isInsideDownloadDir(newPath)) {
        let renamed = false;
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
          try {
            fs.renameSync(oldPath, newPath);
            renamed = true;
            // 配套的 .nfo 跟着改名（finalizeMedia 按视频基名写 .nfo）
            const oldNfo = nfoPathOf(dir, row.save_name);
            const newNfo = nfoPathOf(dir, nextName);
            if (oldNfo !== newNfo && fs.existsSync(oldNfo) && !fs.existsSync(newNfo)) {
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
        report.renamed += 1;
        logger.info(
          { id: row.id, from: row.save_name, to: nextName, renamed },
          "已修正剧集文件名（去掉多余的序号）",
        );
      }
    }

    // 私有频道的旧链接（t.me/<裸号>/<消息ID>）打不开，一并纠正
    const meta = decodeMeta(row.emby_json);
    if (!meta || !meta.link) continue;
    const fixedLink = fixTelegramLink(meta.link);
    if (!fixedLink || fixedLink === meta.link) continue;
    db.prepare("UPDATE downloads SET emby_json = ? WHERE id = ?").run(
      encodeMeta({ ...meta, link: fixedLink }),
      row.id,
    );
    report.links += 1;
    logger.info({ id: row.id, from: meta.link, to: fixedLink }, "已修正剧集消息链接");
  }

  // nfo 里的链接单独扫一遍目录：
  // 1. tvshow.nfo 只在剧集首次落盘时生成，旧的会一直留在那里；
  // 2. 任务入队时缓存的 emby_json 可能是修复前的快照。
  // 所以按文本模式扫全目录，不依赖数据库里的旧值。
  report.nfos = repairNfoLinks();
  return report;
}

/** 递归扫描下载目录，把 nfo 里失效的私有频道链接就地替换 */
function repairNfoLinks(): number {
  let fixed = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".nfo")) continue;
      if (!isInsideDownloadDir(full)) continue;
      try {
        const text = fs.readFileSync(full, "utf8");
        const next = repairNfoText(text);
        if (next === text) continue;
        fs.writeFileSync(full, next, "utf8");
        fixed += 1;
        logger.info({ nfo: path.basename(full) }, "已修正 nfo 里的消息链接");
      } catch (err) {
        logger.warn({ err: (err as Error).message, nfo: path.basename(full) }, "修正 nfo 里的消息链接失败");
      }
    }
  };
  walk(path.resolve(env.downloadDir));
  return fixed;
}
