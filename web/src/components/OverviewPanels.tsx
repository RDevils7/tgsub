import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { OverviewReport, ProbeStatus, ServiceProbe, ToolProbe } from "../types";
import { Badge, Button, ProgressBar, Spinner, StatusDot } from "./ui";
import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconCopy,
  IconCpu,
  IconDatabase,
  IconGlobe,
  IconHardDrive,
  IconPackage,
  IconRefresh,
  IconServer,
  IconTool,
} from "./icons";
import { formatBytes, formatDateTime, formatDuration, formatRelative } from "../utils";

/**
 * 概览页新增的状态面板。
 *
 * 数据全部来自一个接口 GET /api/overview（服务端聚合、30 秒缓存），
 * 这里只负责展示与「复制诊断」——不再让概览页同时打六七个接口。
 * 面板自己管加载，失败也只是这一块不显示，不影响原有的下载统计与扫描记录。
 */

export type OverviewNavKey =
  | "settings"
  | "channels"
  | "subscriptions"
  | "downloads"
  | "emby"
  | "logs"
  | "manual"
  | "metadata";

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

export const STATUS_META: Record<
  ProbeStatus,
  { label: string; dot: string; badge: string; text: string; glow: string }
> = {
  ok: {
    label: "正常",
    dot: "bg-emerald-400",
    badge: "border-emerald-500/25 bg-emerald-500/10 text-ok",
    text: "text-ok",
    glow: "from-emerald-500/20",
  },
  warn: {
    label: "留意",
    dot: "bg-amber-400",
    badge: "border-amber-500/25 bg-amber-500/10 text-warn",
    text: "text-warn",
    glow: "from-amber-500/20",
  },
  error: {
    label: "异常",
    dot: "bg-rose-400",
    badge: "border-rose-500/25 bg-rose-500/10 text-err",
    text: "text-err",
    glow: "from-rose-500/20",
  },
  off: {
    label: "未启用",
    dot: "bg-slate-500",
    badge: "border-white/[0.08] bg-white/[0.03] text-slate-400",
    text: "text-slate-400",
    glow: "from-slate-500/10",
  },
};

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 复制成功后的「已复制」提示，1.6 秒自动消失 */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (key: string, text: string) => {
    if (!(await writeClipboard(text))) return;
    setCopied(key);
    window.setTimeout(() => setCopied((cur) => (cur === key ? null : cur)), 1600);
  }, []);
  return { copied, copy };
}

