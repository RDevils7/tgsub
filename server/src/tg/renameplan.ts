import path from "node:path";
import { sanitizeSegment } from "../utils";

/**
 * 改名 / 合并剧集的**纯逻辑**：排序、生成新文件名、规划两阶段重命名。
 *
 * 这个模块不碰磁盘也不碰数据库（只做路径字符串运算），
 * 所以能在自检里直接跑 —— 排序与编号是这组功能最容易出错的地方。
 *
 * 命名沿用项目既有约定：`<剧名>/<剧名>S01E04.mp4`，
 * 单集副产物是同名的 `.nfo` 与 `-thumb.jpg`（由执行层按同一套规则推导）。
 */

export interface EpisodeSource {
  /** 绝对路径 */
  path: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 解析出的集号，解析不出来为 null */
  episode: number | null;
  /** 解析出的季号，解析不出来为 null */
  season: number | null;
}

export interface PlannedRename {
  from: string;
  to: string;
  /**
   * 两阶段重命名的中转名。
   *
   * 直接一 rename 到底会撞车：把 `A.mp4` 排到第 1 位、`B.mp4` 排到第 2 位时，
   * 如果 B 的新名字恰好等于 A 的旧名字，第二刀就没法落。
   * 统一先全部挪到临时名、再落最终名，才能保证「顺序绝对不乱」。
   */
  tmp: string;
  /** 改名前解析到的集号 */
  oldEpisode: number | null;
  /** 改名后的集号 */
  newEpisode: number;
}

export interface RenamePlan {
  /** 清洗过的剧名（已去掉文件系统不允许的字符） */
  title: string;
  season: number;
  targetDir: string;
  items: PlannedRename[];
  /** 需要提醒用户的问题（集号重复、季号不一致等），不阻止执行 */
  warnings: string[];
  /** 目标位置已有同名文件，且那个文件不在本次要移动的清单里 */
  conflicts: string[];
}

/** 目标目录里已有文件名的集合（只用于冲突判断，不含目录） */
export type ExistingNames = Iterable<string>;

const DIGITS = /^(\d+)$/;

/**
 * 自然排序：把数字段按数值比，而不是按字符比。
 *
 * `第2集` 要排在 `第10集` 前面 —— 纯字符串比较会得到相反的结果。
 */
export function naturalCompare(a: string, b: string): number {
  const pa = String(a).match(/(\d+)|(\D+)/g) ?? [];
  const pb = String(b).match(/(\d+)|(\D+)/g) ?? [];
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i];
    const y = pb[i];
    const mx = DIGITS.exec(x);
    const my = DIGITS.exec(y);
    if (mx && my) {
      const d = Number(mx[1]) - Number(my[1]);
      if (d !== 0) return d;
      continue;
    }
    const c = x.localeCompare(y, "zh-CN");
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}

/**
 * 决定合并/改名后每集的先后顺序。
 *
 * 规则（依次比较）：
 *   1. 解析出集号的排在「没解析出来」的前面 —— 有编号的总是更可信
 *   2. 集号小的在前
 *   3. 集号相同（重复）时按文件名自然序 —— 保持可预期
 *   4. 最后用完整路径兜底，保证同一批输入永远得到同一结果（稳定排序）
 */
export function sortEpisodeSources<T extends EpisodeSource>(sources: readonly T[]): T[] {
  return [...sources].sort((a, b) => {
    const ea = a.episode;
    const eb = b.episode;
    if (ea !== null && eb === null) return -1;
    if (ea === null && eb !== null) return 1;
    if (ea !== null && eb !== null && ea !== eb) return ea - eb;
    const c = naturalCompare(a.name, b.name);
    if (c !== 0) return c;
    return a.path.localeCompare(b.path);
  });
}

const pad2 = (n: number): string => String(Math.max(0, Math.floor(n))).padStart(2, "0");

/** 单集的新文件名：`剧名S01E04.mp4`（扩展名保持原样） */
export function episodeFileName(title: string, season: number, episode: number, ext: string): string {
  const safe = sanitizeSegment(title, 120) || "未命名";
  const suffix = ext.startsWith(".") ? ext : ext ? `.${ext}` : "";
  return `${safe}S${pad2(season)}E${pad2(episode)}${suffix}`;
}

/** 剧集目录名 */
export function seriesDirName(title: string): string {
  return sanitizeSegment(title, 120) || "未命名";
}

/**
 * 保存元数据时，「目录名」该不该跟着新剧名一起改。
 *
 * 只有当目录名本来就等于**旧剧名**时才允许动它。否则那个目录很可能是
 * 平台目录（`telegram` / `B站`）或用户自己的大目录（`D:\影片`），
 * 跟着剧名改一次就会把上层结构全搬走 —— 这种情况只改文件名、不动目录。
 */
export function canRenameDir(dirName: string, oldTitle: string): boolean {
  const title = sanitizeSegment(oldTitle ?? "", 120);
  if (!title) return false;
  // Windows 上大小写不敏感，比较前统一小写
  return seriesDirName(dirName).toLowerCase() === title.toLowerCase();
}

