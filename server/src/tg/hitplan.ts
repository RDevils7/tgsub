/**
 * 机器人通知文案：订阅命中 → 自动下载的那几条，要带着名字。
 *
 * 以前定时扫描只推一句「新入队 3 个文件」，用户看不出下的是什么、是哪条订阅
 * 触发的、来自哪个频道，还得回网页翻。这里把「一条命中」拼成一行：
 *
 *   · 美人局 · 6 个文件 · 🏷 短剧4K · 📡 某频道
 *
 * 纯函数，便于自检；HTML 转义交给 escapeHtml，频道名 / 订阅名里带 < > 也不炸。
 */
import { escapeHtml } from "../utils";

/** 一条「订阅命中并已入队」的记录，与 scanner 的 ScanHit 同形状 */
export interface HitLike {
  /** 「叫什么」——剧名 / 兜底文件夹名 / 文件原名 */
  title: string;
  /** 命中的订阅名；关键词直取时为 null */
  sub: string | null;
  keyword: string | null;
  /** 本次入队文件数 */
  files: number;
  /** 频道标题 */
  channel: string;
}

/** 一条通知里最多列几行明细，剩下的折成「还有 N 条」 */
export const HIT_LINE_LIMIT = 8;

const TITLE_MAX = 60;
const TAG_MAX = 24;

function shorten(text: string, max: number): string {
  const value = String(text ?? "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

/** 汇总句：入队多少文件 + 几条订阅命中（订阅名去重） */
export function hitSummaryLine(hits: HitLike[], files: number): string {
  const subs = new Set(
    hits.map((hit) => hit.sub).filter((name): name is string => Boolean(name)),
  );
  const bits = [`新入队 ${files} 个文件`];
  if (subs.size > 0) bits.push(`订阅命中 ${subs.size} 条`);
  else if (hits.length > 0) bits.push(`命中 ${hits.length} 条`);
  return bits.join(" · ");
}

/** 一条明细：名字在前，规格 / 订阅 / 频道跟在后 */
export function hitLine(hit: HitLike): string {
  const parts = [`· ${escapeHtml(shorten(hit.title, TITLE_MAX))}`];
  if (hit.files > 1) parts.push(`${hit.files} 个文件`);
  if (hit.sub) parts.push(`🏷 ${escapeHtml(shorten(hit.sub, TAG_MAX))}`);
  else if (hit.keyword) parts.push(`🔎 ${escapeHtml(shorten(hit.keyword, TAG_MAX))}`);
  if (hit.channel) parts.push(`📡 ${escapeHtml(shorten(hit.channel, TAG_MAX))}`);
  return parts.join(" · ");
}

/** 明细若干行（超过 limit 时末尾补一句「还有 N 条」） */
export function hitLines(hits: HitLike[], limit = HIT_LINE_LIMIT): string[] {
  if (!hits.length) return [];
  const lines = hits.slice(0, Math.max(1, limit)).map(hitLine);
  const rest = hits.length - lines.length;
  if (rest > 0) lines.push(`…还有 ${rest} 条`);
  return lines;
}
