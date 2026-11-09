import fs from "node:fs";
import path from "node:path";
import { sanitizeSegment } from "../utils";

/**
 * 媒体路径的纯函数工具。
 *
 * 单独拆出来是为了让「删除管理」的核心规则（怎么找视频、副产物怎么命名）
 * 可以在不碰数据库的情况下自检 —— 这个模块不 import db / env。
 */

const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|flv|wmv|ts|m4v|webm|mpeg|mpg|rmvb|rm|vob|m2ts|ogv|3gp)$/i;

/**
 * strm 是**纯文本链接文件**，不是视频。
 * 它绝不能进 VIDEO_EXT_RE：那个正则还被改名 / 删除 / 搬运 / NFO / 抽帧共用，
 * 一合并就会把几十字节的文本当成视频去删、去生成 NFO、去起 ffmpeg 抽帧。
 * 只有媒体库的「只读 + 播放」链路单独认它。
 */
const STRM_EXT_RE = /\.strm$/i;

/** 视频后缀正则（解析剧名时要把后缀去掉） */
export { VIDEO_EXT_RE, STRM_EXT_RE };

export function isStrmFile(name: string): boolean {
  return STRM_EXT_RE.test(name);
}

/** 图片后缀（封面、缩略图都算） */
export const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

/** 递归找视频的最大层级（剧集 / 季 / 集 三层足够，再深就当异常目录） */
export const MAX_VIDEO_DEPTH = 6;

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT_RE.test(name);
}

/** 目标是否在另一个路径之下（含相等） */
export function isUnderPath(child: string, parent: string): boolean {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
}

/** 递归收集目录下的视频文件 */
export function collectVideos(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > MAX_VIDEO_DEPTH) return acc;
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
      collectVideos(full, depth + 1, acc);
      continue;
    }
    if (entry.isFile() && isVideoFile(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * 单集视频的副产物：<base>.nfo 与 <base>-*.图片。
 *
 * 命名规则与元数据页写文件时完全一致（都走 sanitizeSegment），
 * 所以删视频时能准确带走它的 NFO 与缩略图。
 */
export function episodeArtifacts(videoPath: string): { nfo: string; images: string[] } {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const safe = sanitizeSegment(base, 120);
  const images: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.startsWith(`${safe}-`)) continue;
    if (!IMAGE_EXT_RE.test(name)) continue;
    images.push(path.join(dir, name));
  }
  return { nfo: path.join(dir, `${safe}.nfo`), images };
}

/* ------------------------------------------------------------------ */
/* strm：只读播放链路的纯函数                                          */
/* ------------------------------------------------------------------ */

/** strm 去掉扩展名后的基名，封面与 NFO 都按它命名 */
export function strmBase(file: string): string {
  return path.basename(file).replace(STRM_EXT_RE, "");
}

/**
 * 封面落在 strm 同级、`<基名>-thumb.jpg`。
 * 这个名字和 existingEpisodeThumb() / 下载时的截帧封面完全一致，
 * 所以 Emby、媒体库海报墙、剧集封面都能直接认出来。
 */
export function strmPosterPath(file: string): string {
  return path.join(path.dirname(file), `${strmBase(file)}-thumb.jpg`);
}

/** 单集 NFO 落在 strm 同级、`<基名>.nfo` */
export function strmNfoPath(file: string): string {
  return path.join(path.dirname(file), `${strmBase(file)}.nfo`);
}

/** 回环与云元数据地址一律拦掉，避免服务端被当成 SSRF 跳板 */
const BLOCKED_STRM_HOST = /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1|169\.254\.169\.254|metadata\.google\.internal|metadata\.goog)$/i;

/**
 * 解析 strm 正文：取第一行非空、非注释的 http(s) URL，**原样返回**。
 *
 * 原样很重要：这类播放代理签出来的地址里常有 `%40`、`%20`、中文和签名 hash，
 * 一旦 decodeURIComponent 再拼回去，上游就会 404。
 */
export function parseStrmTarget(text: string): string | null {
  for (const line of String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    if (raw.length > 4096) return null;
    if (!/^https?:\/\//i.test(raw)) return null;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || BLOCKED_STRM_HOST.test(host)) return null;
    if (parsed.username || parsed.password) return null;
    return raw;
  }
  return null;
}

/**
 * RFC1918 / 链路本地 / IPv6 ULA：这些目标必须直连。
 * 现有的 isInternalProxy() 判断的是「代理地址本身是不是本机」，不是目标主机；
 * 配了 m3u8_proxy 时 192.168.x 会被塞进代理而连不上，这里单独兜住。
 */
export function isPrivateHost(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return true;
  if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
  const m = /^172\.(\d{1,3})\./.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (host.startsWith("169.254.")) return true;
  if (/^(?:fc|fd)/.test(host) || host.startsWith("fe80:")) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  return host.endsWith(".local") || host.endsWith(".internal");
}

/** 前端 canvas 传来的封面：只认 jpeg dataURL，限大小并校验 JPEG 魔数 */
export function decodePosterDataUrl(raw: string, maxBytes = 2 * 1024 * 1024): Buffer | null {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(raw ?? ""));
  if (!match) return null;
  const buf = Buffer.from(match[1], "base64");
  if (buf.length < 2 || buf.length > maxBytes) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}
