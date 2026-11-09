import fs from "node:fs";
import path from "node:path";
import { mapLimit } from "../lib/async";
import { logger } from "../logger";
import { buildEpisodeNfo, type EmbyMeta } from "./emby";
import { isStrmFile, strmNfoPath } from "./mediapath";
import { deriveEpisodeInfo } from "./mediatree";

/**
 * 给 .strm 补单集 NFO。
 *
 * 这是**纯本地写盘**：只读 strm 的文件名和 mtime，从不解析文件里那一行 URL，
 * 更不会发起任何网络请求。所以一次批量补几千个 NFO 也不会碰到网盘风控。
 *
 * 两条硬约束：
 * 1. 只写不存在的 NFO —— 用户手工编辑过的、Emby 自己写的、之前生成过的都不覆盖。
 * 2. 不认 .nfo 之外的副产物，也不碰真实视频；`VIDEO_EXT_RE` 一个字都不改。
 */

/** 递归上限：比媒体库展示用的 3 层更宽，选了上级目录也能补到底 */
const MAX_STRM_DEPTH = 6;
/** 一次最多处理多少个 strm，避免误把整块磁盘挂进媒体库 */
const MAX_STRM_FILES = 5000;
/** NFO 只有几百字节，6 路并发足够，别把 NAS 的磁盘打满 */
const NFO_CONCURRENCY = 6;

/**
 * 单集 NFO 的内容（纯函数，播放自动截封面与批量补齐共用一套）。
 *
 * 剧名 / 季 / 集全部从文件名推，不读 strm 正文 —— 正文里是带签名的临时直链，
 * 既不该写进 NFO，也不该因为解析它产生任何请求。
 */
export function buildStrmNfoText(file: string, mtimeMs = Date.now()): string {
  const info = deriveEpisodeInfo(path.basename(file), path.basename(path.dirname(file)));
  const meta: EmbyMeta = {
    series: info.series,
    season: info.season ?? 1,
    episode: info.episode,
    firstLine: "",
    plot: "",
    tags: [],
    studio: null,
    link: null,
    airedAt: Math.round(mtimeMs) || Date.now(),
    messageId: 0,
    kind: "video",
  };
  return buildEpisodeNfo(meta);
}

export type EnsureOneResult = "created" | "existing" | "failed";

/**
 * 给单个 strm 补 NFO。
 *
 * `flag: "wx"` 是排他创建：并发时另一个请求先写好会拿到 EEXIST，
 * 直接算「已有」，不会覆盖。路径合法性由调用方（路由）统一过 isAllowedPath。
 */
export async function ensureStrmNfo(file: string): Promise<EnsureOneResult> {
  const abs = path.resolve(file);
  if (!isStrmFile(abs)) return "failed";
  const nfo = strmNfoPath(abs);
  if (fs.existsSync(nfo)) return "existing";

  let mtime = Date.now();
  try {
    mtime = fs.statSync(abs).mtimeMs || mtime;
  } catch {
    return "failed";
  }

  try {
    await fs.promises.writeFile(nfo, buildStrmNfoText(abs, mtime), { flag: "wx", encoding: "utf8" });
    return "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "existing";
    // 媒体目录只读时很常见（NAS 上挂载权限不对）：不能让整个请求失败，留痕即可
    logger.warn({ file: abs, err: (err as Error).message }, "strm 单集 NFO 写入失败");
    return "failed";
  }
}

/** 递归收集目录下的 .strm：跳过隐藏目录，不跟随符号链接 */
export function collectStrmFiles(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > MAX_STRM_DEPTH || acc.length >= MAX_STRM_FILES) return acc;
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
      collectStrmFiles(full, depth + 1, acc);
      continue;
    }
    if (entry.isFile() && isStrmFile(entry.name)) acc.push(full);
    if (acc.length >= MAX_STRM_FILES) break;
  }
  return acc;
}

export interface StrmNfoSummary {
  /** 扫到的 strm 总数 */
  scanned: number;
  /** 本次新建的 NFO */
  created: number;
  /** 本来就有 NFO（含并发时别人先写好的） */
  existing: number;
  /** 写失败（多数是目录不可写） */
  failed: number;
  /** 撞到 5000 上限，还有没扫到的 */
  truncated: boolean;
}

/** 同一目录的并发调用合并成一次，界面重复触发也不会重复写盘 */
const running = new Map<string, Promise<StrmNfoSummary>>();

export function ensureStrmNfos(dir: string): Promise<StrmNfoSummary> {
  const root = path.resolve(dir);
  const busy = running.get(root);
  if (busy) return busy;

  const task = (async (): Promise<StrmNfoSummary> => {
    const files = collectStrmFiles(root);
    const results = await mapLimit(files, NFO_CONCURRENCY, (file) => ensureStrmNfo(file));
    const summary: StrmNfoSummary = {
      scanned: files.length,
      created: results.filter((r) => r === "created").length,
      existing: results.filter((r) => r === "existing").length,
      failed: results.filter((r) => r === "failed").length,
      truncated: files.length >= MAX_STRM_FILES,
    };
    if (summary.created > 0 || summary.failed > 0) {
      logger.info({ dir: root, ...summary }, "strm 单集 NFO 批量补齐");
    }
    return summary;
  })();

  running.set(root, task);
  // catch 先消化拒绝，finally 就不会变成未处理的 rejection
  void task.catch(() => undefined).finally(() => running.delete(root));
  return task;
}