export interface BuildPlanInput {
  sources: readonly EpisodeSource[];
  /** 用户填的剧名（会被清洗成合法目录名 / 文件名） */
  title: string;
  /** 目标目录（绝对路径）。合并时是新目录，改名时是原目录 */
  targetDir: string;
  /** 目标目录里已存在的文件名，用来查冲突 */
  existingNames?: ExistingNames;
  /** 临时名前缀，测试里可覆盖 */
  tmpPrefix?: string;
  /**
   * 用户在确认面板里排好的顺序（绝对路径列表）。
   *
   * 给了就完全按这个顺序编号，不再按集号 / 文件名自动排 ——
   * 用户在界面上「确认好顺序」之后，落盘必须与看到的一致。
   * 列表没覆盖到的源文件保持原自然序排在后面（兜底，不会丢文件）。
   */
  order?: readonly string[];
}

/** 把路径规整成排序用的比较键（Windows 大小写不敏感） */
function orderKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * 按用户确认的顺序重排源文件。
 *
 * `order` 里没出现的文件不会丢，按原顺序垫在末尾；同一位置重复出现的以第一次为准。
 * 返回值是新数组，不改入参。
 */
export function applyOrder<T extends EpisodeSource>(
  sources: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order || order.length === 0) return [...sources];
  const index = new Map<string, number>();
  order.forEach((p, i) => {
    const key = orderKey(p);
    if (!index.has(key)) index.set(key, i);
  });
  return [...sources].sort((a, b) => {
    const ia = index.get(orderKey(a.path));
    const ib = index.get(orderKey(b.path));
    if (ia === undefined && ib === undefined) return 0;
    if (ia === undefined) return 1;
    if (ib === undefined) return -1;
    return ia - ib;
  });
}

/**
 * 生成重命名计划。
 *
 * 集号**一律重排成连续的 E01…EN**：顺序按原集号（或文件名自然序）确定，
 * 编号本身连续。这样零散来源拼成一部剧之后，Emby 里不会出现跳集。
 */
export function buildRenamePlan(input: BuildPlanInput): RenamePlan {
  const title = sanitizeSegment(input.title, 120) || "未命名";
  const targetDir = path.resolve(input.targetDir);
  // 用户确认过顺序就照它排；否则按集号 / 文件名自然序
  const sorted = applyOrder(sortEpisodeSources(input.sources), input.order);

  const warnings: string[] = [];
  const seasons = [...new Set(sorted.map((s) => s.season ?? 1))];
  // 多季混在同一批里：编号会串，提醒一句（仍按第一季输出）
  const season = seasons[0] ?? 1;
  if (seasons.length > 1) {
    warnings.push(`这批文件里混了多个季号（${seasons.join(" / ")}），统一按第 ${season} 季编号`);
  }

  const noEp = sorted.filter((s) => s.episode === null).length;
  const unmatched = sorted.filter((s) => s.episode === null && s.season === null).length;
  if (unmatched > 0) {
    warnings.push(`${unmatched} 个文件名里没有集号，已按文件名顺序排到后面`);
  }

  // 集号重复：顺序仍按文件名自然序，但值得提醒
  const epCount = new Map<number, number>();
  for (const s of sorted) {
    if (s.episode === null) continue;
    epCount.set(s.episode, (epCount.get(s.episode) ?? 0) + 1);
  }
  const dupes = [...epCount.entries()].filter(([, c]) => c > 1).map(([ep]) => ep);
  if (dupes.length > 0) {
    warnings.push(`集号重复：${dupes.map((e) => `E${pad2(e)}`).join("、")}，已按文件名顺序依次排开`);
  }
  if (noEp > 0 && warnings.length === 0) {
    // 理论上被上面的 unmatched 覆盖，兜底一句
    warnings.push(`${noEp} 个文件没有集号，按文件名顺序排列`);
  }

  const existing = new Set(input.existingNames ?? []);
  const sourcePaths = new Set(sorted.map((s) => path.resolve(s.path)));
  const prefix = input.tmpPrefix ?? ".tgsub-rn";
  const conflicts: string[] = [];

  const items: PlannedRename[] = sorted.map((s, idx) => {
    const newEpisode = idx + 1;
    const ext = path.extname(s.name);
    const to = path.join(targetDir, episodeFileName(title, season, newEpisode, ext));
    const tmp = path.join(path.dirname(path.resolve(s.path)), `${prefix}-${idx + 1}${ext}`);
    // 目标已存在、且那个文件不是本次要挪走的 → 真冲突
    const base = path.basename(to);
    if (existing.has(base) && !sourcePaths.has(path.resolve(to))) {
      conflicts.push(base);
    }
    return {
      from: path.resolve(s.path),
      to,
      tmp,
      oldEpisode: s.episode,
      newEpisode,
    };
  });

  return { title, season, targetDir, items, warnings, conflicts };
}

/**
 * 两个路径是否指向同一个文件位置。
 *
 * Windows 上路径大小写不敏感，比较前统一小写；
 * 其他地方保持原样（大小写敏感的文件系统上 `A.mp4` 和 `a.mp4` 是两个文件）。
 */
export function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 计划里有多少条是「真的需要动」的（原地已叫对的不算） */
export function countEffective(plan: RenamePlan): number {
  return plan.items.filter((item) => !samePath(item.from, item.to)).length;
}
