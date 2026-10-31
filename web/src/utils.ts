export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 45_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(ts);
}

export function formatCountdown(ts: number | null): string {
  if (!ts) return "已暂停";
  const diff = ts - Date.now();
  if (diff <= 0) return "即将开始";
  const m = Math.floor(diff / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  return `${m} 分 ${String(s).padStart(2, "0")} 秒`;
}

/** 时长（秒）→「38 秒」/「1 分 12 秒」/「2 小时 5 分」 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest > 0 ? `${m} 分 ${rest} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 剩余时间（秒）→ 00:38 / 1:02:15，等宽数字对齐更好看 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 速度（字节/秒）→「2.4 MB/s」 */
export function formatSpeed(bps: number | null | undefined): string {
  if (!bps || !Number.isFinite(bps) || bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

export function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,，\n;；]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function statusMeta(status: string): { label: string; className: string; dot: string } {
  switch (status) {
    case "done":
      return { label: "已完成", className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20", dot: "bg-emerald-400" };
    case "downloading":
      return { label: "下载中", className: "bg-brand-500/10 text-brand-300 border-brand-500/25", dot: "bg-brand-400" };
    case "queued":
      return { label: "排队中", className: "bg-amber-500/10 text-amber-300 border-amber-500/20", dot: "bg-amber-400" };
    case "paused":
      return { label: "已暂停", className: "bg-sky-500/10 text-sky-300 border-sky-500/20", dot: "bg-sky-400" };
    case "stopped":
      return { label: "已停止", className: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20", dot: "bg-zinc-400" };
    case "failed":
      return { label: "失败", className: "bg-rose-500/10 text-rose-300 border-rose-500/20", dot: "bg-rose-400" };
    case "skipped":
      return { label: "已跳过", className: "bg-slate-500/10 text-slate-400 border-slate-500/20", dot: "bg-slate-400" };
    case "ok":
      return { label: "成功", className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20", dot: "bg-emerald-400" };
    case "error":
      return { label: "异常", className: "bg-rose-500/10 text-rose-300 border-rose-500/20", dot: "bg-rose-400" };
    case "running":
      return { label: "扫描中", className: "bg-brand-500/10 text-brand-300 border-brand-500/25", dot: "bg-brand-400" };
    default:
      return { label: status, className: "bg-white/5 text-slate-300 border-white/10", dot: "bg-slate-400" };
  }
}

/** 监控日志的处理结果样式 */
export function logKindMeta(kind: string): { label: string; className: string; dot: string } {
  switch (kind) {
    case "hit":
      return {
        label: "已命中",
        className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
        dot: "bg-emerald-400",
      };
    case "filtered":
      return {
        label: "已过滤",
        className: "bg-amber-500/10 text-amber-300 border-amber-500/20",
        dot: "bg-amber-400",
      };
    case "miss":
      return {
        label: "未命中",
        className: "bg-white/[0.04] text-slate-400 border-white/[0.08]",
        dot: "bg-slate-500",
      };
    case "empty":
      return {
        label: "空消息",
        className: "bg-white/[0.03] text-slate-500 border-white/[0.06]",
        dot: "bg-slate-600",
      };
    default:
      return { label: kind, className: "bg-white/5 text-slate-300 border-white/10", dot: "bg-slate-400" };
  }
}

export function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
