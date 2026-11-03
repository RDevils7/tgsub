/**
 * 手动下载记录的「一行摘要」与状态判定。
 *
 * 故意做成纯函数、不 import db / env：
 * ① 自检脚本可以直接调（tsx 会把 import 提前求值，碰 db 就会连真实库）；
 * ② 摘要文案集中在一处，接口与前端展示不会各算一套。
 */

export type ManualKind = "telegram" | "platform" | "web";

/** ok=这次有任务入队 / existing=之前下过 / empty=没有可下的内容 / error / cancel=用户取消合集 */
export type ManualStatus = "ok" | "existing" | "empty" | "error" | "cancel";

export interface ManualCounts {
  queued: number;
  existing: number;
  skipped?: number;
}

/** 状态只看「有没有真的入队」：入队 > 之前下过 > 没有可下内容 */
export function manualStatus(counts: ManualCounts): ManualStatus {
  if (counts.queued > 0) return "ok";
  if (counts.existing > 0) return "existing";
  return "empty";
}

/** 判断这条链接归哪一类：t.me 一律当 Telegram，其余交给网页 / m3u8 通道 */
export function kindOfLink(link: string): ManualKind {
  const raw = String(link ?? "").trim();
  if (/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i.test(raw)) return "telegram";
  return "web";
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function size(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface DirectNoteInput {
  channelTitle?: string | null;
  messageId?: number | null;
  files?: number | null;
  queued: number;
  existing: number;
  skipped?: number | null;
}

/** Telegram 消息链接的摘要，例如「某频道 · #1234 · 3 个文件 · 入队 3」 */
export function directNote(result: DirectNoteInput): string {
  const parts: string[] = [];
  if (result.channelTitle) parts.push(result.channelTitle);
  if (result.messageId) parts.push(`#${result.messageId}`);
  if (result.files && result.files > 0) parts.push(`${result.files} 个文件`);
  if (result.queued > 0) parts.push(`入队 ${result.queued}`);
  if (result.existing > 0) parts.push(`已下过 ${result.existing}`);
  if (result.skipped && result.skipped > 0) parts.push(`跳过 ${result.skipped}`);
  return parts.join(" · ");
}

export interface PlatformTaskNoteInput {
  title?: string | null;
  uploader?: string | null;
  duration?: number | null;
  filesize?: number | null;
}

/** 第三方平台（B站 / 小红书 / YouTube）的摘要，例如「UP主 · 12:30 · 128.4 MB」 */
export function platformNote(
  tasks: PlatformTaskNoteInput[],
  playlist?: { count: number; mode: string; capped: boolean } | null,
): string {
  const parts: string[] = [];
  const first = tasks[0];
  if (playlist && playlist.count > 1) {
    parts.push(`合集 ${playlist.count} 个${playlist.mode === "all" ? "" : "（只下第一个）"}`);
  } else if (tasks.length > 1) {
    parts.push(`${tasks.length} 个视频`);
  }
  if (first?.uploader) parts.push(first.uploader);
  if (first?.duration) parts.push(clock(first.duration));
  if (first?.filesize) parts.push(size(first.filesize));
  return parts.join(" · ");
}

/** 网页 / m3u8 的摘要：保存目录比「m3u8 · #12」有用得多 */
export function webNote(result: { saveDir?: string | null }): string {
  return result.saveDir ? `${result.saveDir}/` : "";
}

/** 裁剪到 n 个字符，避免把整段报错塞进列表（详情仍能在 error 字段看到） */
export function clamp(text: string, n = 300): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > n ? `${value.slice(0, n - 1)}…` : value;
}
