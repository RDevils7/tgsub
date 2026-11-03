/**
 * 下载目录：每个来源在下载根下各占一个可配置的子目录。
 *
 * 默认结构（都相对于 DOWNLOAD_DIR）：
 *
 *   <下载根>/telegram/<剧名>/剧名S01E04.mp4
 *   <下载根>/B站/<UP主>/<标题 [id]>/
 *   <下载根>/小红书/<博主>/<标题 [id]>/
 *   <下载根>/youtube/<频道>/<标题 [id]>/
 *   <下载根>/m3u8/<标题>/
 *
 * 为什么单独抽一层：目录名要能被用户改（换名字、加一层「影视」、改成英文），
 * 而落盘路径散在 telegram 入队、m3u8 入队、第三方入队三处 —— 各自拼字符串早晚会不一致。
 *
 * 纯逻辑：不 import db / env，自检可以直接调。
 */

export type DirKey = "dir_telegram" | "dir_bilibili" | "dir_xiaohongshu" | "dir_youtube" | "dir_m3u8";

/** 设置页的展示顺序：与下载列表里的来源顺序一致 */
export const DIR_KEYS: readonly DirKey[] = [
  "dir_telegram",
  "dir_bilibili",
  "dir_xiaohongshu",
  "dir_youtube",
  "dir_m3u8",
] as const;

export const DEFAULT_SOURCE_DIRS: Record<DirKey, string> = {
  dir_telegram: "telegram",
  dir_bilibili: "B站",
  dir_xiaohongshu: "小红书",
  dir_youtube: "youtube",
  dir_m3u8: "m3u8",
};

export const DIR_LABEL: Record<DirKey, string> = {
  dir_telegram: "Telegram",
  dir_bilibili: "B站",
  dir_xiaohongshu: "小红书",
  dir_youtube: "YouTube",
  dir_m3u8: "网页 / m3u8",
};

/** 第三方平台 id → 它自己的目录设置项 */
export function platformDirKey(platform: string): DirKey | null {
  switch (String(platform ?? "").toLowerCase()) {
    case "bilibili":
      return "dir_bilibili";
    case "xiaohongshu":
      return "dir_xiaohongshu";
    case "youtube":
      return "dir_youtube";
    default:
      return null;
  }
}

/**
 * 把路径拼成「相对下载根」的形式：过滤空段、统一用 `/`、去掉首尾斜杠。
 *
 * 不用 path.join：save_dir 在数据库里跨平台统一存 `/` 分隔的相对路径，
 * Windows 上 path.join 会写进 `\`，到 Linux 部署上就全成了文件名字符。
 */
export function joinRel(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** 按段清洗一个相对目录：非法字符逐段替换，避免 `/` 被当成非法字符整串糊掉 */
export function sanitizeRelDir(rel: string | null | undefined, max = 60): string {
  const raw = String(rel ?? "").replace(/\\/g, "/");
  const segments = raw
    .split("/")
    .map((seg) => seg.trim())
    .filter(Boolean);
  return segments.map((seg) => sanitizeSegment(seg, max)).join("/");
}

/** 与 utils.ts 的同名实现保持一致的轻量版本（这里不 import，避免把 env 拖进纯函数） */
function sanitizeSegment(input: string, max: number): string {
  const cleaned = String(input ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  const safe = cleaned || "untitled";
  return safe.length <= max ? safe : safe.slice(0, max);
}

export interface ParsedDir {
  /** 规范化后的相对目录；空字符串表示直接放在下载根下 */
  dir: string;
  /** 解析失败的原因；为 null 表示通过 */
  error: string | null;
}

/**
 * 解析用户填的目录。
 *
 * 只接受「下载根内的相对路径」：
 *   - `telegram`、`影视/B站` 这种相对路径直接用；
 *   - 粘了绝对路径但落在下载根内（如容器里的 `/downloads/B站`）会自动转成 `B站`；
 *   - 落在下载根外则拒绝 —— 元数据页、删除校验、Emby 路径映射都建立在「下载根之下」这个前提上，
 *     放出去一半功能会失灵。真要把内容放别的盘，改 DOWNLOAD_DIR，或在元数据页登记来源目录。
 */
export function parseDirSetting(raw: unknown, downloadRoot: string): ParsedDir {
  const text = String(raw ?? "").trim();
  if (!text) return { dir: "", error: null };

  let value = text.replace(/\\/g, "/");
  const root = String(downloadRoot ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  const isAbsolute = value.startsWith("/") || /^[a-zA-Z]:\//.test(value);
  if (isAbsolute) {
    if (root && (value === root || value.startsWith(`${root}/`))) {
      value = value.slice(root.length);
    } else {
      return {
        dir: "",
        error: `只能填下载目录内的相对路径（当前下载目录是 ${root || "未知"}）`,
      };
    }
  }

  if (/[\u0000-\u001f<>:"|?*]/.test(value)) {
    return { dir: "", error: "目录名不能包含 < > : \" | ? * 这些字符" };
  }

  const segments = value.split("/").map((seg) => seg.trim()).filter(Boolean);
  if (segments.some((seg) => seg === "." || seg === "..")) {
    return { dir: "", error: "不支持 . 或 .. 这类相对路径片段" };
  }
  if (segments.length > 6) return { dir: "", error: "层级太深了，最多 6 层" };

  const dir = segments.map((seg) => seg.replace(/^\.+/, "")).filter(Boolean).join("/");
  if (dir.length > 180) return { dir: "", error: "目录太长了，请控制在 180 个字符以内" };
  return { dir, error: null };
}
