/**
 * 元数据页的排列方式。
 *
 * 纯逻辑，不 import db / env —— 自检脚本直接调，不用起数据库。
 *
 * 两个层级各有一套排序：
 *  - 剧集目录：名称 / 最近更新 / 体积 / 集数
 *  - 目录里的视频：名称 / 最近更新 / 体积 / 集号
 * 取值非法时一律回落到默认（名称升序），前端传错参数不至于把列表排乱。
 */

export type MediaSortKey = "name" | "updated" | "size" | "episodes";
export type SortOrder = "asc" | "desc";

export const SORT_KEYS: MediaSortKey[] = ["name", "updated", "size", "episodes"];

export const SORT_LABEL: Record<MediaSortKey, string> = {
  name: "名称",
  updated: "最近更新",
  size: "体积",
  episodes: "集数",
};

export function normalizeSortKey(value: unknown, fallback: MediaSortKey = "name"): MediaSortKey {
  const key = String(value ?? "").trim() as MediaSortKey;
  return SORT_KEYS.includes(key) ? key : fallback;
}

export function normalizeSortOrder(value: unknown, fallback: SortOrder = "asc"): SortOrder {
  const order = String(value ?? "").trim();
  return order === "desc" || order === "asc" ? order : fallback;
}

/** 中文里「第2集」要排在「第10集」前面，不能用字符串比较 */
function natural(a: string, b: string): number {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
}

export interface SortableFolder {
  name: string;
  fileCount: number;
  totalSize: number;
  updatedAt: number;
}

export interface SortableFile {
  name: string;
  size: number;
  episode: number | null;
  updatedAt: number;
}

function folderValue(folder: SortableFolder, key: MediaSortKey): number {
  switch (key) {
    case "updated":
      return folder.updatedAt;
    case "size":
      return folder.totalSize;
    case "episodes":
      return folder.fileCount;
    default:
      return 0;
  }
}

/**
 * 排剧集目录。
 *
 * 次级键固定用名称升序（降序时也不反转）—— 同一天下的、体积一样的几条仍然按名字排开，
 * 否则每次刷新顺序都会跳。
 */
export function sortFolders<T extends SortableFolder>(
  list: readonly T[],
  key: MediaSortKey = "name",
  order: SortOrder = "asc",
): T[] {
  const arr = [...list];
  const sign = order === "desc" ? -1 : 1;
  arr.sort((a, b) => {
    if (key === "name") return sign * natural(a.name, b.name);
    const diff = folderValue(a, key) - folderValue(b, key);
    if (diff !== 0) return sign * diff;
    return natural(a.name, b.name);
  });
  return arr;
}

/**
 * 排目录里的视频。
 *
 * 按「集号」排时，认不出集号的（没有 E01 这类信息的）永远垫底，
 * 不管升序还是降序 —— 它们不属于这一维度，混在中间反而碍事。
 */
export function sortFiles<T extends SortableFile>(
  files: readonly T[],
  key: MediaSortKey = "name",
  order: SortOrder = "asc",
): T[] {
  const arr = [...files];
  const sign = order === "desc" ? -1 : 1;
  arr.sort((a, b) => {
    if (key === "episodes") {
      if (a.episode === null || b.episode === null) {
        if (a.episode === b.episode) return natural(a.name, b.name);
        return a.episode === null ? 1 : -1;
      }
      const diff = a.episode - b.episode;
      if (diff !== 0) return sign * diff;
      return natural(a.name, b.name);
    }
    if (key === "name") return sign * natural(a.name, b.name);
    const diff = key === "size" ? a.size - b.size : a.updatedAt - b.updatedAt;
    if (diff !== 0) return sign * diff;
    return natural(a.name, b.name);
  });
  return arr;
}
