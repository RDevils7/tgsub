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
  /** 稳定前缀（tool:ffmpeg / service:platform）；缺省时用 label */
  id?: string;
  status: ProbeStatus;
  label: string;
  /** 一句话说明，异常时作为「待处理」列表的内容 */
  note?: string | null;
  /** 主值，异常时拼进 issue 文案 */
  value?: string | null;
  /** 展开后逐条显示的补充说明，例如「具体哪个平台缺 Cookie」 */
  detail?: string[];
  /** 处理建议：一句能照着做的人话 */
  hint?: string | null;
  /** 影响范围：坏了会连累哪些功能 */
  impact?: string | null;
  /** 「去处理」要跳的页面 */
  page?: string | null;
}

export interface OverviewIssue {
  /** 稳定 id：前缀 + 状态指纹。问题变了会自动变成新 id，重新提醒 */
  id: string;
  level: "warn" | "error";
  label: string;
  /** 一句话摘要：列表标题 / 复制诊断都用它 */
  text: string;
  /** 展开后逐条显示的详情 */
  detail: string[];
  hint: string | null;
  page: string | null;
  ignoredAt: number | null;
}

/** 落库的忽略记录（同时是列表快照：问题消失后也还能显示、能恢复） */
export interface IgnoredIssue {
  id: string;
  label: string;
  text: string;
  ignoredAt: number;
}

export interface OverviewSummary {
  /** 以下四个计数都只算「没被忽略」的项，和顶部标题口径一致 */
  ok: number;
  warn: number;
  error: number;
  off: number;
  /** 待处理：error 优先、warn 次之 */
  issues: OverviewIssue[];
  /** 已被忽略的提醒（含当前已不再出现的历史项，供恢复） */
  ignored: OverviewIssue[];
  /** 当前探针里被忽略的数量，方便核对总数 */
  ignoredCount: number;
  /** 整体健康度，用于顶部那一颗大状态点；忽略过的不再拖累 */
  overall: ProbeStatus;
}

/** FNV-1a 短指纹：只用来生成稳定 id，不用于任何安全场景 */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

/**
 * 忽略的是「这一条具体提醒」，不是整个探针：指纹只取 label + value（状态值），
 * 不取 note / detail。这样「2/3 已配 Cookie」变成「3/3」时会自动换 id 重新提醒，
 * 而带时间戳的说明文字变动不会让已忽略的提醒自己弹回来。
 */
export function issueId(item: ProbeLike): string {
  return `${item.id || item.label}:${fingerprint(`${item.label}|${item.value ?? ""}`)}`;
}

/** 把一条探针转成前端可直接渲染的提醒 */
export function buildIssue(item: ProbeLike, ignoredAt: number | null = null): OverviewIssue {
  const detail: string[] = [];
  // 采集层给的明细最有用（例如「B站：未配置 Cookie」），排在最前面
  for (const line of item.detail ?? []) if (line) detail.push(line);
  if (item.value) detail.push(`当前值：${item.value}`);
  if (item.note) detail.push(`说明：${item.note}`);
  if (item.impact) detail.push(`影响：${item.impact}`);
  const suffix = item.note ? `：${item.note}` : item.value ? `（${item.value}）` : "";
  return {
    id: issueId(item),
    level: item.status === "error" ? "error" : "warn",
    label: item.label,
    text: `${item.label}${suffix}`,
    detail,
    hint: item.hint ?? null,
    page: item.page ?? null,
    ignoredAt,
  };
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
 * ignored 是落库的忽略记录：被忽略的项既不进待处理列表，也不拖累计数与整体状态，
 * 但仍会在 `ignored` 里留一条（问题自己好了也要能找到并恢复）。
 */
export function summarizeProbes(groups: ProbeLike[][], ignored: IgnoredIssue[] = []): OverviewSummary {
  const all = groups.flat();
  const ignoredMap = new Map(ignored.map((row) => [row.id, row]));
  let ok = 0;
  let warn = 0;
  let error = 0;
  let off = 0;
  let ignoredCount = 0;
  for (const item of all) {
    if ((item.status === "warn" || item.status === "error") && ignoredMap.has(issueId(item))) {
      ignoredCount += 1;
      continue;
    }
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
  const flagged = all
    .filter((item) => item.status === "error" || item.status === "warn")
    .sort((a, b) => statusRank(b.status) - statusRank(a.status));
  const isIgnored = (item: ProbeLike) => ignoredMap.has(issueId(item));
  const issues = flagged.filter((item) => !isIgnored(item)).map((item) => buildIssue(item));
  const activeIgnored = flagged.filter(isIgnored).map((item) => {
    const row = ignoredMap.get(issueId(item))!;
    // 文案用落库快照：用户当初忽略的就是这一句，别被当前探针的措辞改写
    return { ...buildIssue(item, row.ignoredAt), label: row.label, text: row.text };
  });
  // 状态修好了 / 文案变了，探针里已经没有这条了，但库里还留着 —— 用快照给个恢复入口
  const seen = new Set(flagged.map(issueId));
  const stale = ignored
    .filter((row) => !seen.has(row.id))
    .map<OverviewIssue>((row) => ({
      id: row.id,
      level: "warn",
      label: row.label,
      text: row.text,
      detail: ["这条提醒当前已不再出现（可能问题已修复或状态变了），可以取消忽略"],
      hint: null,
      page: null,
      ignoredAt: row.ignoredAt,
    }));
  const overall: ProbeStatus = error > 0 ? "error" : warn > 0 ? "warn" : ok > 0 ? "ok" : "off";
  return { ok, warn, error, off, issues, ignored: [...activeIgnored, ...stale], ignoredCount, overall };
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
