import path from "node:path";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Telegram HTML 模式转义：标题 / 文件名里带 < > & 会破坏整条消息的解析 */
export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 把任意 bigint / big-integer 转成 number */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const asStr = String((value as { toString(): string }).toString());
  const n = Number(asStr);
  return Number.isFinite(n) ? n : 0;
}

/** 清理文件名中的非法字符，并限制长度 */
export function sanitizeSegment(input: string, max = 120): string {
  const cleaned = input
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  const safe = cleaned || "untitled";
  if (safe.length <= max) return safe;
  const ext = path.extname(safe);
  const base = safe.slice(0, Math.max(1, max - ext.length));
  return base + ext;
}

export function formatDateFolder(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,，\n;；]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** 订阅名称留空时用关键词自动生成，避免"只想填关键词"却存不进去 */
export function deriveName(keywords: string): string {
  const list = splitKeywords(keywords);
  const first = (list[0] ?? "未命名订阅").slice(0, 20);
  return list.length > 1 ? `${first} 等 ${list.length} 个关键词` : first;
}
