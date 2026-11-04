/**
 * 概览页状态判定的纯逻辑层。
 *
 * 和 `netroute.ts` / `renameplan.ts` / `manual/note.ts` 一样：不 import db / env，
 * 自检脚本可以直接调，不会在测试里把真实数据库拉起来。
 *
 * 采集层 `overview.ts` 负责拿数据，这里只负责「拿到的数据算什么状态、怎么汇总」，
 * 前端展示的口径必须和这里一致，改判定规则时一处改完即可。
 */

export type ProbeStatus = "ok" | "warn" | "error" | "off";

export interface ProbeLike {
  status: ProbeStatus;
  label: string;
  /** 一句话说明，异常时作为「待处理」列表的内容 */
  note?: string | null;
  /** 主值，异常时拼进 issue 文案 */
  value?: string | null;
}

export interface OverviewSummary {
  ok: number;
  warn: number;
  error: number;
  off: number;
  /** 最需要用户处理的几条：error 优先、warn 次之 */
  issues: string[];
  /** 整体健康度，用于顶部那一颗大状态点 */
  overall: ProbeStatus;
}

/** 排序权重：error 最重，off 最轻（「没启用」不代表坏了） */
export function statusRank(status: ProbeStatus): number {
  switch (status) {
    case "error":
      return 3;
    case "warn":
      return 2;
    case "ok":
      return 1;
    default:
      return 0;
  }
}

/**
 * 汇总所有探针。
 *
 * 分组传进来是为了让「工具链」和「服务」各自成段，但汇总只看状态不看分组。
 * off 不计入 issues —— 用户主动关掉的功能不该天天在概览页报警。
 */
export function summarizeProbes(groups: ProbeLike[][]): OverviewSummary {
  const all = groups.flat();
  let ok = 0;
  let warn = 0;
  let error = 0;
  let off = 0;
  for (const item of all) {
    switch (item.status) {
      case "ok":
        ok += 1;
        break;
      case "warn":
        warn += 1;
        break;
      case "error":
        error += 1;
        break;
      default:
        off += 1;
    }
  }
  // error 排前面；Array.prototype.sort 是稳定排序，同级别保持原顺序
  const issues = all
    .filter((item) => item.status === "error" || item.status === "warn")
    .sort((a, b) => statusRank(b.status) - statusRank(a.status))
    .map((item) => {
      const detail = item.note ? `：${item.note}` : item.value ? `（${item.value}）` : "";
      return `${item.label}${detail}`;
    });
  const overall: ProbeStatus = error > 0 ? "error" : warn > 0 ? "warn" : ok > 0 ? "ok" : "off";
  return { ok, warn, error, off, issues, overall };
}

/** 磁盘占用率 → 状态。90% 以上就要提醒清空间了，下载会直接失败 */
export function diskLevel(percent: number | null): ProbeStatus {
  if (percent === null || !Number.isFinite(percent)) return "off";
  if (percent >= 92) return "error";
  if (percent >= 80) return "warn";
  return "ok";
}

/**
 * 工具状态。
 *
 * - 不可用且必选 → error
 * - 不可用但可选（有降级方案）→ warn
 * - 可用但有降级 / 有新版本 → warn
 */
export function toolStatus(input: {
  available: boolean;
  optional?: boolean;
  degraded?: boolean;
  outdated?: boolean;
}): ProbeStatus {
  if (!input.available) return input.optional ? "warn" : "error";
  if (input.degraded || input.outdated) return "warn";
  return "ok";
}

/** 秒 → 「2 天 3 小时」这类短文案；用于运行时长与启动时间旁注 */
export function humanUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}

/** 路径太长时只留头尾，中间用 … 代替（表格里不能撑破布局） */
export function ellipsizePath(input: string | null, max = 64): string {
  const text = String(input ?? "").trim();
  if (!text) return "—";
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}
