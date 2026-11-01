import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { buildEpisodeNfo, buildShowNfo, decodeMeta, encodeMeta, type EmbyMeta } from "./emby";
import { fixTelegramLink, repairNfoText } from "./entity";
import { deriveSeriesFromText, episodeTag, parseFileNameMarks, stripLegacyIndex } from "./naming";

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
  file_name: string | null;
  emby_json: string | null;
}

export interface RepairReport {
  /** 修正了文件名的记录数 */
  renamed: number;
  /** 修正了失效链接的记录数 */
  links: number;
  /** 修正了链接的 nfo 文件数 */
  nfos: number;
  /** 按剧集命名重命名的记录数 */
  series: number;
  /** 顺带改掉的文件夹数 */
  dirs: number;
  /** 补写/纠正的单集 nfo 数 */
  episodeNfos: number;
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
      "SELECT id, save_dir, save_name, file_path, file_name, emby_json FROM downloads WHERE save_name IS NOT NULL",
    )
    .all();

  const report: RepairReport = { renamed: 0, links: 0, nfos: 0, series: 0, dirs: 0, episodeNfos: 0 };
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

  // 兜底命名（一个链接一个文件夹 + 序号）改成剧集命名：
  // 「妈妈我爱你 EP1-10-01.mp4」→「妈妈我爱你S01E01.mp4」，文件夹也跟着改成剧名。
  const series = repairSeriesNaming();
  report.series = series.renamed;
  report.dirs = series.dirs;
  // 单集 nfo 与剧名/集数对不上时补齐（改名后、或下载完成时写的是旧剧名）
  report.episodeNfos = repairEpisodeNfo();
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

/** 已经是剧集命名的（剧名S01E04.mp4）不用再动 */
const HAS_EPISODE_TAG_RE = /S\d{2}E\d{2}/;

interface SeriesPlanItem {
  id: number;
  currentName: string;
  nextDir: string;
  nextName: string;
  season: number;
  episode: number;
  meta: EmbyMeta | null;
  filePath: string | null;
}

export interface SeriesMigration {
  /** 改名的记录数 */
  renamed: number;
  /** 改掉的文件夹数 */
  dirs: number;
}

/**
 * 把「兜底命名」的历史文件改成剧集命名。
 *
 * 旧规则：正文里认不出剧名就一个链接一个文件夹，文件叫「妈妈我爱你 EP1-10-01.mp4」。
 * 新规则：正文或原始文件名里能认出剧名与集数，文件叫「妈妈我爱你S01E01.mp4」，
 * 文件夹也跟着改成剧名，封面与剧集信息一起搬过去，nfo 里的集数重写。
 *
 * 幂等：改完再跑一次不会重复改名。
 */