export interface OverviewState {
  report: OverviewReport | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useOverview(): OverviewState {
  const [report, setReport] = useState<OverviewReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    try {
      setReport(await api.overview(force));
      setError(null);
    } catch (err) {
      setError((err as Error).message || "运行状态读取失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    // 工具版本不会秒变，30 秒轮询足够；手动「重新检测」才强制 spawn 探测
    const timer = window.setInterval(() => void load(false), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return { report, loading, refreshing, error, refresh: () => void load(true) };
}

/** 排障时一键复制的纯文本快照：版本、工具、服务、目录全在里面 */
export function buildDiagnostics(r: OverviewReport): string {
  const disk = r.storage.disk;
  const lines: string[] = [
    `tgsub ${r.runtime.version} 诊断 · ${new Date(r.at).toLocaleString("zh-CN")}`,
    `运行时: Node ${r.runtime.node} / ${r.runtime.platform} ${r.runtime.arch} / ${r.runtime.os} / ${r.runtime.inContainer ? "容器" : "宿主机"} / 已运行 ${formatDuration(r.runtime.uptime)} / PID ${r.runtime.pid}`,
    `内存: RSS ${formatBytes(r.runtime.memory.rss)} · 堆 ${formatBytes(r.runtime.memory.heapUsed)} · 系统 ${formatBytes(r.runtime.totalMemory)} · ${r.runtime.cpus} 核`,
    `时区: ${r.runtime.timezone}（进程 ${r.runtime.resolvedTimezone}）`,
    `磁盘: ${disk ? `已用 ${formatBytes(disk.used)} / ${formatBytes(disk.total)}（${disk.percent}%），可用 ${formatBytes(disk.free)}` : "不可用"}`,
    `数据目录: ${r.storage.dataDir}（${r.storage.writable.data ? "可写" : "不可写"}）`,
    `下载目录: ${r.storage.downloadDir}（${r.storage.writable.downloads ? "可写" : "不可写"}）`,
    `数据库: ${r.storage.dbFile} · ${formatBytes(r.storage.dbSize)} · ${r.storage.dbTables} 张表 / ${r.storage.dbRows} 条下载记录`,
    "",
    "[工具链]",
    ...r.tools.map(
      (t) =>
        `[${STATUS_META[t.status].label}] ${t.label} | 版本 ${t.version || "—"} | 位置 ${t.path || "—"} | 来源 ${t.source || "—"}${t.note ? ` | ${t.note}` : ""}`,
    ),
    "",
    "[服务]",
    ...r.services.map(
      (s) => `[${STATUS_META[s.status].label}] ${s.label} | ${s.value}${s.note ? ` | ${s.note}` : ""}`,
    ),
    "",
    "[来源目录]",
    ...r.storage.dirs.map(
      (d) => `${d.label} | ${d.rel} | ${d.absolute} | ${d.error ?? (d.exists ? (d.writable ? "可写" : "不可写") : "待创建")}`,
    ),
  ];
  return lines.join("\n");
}

function Section({
  title,
  desc,
  icon,
  extra,
  delay = 0,
  children,
}: {
  title: string;
  desc: string;
  icon: React.ReactNode;
  extra?: React.ReactNode;
  delay?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="card animate-fade-up p-5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-brand-500/20 bg-brand-500/10 text-brand-300">
            {icon}
          </span>
          <div>
            <h2 className="text-[14px] font-semibold text-white">{title}</h2>
            <p className="mt-0.5 text-[11.5px] text-slate-500">{desc}</p>
          </div>
        </div>
        {extra}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function CopyablePath({
  value,
  copyKey,
  copy,
  copied,
  className = "",
}: {
  value: string;
  copyKey: string;
  copy: (key: string, text: string) => void;
  copied: string | null;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => void copy(copyKey, value)}
      title={`点击复制：${value}`}
      className={`group flex w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-left ${className}`}
    >
      {/* flex item 必须 min-w-0 + flex-1，否则长路径会撑破 grid 列、压到右侧状态徽章 */}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500 transition group-hover:text-brand-300">
        {value}
      </span>
      {copied === copyKey ? (
        <IconCheck className="h-3 w-3 shrink-0 text-ok" />
      ) : (
        <IconCopy className="h-3 w-3 shrink-0 text-slate-600 opacity-0 transition group-hover:opacity-100" />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 顶部健康条                                                          */
/* ------------------------------------------------------------------ */

export function HealthBanner({ state }: { state: OverviewState }) {
  const { report, loading, refreshing, error, refresh } = state;
  const { copied, copy } = useCopy();
  const overall = report?.summary.overall ?? "off";
  const meta = STATUS_META[overall];
  const title =
    loading && !report
      ? "正在检查运行环境…"
      : error && !report
        ? "运行状态读取失败"
        : overall === "ok"
          ? "系统运行正常"
          : overall === "warn"
            ? `有 ${report!.summary.warn} 项需要留意`
            : overall === "error"
              ? `有 ${report!.summary.error} 项异常`
              : "等待状态数据";

  return (
    <div className="card relative animate-fade-up overflow-hidden p-5">
      <div className={`pointer-events-none absolute -left-16 -top-24 h-56 w-56 rounded-full bg-gradient-to-br ${meta.glow} to-transparent blur-3xl`} />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${meta.badge}`}>
            {loading && !report ? <Spinner className="h-4 w-4" /> : <IconActivity className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <h2 className={`text-[16px] font-semibold ${error && !report ? "text-err" : "text-white"}`}>{title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-slate-500">
              <span className="font-mono text-slate-400">tgsub {report?.runtime.version ?? "…"}</span>
              <span>·</span>
              <span>已运行 {report ? formatDuration(report.runtime.uptime) : "—"}</span>
              {report && (
                <>
                  <span>·</span>
                  <span>{formatDateTime(report.at)} 检查{report.cached ? "（缓存）" : ` · ${report.elapsedMs}ms`}</span>
                </>
              )}
            </p>
            {report && (
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                <span className="text-ok">{report.summary.ok} 项正常</span>
                <span className={report.summary.warn ? "text-warn" : "text-slate-600"}>{report.summary.warn} 项留意</span>
                <span className={report.summary.error ? "text-err" : "text-slate-600"}>{report.summary.error} 项异常</span>
                <span className="text-slate-600">{report.summary.off} 项未启用</span>
              </p>
            )}
            {error && report && <p className="mt-1.5 text-[11.5px] text-warn">上次刷新失败：{error}（下面是上次成功的结果）</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void copy("diagnostics", report ? buildDiagnostics(report) : "")} disabled={!report}>
            {copied === "diagnostics" ? <IconCheck className="h-3 w-3 text-ok" /> : <IconCopy className="h-3 w-3" />}
            {copied === "diagnostics" ? "已复制" : "复制诊断"}
          </Button>
          <Button size="sm" variant="primary" onClick={refresh} loading={refreshing}>
            {!refreshing && <IconRefresh className="h-3 w-3" />}
            重新检测
          </Button>
        </div>
      </div>

      {report && report.summary.issues.length > 0 && (
        <div className="relative mt-4 flex flex-wrap gap-2">
          {report.summary.issues.slice(0, 4).map((issue, i) => (
            <span
              key={`${i}-${issue}`}
              title={issue}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-amber-500/15 bg-amber-500/[0.06] px-2.5 py-1 text-[11px] text-warn/90"
            >
              <IconAlert className="h-3 w-3 shrink-0" />
              <span className="truncate">{issue}</span>
            </span>
          ))}
          {report.summary.issues.length > 4 && (
            <span className="rounded-lg border border-white/[0.06] px-2.5 py-1 text-[11px] text-slate-500">
              还有 {report.summary.issues.length - 4} 项
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 服务状态                                                            */
/* ------------------------------------------------------------------ */

function ServiceCard({ item, onNavigate }: { item: ServiceProbe; onNavigate: (page: OverviewNavKey) => void }) {
  const meta = STATUS_META[item.status];
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-slate-400">{item.label}</span>
        <StatusDot className={meta.dot} />
      </div>
      <p className="mt-2 truncate text-[15px] font-semibold text-white" title={item.value}>
        {item.value}
      </p>
      <p className="mt-1 truncate text-[11.5px] text-slate-500" title={item.note ?? ""}>
        {item.note || "—"}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <Badge className={meta.badge}>
          <StatusDot className={meta.dot} />
          {meta.label}
        </Badge>
        {item.page && <span className="shrink-0 text-[11px] text-slate-600 transition group-hover:text-brand-300">前往 →</span>}
      </div>
    </>
  );
  const cls = "group rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5";
  return item.page ? (
    <button type="button" onClick={() => onNavigate(item.page!)} className={`${cls} text-left transition hover:border-brand-500/25 hover:bg-brand-500/[0.04]`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function ServiceGrid({ services, onNavigate }: { services: ServiceProbe[]; onNavigate: (page: OverviewNavKey) => void }) {
  return (
    <Section
      title="服务状态"
      desc="账号连接、定时任务、入库与代理的实时情况，点卡片直达对应设置"
      icon={<IconServer className="h-4 w-4" />}
      delay={40}
      extra={<span className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-slate-500">{services.length} 项</span>}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {services.map((item) => (
          <ServiceCard key={item.id} item={item} onNavigate={onNavigate} />
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 工具链                                                              */
/* ------------------------------------------------------------------ */

const TOOL_GRID = "grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.85fr)_minmax(0,1.45fr)_auto] xl:items-center xl:gap-3";

function ToolRow({ tool }: { tool: ToolProbe }) {
  const { copied, copy } = useCopy();
  const meta = STATUS_META[tool.status];
  return (
    <div className={`grid ${TOOL_GRID} px-3.5 py-3 transition hover:bg-white/[0.02]`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StatusDot className={meta.dot} />
          <span className="min-w-0 truncate text-[12.5px] font-medium text-slate-200" title={tool.label}>
            {tool.label}
          </span>
        </div>
        <p className="mt-1 truncate pl-3.5 text-[11px] text-slate-500" title={tool.usedBy}>
          {tool.usedBy}
        </p>
        {tool.note && (
          <p
            className={`mt-1 truncate pl-3.5 text-[11px] ${tool.status === "error" ? "text-err" : tool.status === "warn" ? "text-warn" : "text-slate-500"}`}
            title={tool.note}
          >
            {tool.note}
          </p>
        )}
      </div>
      <div className="min-w-0 pl-3.5 xl:pl-0">
        <span className="block truncate font-mono text-[11.5px] text-slate-300" title={tool.version ?? ""}>
          {tool.version || "—"}
        </span>
        {tool.source && <span className="mt-0.5 block truncate text-[10.5px] text-slate-600 xl:hidden">{tool.source}</span>}
      </div>
      <div className="min-w-0 pl-3.5 xl:pl-0">
        {tool.path ? (
          <CopyablePath value={tool.path} copyKey={`tool-${tool.id}`} copy={copy} copied={copied} />
        ) : (
          <span className="font-mono text-[11px] text-slate-600">—</span>
        )}
        {tool.source && (
          <span className="mt-0.5 hidden truncate text-[10.5px] text-slate-600 xl:block" title={tool.source}>
            {tool.source}
          </span>
        )}
      </div>
      <div className="pl-3.5 xl:min-w-[76px] xl:pl-0 xl:text-right">
        <Badge className={meta.badge}>
          <StatusDot className={meta.dot} />
          {meta.label}
        </Badge>
      </div>
    </div>
  );
}

export function ToolChain({ tools }: { tools: ToolProbe[] }) {
  return (
    <Section
      title="工具链"
      desc="当前实际生效的版本、可执行文件位置与来源；点路径可复制"
      icon={<IconTool className="h-4 w-4" />}
      delay={80}
      extra={<span className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-slate-500">{tools.length} 个组件</span>}
    >
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <div className={`hidden ${TOOL_GRID} grid bg-white/[0.02] px-3.5 py-2 text-[10.5px] uppercase tracking-wider text-slate-500 xl:grid`}>
          <span>组件 / 用途</span>
          <span>版本</span>
          <span>位置</span>
          <span className="text-right">状态</span>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 存储与目录                                                          */
/* ------------------------------------------------------------------ */

function PathLine({ label, value, extra, ok }: { label: string; value: string; extra?: string; ok?: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <span className="w-[68px] shrink-0 pt-0.5 text-[11.5px] text-slate-500">{label}</span>
      <div className="min-w-0 flex-1">
        <CopyablePath value={value} copyKey={`path-${label}`} copy={copy} copied={copied} />
        {extra && <p className="mt-0.5 text-[10.5px] text-slate-600">{extra}</p>}
      </div>
      {ok !== undefined && (
        <span className={`shrink-0 pt-0.5 text-[11px] ${ok ? "text-ok" : "text-err"}`}>{ok ? "可写" : "不可写"}</span>
      )}
    </div>
  );
}

export function StorageSection({ report }: { report: OverviewReport }) {
  const { storage } = report;
  const disk = storage.disk;
  const diskMeta = disk ? STATUS_META[disk.status] : null;
  return (
    <Section
      title="存储与目录"
      desc="磁盘余量、数据目录与各来源的落盘位置"
      icon={<IconHardDrive className="h-4 w-4" />}
      delay={100}
    >
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <div className="space-y-3">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="flex items-center gap-1.5 text-slate-400">
                <IconDatabase className="h-3.5 w-3.5" />
                下载磁盘
              </span>
              <span className={`font-mono ${diskMeta ? diskMeta.text : "text-slate-500"}`}>
                {disk ? `${disk.percent}%` : "不可用"}
              </span>
            </div>
            {disk ? (
              <>
                <ProgressBar value={disk.percent} className="mt-2.5" />
                <div className="mt-2 flex flex-wrap justify-between gap-1 text-[11px] text-slate-500">
                  <span>已用 {formatBytes(disk.used)}</span>
                  <span>可用 {formatBytes(disk.free)} / {formatBytes(disk.total)}</span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-[11.5px] text-slate-500">当前环境读不到磁盘容量（网络挂载或权限限制）</p>
            )}
          </div>
          <div className="divide-y divide-white/[0.04] rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-1">
            <PathLine label="数据目录" value={storage.dataDir} ok={storage.writable.data} />
            <PathLine label="下载目录" value={storage.downloadDir} ok={storage.writable.downloads} />
            <PathLine
              label="数据库"
              value={storage.dbFile}
              extra={`${formatBytes(storage.dbSize)} · ${storage.dbTables} 张表 / ${storage.dbRows} 条下载记录 · 缓存上限 ${storage.cacheLimitMb ? `${storage.cacheLimitMb} MB` : "不限制"}`}
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <div className="flex items-center justify-between bg-white/[0.02] px-3.5 py-2 text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <IconGlobe className="h-3.5 w-3.5" />
              分来源目录（相对下载根）
            </span>
            <span>{storage.dirs.length} 个</span>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {storage.dirs.map((dir) => {
              const bad = Boolean(dir.error) || (dir.exists && !dir.writable);
              const stateText = dir.error ? "配置有误" : !dir.exists ? "待创建" : dir.writable ? "可写" : "不可写";
              return (
                <div key={dir.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <span className="w-[76px] shrink-0 truncate text-[12px] text-slate-300" title={dir.label}>
                    {dir.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[11.5px] text-slate-400" title={dir.absolute}>
                      {dir.rel}
                    </p>
                    <p className="truncate font-mono text-[10px] text-slate-600" title={dir.absolute}>
                      {dir.error || dir.absolute}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[11px] ${bad ? "text-err" : dir.exists ? "text-ok" : "text-slate-500"}`}>
                    {stateText}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* 运行时                                                              */
/* ------------------------------------------------------------------ */

function InfoRow({ label, value, wide = false, accent = false }: { label: string; value: string; wide?: boolean; accent?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}>
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className={`mt-0.5 truncate font-mono text-[11.5px] ${accent ? "text-brand-300" : "text-slate-300"}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

export function RuntimeCard({ report }: { report: OverviewReport }) {
  const r = report.runtime;
  return (
    <Section
      title="运行时"
      desc="进程身份、资源占用与部署环境"
      icon={<IconCpu className="h-4 w-4" />}
      delay={120}
      extra={
        <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <IconPackage className="h-3.5 w-3.5" />
          {r.inContainer ? "容器" : "宿主机"}
        </span>
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <InfoRow label="应用版本" value={r.version} accent />
        <InfoRow label="Node.js" value={r.node} />
        <InfoRow label="操作系统" value={r.os} />
        <InfoRow label="平台 / 架构" value={`${r.platform} / ${r.arch}`} />
        <InfoRow label="CPU" value={`${r.cpus} 核`} />
        <InfoRow label="系统内存" value={formatBytes(r.totalMemory)} />
        <InfoRow label="进程内存 RSS" value={formatBytes(r.memory.rss)} />
        <InfoRow label="堆内存" value={`${formatBytes(r.memory.heapUsed)} / ${formatBytes(r.memory.heapTotal)}`} />
        <InfoRow label="进程 PID" value={String(r.pid)} />
        <InfoRow label="已运行" value={formatDuration(r.uptime)} />
        <InfoRow label="启动于" value={formatRelative(r.startedAt)} />
        <InfoRow
          label="时区"
          value={r.resolvedTimezone && r.resolvedTimezone !== r.timezone ? `${r.timezone} / ${r.resolvedTimezone}` : r.timezone}
        />
        <InfoRow label="工作目录" value={r.workDir} wide />
      </dl>
    </Section>
  );
}
