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

/**
 * 播放器用的等宽时钟：`03:21` / `1:02:15`。
 *
 * 和 `formatEta` 的区别只是一句话的事，但这里单独命名是为了让「进度条上的时间」
 * 一眼能认出来源，别在别处被 formatDuration（中文「1 分 12 秒」）替换掉 —— 播放器里
 * 中文时长跳动起来没法对齐。
 */
export function formatClock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * 「跳到第几秒」输入框的解析。
 *
 * 接受三种写法：`83`（秒）、`1:23`（分:秒）、`01:02:03`（时:分:秒）。
 * 返回 null 表示这个输入没法用（空、含非法字符、超过三段），调用方不要动播放位置。
 */
export function parseSeekText(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parts = text.split(":").map((p) => p.trim());
  if (parts.length > 3) return null;
  if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null;
  let total = 0;
  for (const part of parts) total = total * 60 + Number(part);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function statusMeta(status: string): { label: string; className: string; dot: string } {
  switch (status) {
    case "done":
      return { label: "已完成", className: "bg-emerald-500/10 text-ok border-emerald-500/20", dot: "bg-emerald-400" };
    case "downloading":
      return { label: "下载中", className: "bg-brand-500/10 text-brand-300 border-brand-500/25", dot: "bg-brand-400" };
    case "queued":
      return { label: "排队中", className: "bg-amber-500/10 text-warn border-amber-500/20", dot: "bg-amber-400" };
    case "paused":
      return { label: "已暂停", className: "bg-sky-500/10 text-info border-sky-500/20", dot: "bg-sky-400" };
    case "stopped":
      return { label: "已停止", className: "bg-zinc-500/10 text-err border-zinc-500/20", dot: "bg-zinc-400" };
    case "failed":
      return { label: "失败", className: "bg-rose-500/10 text-err border-rose-500/20", dot: "bg-rose-400" };
    case "skipped":
      return { label: "已跳过", className: "bg-slate-500/10 text-slate-400 border-slate-500/20", dot: "bg-slate-400" };
    case "ok":
      return { label: "成功", className: "bg-emerald-500/10 text-ok border-emerald-500/20", dot: "bg-emerald-400" };
    case "error":
      return { label: "异常", className: "bg-rose-500/10 text-err border-rose-500/20", dot: "bg-rose-400" };
    case "running":
      return { label: "扫描中", className: "bg-brand-500/10 text-brand-300 border-brand-500/25", dot: "bg-brand-400" };
    default:
      return { label: status, className: "bg-white/5 text-slate-300 border-white/10", dot: "bg-slate-400" };
  }
}

/**
 * 网络线路徽章：这条任务到底走的是直连还是代理。
 * auto = 还没下载（排队中），线路待定。
 */
export function routeMeta(route: string | null | undefined): { label: string; className: string; hint: string } {
  switch (route) {
    case "direct":
      return {
        label: "直连",
        className: "bg-emerald-500/10 text-ok border-emerald-500/20",
        hint: "这条没有经过代理，直接连源站",
      };
    case "proxy":
      return {
        label: "代理",
        className: "bg-sky-500/10 text-info border-sky-500/20",
        hint: "这条经代理中转（直连不通时自动切换）",
      };
    case "auto":
      return {
        label: "自动",
        className: "bg-white/5 text-slate-400 border-white/10",
        hint: "还没开始下载，线路待定",
      };
    default:
      // 老记录没有这个字段（1.3.0 之前入队的），界面直接不显示徽章
      return {
        label: "",
        className: "",
        hint: "",
      };
  }
}

/** 监控日志的处理结果样式 */
export function logKindMeta(kind: string): { label: string; className: string; dot: string } {
  switch (kind) {
    case "hit":
      return {
        label: "已命中",
        className: "bg-emerald-500/10 text-ok border-emerald-500/20",
        dot: "bg-emerald-400",
      };
    case "filtered":
      return {
        label: "已过滤",
        className: "bg-amber-500/10 text-warn border-amber-500/20",
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

/**
 * localStorage 在沙箱 iframe（opaque origin）、无痕模式或被策略禁用时会抛
 * SecurityError，渲染期抛错会直接白屏。统一在这里兜住：读失败用默认值，
 * 写失败退化成「本次页面内有效」（与 api.ts 的会话兜底是同一套约定）。
 */
export function safeStorageGet(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不住就只在本次页面内有效 */
  }
}

export function safeStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}

/** 接口响应文本：反代 502 / HTML 错误页不是 JSON，也要保留 HTTP status 供 401 判定 */
export function parseApiText<T = unknown>(
  text: string,
  status: number,
): { status: number; ok: boolean; data: T | null } {
  const ok = status >= 200 && status < 300;
  if (!text) return { status, ok, data: null };
  try {
    return { status, ok, data: JSON.parse(text) as T };
  } catch {
    return { status, ok, data: null };
  }
}

export interface StallProbe {
  /** 带会话头探测播放地址的响应状态；null = 超时 / 网络失败 / 实时流未探测 */
  streamStatus: number | null;
  /** 带会话头探测 /session/state 的登录态；null = 没拿到 */
  stateAuthenticated: boolean | null;
  /** 是否已尝试重新同步会话 cookie */
  cookieSynced: boolean;
  /** 是不是原文件直出（非 remux / transcode 实时流） */
  direct: boolean;
  /** 看门狗等待秒数 */
  waitedSec: number;
}

/**
 * 起播看门狗的失败分诊：把「猜原因」换成实测证据。
 *
 * 裸 URL（`<img>` / `<video>`）只能带 cookie，带不了自定义会话头；反代缓冲大响应、
 * Range 被拦、非 faststart 的尾部 moov 取不到，都会表现成「一直缓冲中」且不触发 error。
 * 这里按 /session/state 与播放地址的探测结果给出可读结论，纯函数便于自检。
 */
export function describeStall(p: StallProbe): string {
  const head = `视频数据一直没到：浏览器在 ${p.waitedSec} 秒内没收到任何可解码的字节。`;
  const tail = "可以点「重试播放」，或点左下角「下载」用本地播放器看。";
  if (p.stateAuthenticated === false) {
    return `${head}探测显示登录状态已失效（/session/state 未认证）：请退出后重新登录，并勾选「保持登录」。${tail}`;
  }
  if (p.streamStatus === 401) {
    return `${head}播放请求被登录校验挡回（HTTP 401）：裸 URL 只带 cookie，cookie 没种上或已过期。` +
      `${p.cookieSynced ? "已自动重新同步一次登录状态，" : "请退出后重新登录并勾选「保持登录」，"}${tail}`;
  }
  if (p.streamStatus !== null && p.streamStatus >= 400) {
    return `${head}播放地址返回 HTTP ${p.streamStatus}（不是视频数据）：文件可能被移动、目录不在允许范围，或中间设备改写了响应。${tail}`;
  }
  if (p.streamStatus === null) {
    return `${head}带会话头探测播放地址也超时/失败：请求被挂起，常见原因是反向代理缓冲了大响应、` +
      `Range 请求被中间设备拦截，或 NAS 磁盘正忙。${tail}`;
  }
  return `${head}带会话头探测播放接口正常（HTTP ${p.streamStatus}），但浏览器原生 <video> 请求没拿到数据：` +
    `通常是会话 cookie 没种上或被拦${p.direct ? "、或非 faststart 文件的尾部索引没取到" : "（实时流起流偏慢也可能）"}。` +
    `${p.cookieSynced ? "已自动重新同步登录状态，" : "请退出后重新登录并勾选「保持登录」，"}${tail}`;
}
