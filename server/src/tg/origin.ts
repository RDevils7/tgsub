import { DEFAULT_SOURCE_DIRS, DIR_KEYS, type DirKey } from "./mediadir";

/**
 * 媒体来源归档。
 *
 * 元数据页要按「Telegram / B站 / 小红书 / YouTube / 网页(m3u8) / 外部目录」
 * 分区显示，判断依据只有两处：
 *
 *   1. downloads.source —— telegram / platform / m3u8
 *   2. 文件相对下载根的第一段目录 —— B站 / 小红书 / youtube / m3u8
 *
 * 第 2 条不能写死目录名：用户在设置页可以改（`dir_bilibili` 等 5 个设置项），
 * 改了之后落盘路径跟着变，这里必须按设置值比对。
 *
 * 纯逻辑：不 import db / env，自检可以直接调。
 */

export type MediaOrigin =
  | "telegram"
  | "bilibili"
  | "xiaohongshu"
  | "youtube"
  | "m3u8"
  /** 手动登记的下载根之外的目录 */
  | "manual"
  /** 同一目录里混了多个来源 */
  | "mixed"
  /** 认不出来（老数据、目录被改过名） */
  | "other";

/** 分区展示顺序：跟设置页的下载目录顺序一致，外部目录排最后 */
export const ORIGIN_ORDER: readonly MediaOrigin[] = [
  "telegram",
  "bilibili",
  "xiaohongshu",
  "youtube",
  "m3u8",
  "manual",
  "mixed",
  "other",
] as const;

export const ORIGIN_LABEL: Record<MediaOrigin, string> = {
  telegram: "Telegram",
  bilibili: "B站",
  xiaohongshu: "小红书",
  youtube: "YouTube",
  m3u8: "网页 / m3u8",
  manual: "外部目录",
  mixed: "混合来源",
  other: "其它",
};

/** 设置项 → 它代表哪个来源 */
const ORIGIN_OF_DIR: Record<DirKey, MediaOrigin> = {
  dir_telegram: "telegram",
  dir_bilibili: "bilibili",
  dir_xiaohongshu: "xiaohongshu",
  dir_youtube: "youtube",
  dir_m3u8: "m3u8",
};

export type DirMap = Record<DirKey, string>;

/** 把设置对象整理成「设置项 → 目录名」，空值回落到默认目录 */
export function dirMapOf(raw: Record<string, unknown> | null | undefined): DirMap {
  const out = {} as DirMap;
  for (const key of DIR_KEYS) {
    const value = String(raw?.[key] ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    out[key] = value || DEFAULT_SOURCE_DIRS[key];
  }
  return out;
}

/** 相对下载根的路径 → 来源（只看第一段） */
export function originOfRelPath(rel: string | null | undefined, dirs: DirMap): MediaOrigin | null {
  const segments = String(rel ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (segments.length === 0) return null;
  const head = segments[0];
  for (const key of DIR_KEYS) {
    if (dirs[key] === head) return ORIGIN_OF_DIR[key];
  }
  return null;
}

/**
 * 判定一条媒体属于哪个来源。
 *
 * source 是 downloads.source 的值（手动登记的条目没有下载记录，传 null）。
 * relPath 是相对下载根的路径；在下载根之外时传 null。
 */
export function originOf(
  source: string | null | undefined,
  relPath: string | null | undefined,
  dirs: DirMap,
): MediaOrigin {
  const byPath = originOfRelPath(relPath, dirs);
  switch (String(source ?? "").toLowerCase()) {
    case "telegram":
      return "telegram";
    case "m3u8":
      return "m3u8";
    case "platform":
      // 第三方平台靠目录区分（B站 / 小红书 / YouTube），认不出就归到「其它」
      return byPath && byPath !== "telegram" ? byPath : "other";
    default:
      // 手动登记的：如果它就在下载根下（比如把 downloads/B站 整个登记成来源），
      // 仍然按物理位置归到对应平台，只有真正在外部路径的才算「外部目录」
      return byPath ?? "manual";
  }
}

/** 多个来源合成一个：只有一个就取它，多个就是 mixed */
export function mergeOrigins(origins: MediaOrigin[]): MediaOrigin {
  const unique = [...new Set(origins)];
  if (unique.length === 0) return "other";
  if (unique.length === 1) return unique[0];
  return "mixed";
}

/** 来源在界面上的排序权重 */
export function originRank(origin: MediaOrigin): number {
  const index = ORIGIN_ORDER.indexOf(origin);
  return index === -1 ? ORIGIN_ORDER.length : index;
}