function repairSeriesNaming(): SeriesMigration {
  const rows = db
    .prepare<[], LegacyRow>(
      "SELECT id, save_dir, save_name, file_path, file_name, emby_json FROM downloads WHERE save_dir IS NOT NULL AND save_name IS NOT NULL ORDER BY id",
    )
    .all();

  const result: SeriesMigration = { renamed: 0, dirs: 0 };
  /** 旧目录 → 该目录下的迁移计划 */
  const plans = new Map<string, SeriesPlanItem[]>();

  for (const row of rows) {
    const currentName = row.save_name;
    const currentDir = row.save_dir as string;
    // 已经是剧集命名的（剧名S01E04.mp4）不动
    if (HAS_EPISODE_TAG_RE.test(currentName)) continue;

    const meta = decodeMeta(row.emby_json);
    const marks = parseFileNameMarks(row.file_name ?? "");
    // 剧名优先从正文首行推（正文里写了「EP1-10」这类集数时最准），
    // 推不出来再看原始文件名
    const series = deriveSeriesFromText(meta?.firstLine ?? "") || marks.series || "";
    const episode = marks.episode ?? meta?.episode ?? null;
    if (!series || episode === null || episode <= 0) continue;

    const season = marks.season ?? meta?.season ?? 1;
    const ext = path.extname(currentName);
    const nextName = `${series}${episodeTag(season, episode, null)}${ext}`;
    if (nextName === currentName && currentDir === series) continue;

    const list = plans.get(currentDir) ?? [];
    list.push({
      id: row.id,
      currentName,
      nextDir: series,
      nextName,
      season,
      episode,
      meta,
      filePath: row.file_path,
    });
    plans.set(currentDir, list);
  }

  for (const [oldDir, items] of plans) {
    // 同一个旧目录里的文件必须都搬到同一个新目录，否则旧目录还得留着
    const targets = new Set(items.map((item) => item.nextDir));
    if (targets.size !== 1) continue;
    const nextDir = items[0].nextDir;
    const oldDirPath = path.join(env.downloadDir, oldDir);
    const newDirPath = path.join(env.downloadDir, nextDir);
    if (!isInsideDownloadDir(oldDirPath) || !isInsideDownloadDir(newDirPath)) continue;

    try {
      fs.mkdirSync(newDirPath, { recursive: true });
    } catch {
      /* ignore */
    }

    for (const item of items) {
      const oldPath = path.join(oldDirPath, item.currentName);
      const newPath = path.join(newDirPath, item.nextName);
      let filePath = item.filePath;

      if (fs.existsSync(oldPath) && !fs.existsSync(newPath) && isInsideDownloadDir(newPath)) {
        try {
          fs.renameSync(oldPath, newPath);
          filePath = newPath;
          // 配套的 .nfo 跟着改名（finalizeMedia 按视频基名写 .nfo）
          const oldNfo = nfoPathOf(oldDirPath, item.currentName);
          const newNfo = nfoPathOf(newDirPath, item.nextName);
          if (fs.existsSync(oldNfo) && oldNfo !== newNfo) {
            if (fs.existsSync(newNfo)) fs.unlinkSync(oldNfo);
            else fs.renameSync(oldNfo, newNfo);
          }
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, file: item.currentName },
            "历史剧集文件改名失败，已跳过磁盘改名",
          );
        }
      } else if (fs.existsSync(newPath)) {
        // 新名字已经有文件了（重复下载过），指过去即可，旧的先留着不动
        filePath = newPath;
      }

      // nfo 里的剧名与集数一起重写，Emby 才能按集数识别
      const nextMeta: EmbyMeta | null = item.meta
        ? { ...item.meta, series: item.nextDir, season: item.season, episode: item.episode }
        : null;
      if (nextMeta) {
        const nfoPath = nfoPathOf(newDirPath, item.nextName);
        if (fs.existsSync(nfoPath)) {
          try {
            fs.writeFileSync(nfoPath, buildEpisodeNfo(nextMeta), "utf8");
          } catch (err) {
            logger.warn({ err: (err as Error).message, nfo: path.basename(nfoPath) }, "重写剧集 nfo 失败");
          }
        }
        db.prepare("UPDATE downloads SET emby_json = ? WHERE id = ?").run(
          encodeMeta(nextMeta),
          item.id,
        );
      }

      db.prepare("UPDATE downloads SET save_dir = ?, save_name = ?, file_path = ? WHERE id = ?").run(
        item.nextDir,
        item.nextName,
        filePath,
        item.id,
      );
      result.renamed += 1;
      logger.info(
        { id: item.id, from: item.currentName, to: item.nextName },
        "已按剧集命名重命名历史文件",
      );
    }

    // 旧目录里剩下的封面与剧集信息一并搬过去
    moveFolderRemainder(oldDirPath, newDirPath);
    // 剧集信息里的剧名要跟着改
    const showMeta = items.find((item) => item.meta)?.meta;
    const showPath = path.join(newDirPath, "tvshow.nfo");
    if (showMeta && fs.existsSync(showPath)) {
      try {
        fs.writeFileSync(showPath, buildShowNfo({ ...showMeta, series: nextDir }), "utf8");
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "重写剧集信息失败");
      }
    }
    // 旧目录搬空了才删掉
    try {
      if (fs.readdirSync(oldDirPath).length === 0) {
        fs.rmdirSync(oldDirPath);
        result.dirs += 1;
        logger.info({ from: oldDir, to: nextDir }, "已重命名剧集文件夹");
      }
    } catch {
      /* ignore */
    }
  }

  return result;
}

/** 把旧目录里剩下的文件（封面、剧集信息等）搬到新目录 */
function moveFolderRemainder(oldDirPath: string, newDirPath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(oldDirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const from = path.join(oldDirPath, entry.name);
    const to = path.join(newDirPath, entry.name);
    if (!isInsideDownloadDir(to) || fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 单集 nfo 自愈：与数据库里的剧名/集数对不上时补写一份。
 *
 * 两种情况会不一致：
 * 1. 文件改过名（兜底命名 → 剧集命名），nfo 还是旧的；
 * 2. 下载完成那一刻用的是旧剧名写 nfo，之后剧名又变了。
 *
 * 判断依据用 nfo 里的 uniqueid（工具自己写的），这样用户在页面上手改的
 * 标题、简介不会被覆盖。
 */
function repairEpisodeNfo(): number {
  const rows = db
    .prepare<[], LegacyRow>(
      "SELECT id, save_dir, save_name, file_path, file_name, emby_json FROM downloads WHERE save_dir IS NOT NULL AND save_name IS NOT NULL AND media_kind IN ('video','gif')",
    )
    .all();

  let fixed = 0;
  for (const row of rows) {
    const meta = decodeMeta(row.emby_json);
    if (!meta) continue;
    const dir = path.join(env.downloadDir, row.save_dir as string);
    const videoPath = path.join(dir, row.save_name);
    const nfoPath = nfoPathOf(dir, row.save_name);
    if (!isInsideDownloadDir(nfoPath) || !isInsideDownloadDir(videoPath)) continue;
    // 视频还没下完就先不动，等下次启动再补
    if (!fs.existsSync(videoPath)) continue;

    const expected = buildEpisodeNfo(meta);
    if (fs.existsSync(nfoPath)) {
      let text = "";
      try {
        text = fs.readFileSync(nfoPath, "utf8");
      } catch {
        continue;
      }
      if (text === expected) continue;
      // uniqueid 里带剧名，对不上说明这份 nfo 写的是旧剧名
      if (text.includes(`tgsub:${meta.series}:`)) continue;
      try {
        fs.writeFileSync(nfoPath, expected, "utf8");
        fixed += 1;
        logger.info({ id: row.id, nfo: path.basename(nfoPath) }, "已按新剧名重写单集 nfo");
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "重写单集 nfo 失败");
      }
      continue;
    }

    // nfo 丢了就补一份
    try {
      fs.writeFileSync(nfoPath, expected, "utf8");
      fixed += 1;
      logger.info({ id: row.id, nfo: path.basename(nfoPath) }, "已补写缺失的单集 nfo");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "补写单集 nfo 失败");
    }
  }
  return fixed;
}
