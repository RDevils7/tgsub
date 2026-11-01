import { useEffect, useState } from "react";
import { api } from "../api";
import type { ScanState, Stats } from "../types";
import { Badge, Button, EmptyState, ProgressBar, Spinner, StatusDot } from "../components/ui";
import {
  IconAlert,
  IconBroadcast,
  IconClock,
  IconDownload,
  IconFile,
  IconPlay,
  IconSpark,
  IconTag,
} from "../components/icons";
import { formatBytes, formatCountdown, formatRelative, statusMeta } from "../utils";

interface Props {
  stats: Stats | null;
  scanState: ScanState | null;
  onScan: () => Promise<void>;
  scanning: boolean;
  onNavigate: (page: "channels" | "subscriptions" | "downloads" | "settings") => void;
}

function Countdown({ ts }: { ts: number | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="font-mono text-[12px] text-slate-400">{formatCountdown(ts)}</span>;
}

export default function Dashboard({ stats, scanState, onScan, scanning, onNavigate }: Props) {
  if (!stats || !scanState) {
    return (
      <div className="flex h-64 items-center justify-center text-slate-500">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  const { totals, today, recentRuns, recentDownloads } = stats;
  const auth = scanState.auth;
  const totalBytes = totals.bytes;
  const doneRatio = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

  const cards = [
    {
      label: "监控频道",
      value: String(totals.enabledChannels),
      suffix: `/ ${totals.channels}`,
      icon: <IconBroadcast className="h-4 w-4" />,
      tone: "text-brand-300 bg-brand-500/10 border-brand-500/20",
      hint: totals.channels === 0 ? "尚未添加频道" : "已启用 / 全部",
    },
    {
      label: "订阅规则",
      value: String(totals.subscriptions),
      suffix: "条",
      icon: <IconTag className="h-4 w-4" />,
      tone: "text-violet-400 bg-violet-500/10 border-violet-500/20",
      hint: "关键词匹配中",
    },
    {
      label: "今日下载",
      value: String(today.downloads),
      suffix: "个文件",
      icon: <IconDownload className="h-4 w-4" />,
      tone: "text-ok bg-emerald-500/10 border-emerald-500/20",
      hint: `共 ${formatBytes(today.bytes)}`,
    },
    {
      label: "累计占用",
      value: formatBytes(totalBytes, 1),
      suffix: "",
      icon: <IconFile className="h-4 w-4" />,
      tone: "text-warn bg-amber-500/10 border-amber-500/20",
      hint: `${totals.done} 个文件已完成`,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card, i) => (
          <div
            key={card.label}
            className="card card-hover animate-fade-up p-4"
            style={{ animationDelay: `${i * 45}ms` }}
          >
            <div className="flex items-start justify-between">
              <span className="text-[12.5px] font-medium text-slate-400">{card.label}</span>
              <span className={`flex h-7 w-7 items-center justify-center rounded-lg border ${card.tone}`}>
                {card.icon}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="text-[26px] font-semibold leading-none tracking-tight text-white">{card.value}</span>
              {card.suffix && <span className="text-[12px] text-slate-500">{card.suffix}</span>}
            </div>
            <p className="mt-2 text-[11.5px] text-slate-500">{card.hint}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card flex animate-fade-up flex-col p-5 xl:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[14px] font-semibold text-white">运行状态</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">定时扫描与下载队列的实时情况</p>
            </div>
            <Button variant="primary" size="sm" onClick={onScan} loading={scanning || scanState.scanning}>
              {!(scanning || scanState.scanning) && <IconPlay className="h-3 w-3" />}
              {scanState.scanning ? "扫描中" : "立即扫描"}
            </Button>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
              <div className="flex items-center gap-2 text-[12px] text-slate-400">
                <StatusDot className={scanState.autoScan ? "bg-emerald-400" : "bg-slate-500"} />
                自动扫描
              </div>
              <p className="mt-2 text-[13px] font-medium text-white">
                {scanState.autoScan ? `每 ${scanState.intervalMinutes} 分钟` : "已关闭"}
              </p>
              <div className="mt-1">
                {!auth.authorized ? (
                  <span className="text-[12px] text-warn/80">待登录</span>
                ) : scanState.autoScan ? (
                  <Countdown ts={scanState.nextRunAt} />
                ) : (
                  <span className="text-[12px] text-slate-600">—</span>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
              <div className="flex items-center gap-2 text-[12px] text-slate-400">
                <StatusDot className="bg-brand-400" />
                下载队列
              </div>
              <p className="mt-2 text-[13px] font-medium text-white">
                {scanState.queue.active} 个进行中
              </p>
              <p className="mt-1 text-[12px] text-slate-500">{scanState.queue.waiting} 个等待</p>
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
              <div className="flex items-center gap-2 text-[12px] text-slate-400">
                <StatusDot className={auth.authorized ? "bg-emerald-400" : "bg-amber-400"} />
                Telegram 账号
              </div>
              <p className="mt-2 truncate text-[13px] font-medium text-white">
                {auth.authorized
                  ? auth.me?.username
                    ? `@${auth.me.username}`
                    : auth.me?.firstName || "已登录"
                  : "未登录"}
              </p>
              <button
                onClick={() => onNavigate("settings")}
                className="mt-1 text-[12px] text-brand-400 transition hover:text-brand-300"
              >
                {auth.authorized ? "查看设置" : "前往登录 →"}
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-slate-400">任务完成度</span>
              <span className="font-mono text-slate-300">
                {totals.done}/{totals.total}
                {totals.failed > 0 && <span className="ml-2 text-err">失败 {totals.failed}</span>}
              </span>
            </div>
            <ProgressBar value={doneRatio} className="mt-2.5" />
          </div>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3 text-[11.5px] text-slate-500">
            <span>上次扫描：{formatRelative(scanState.lastScanAt)}</span>
            <span className="flex items-center gap-1.5">
              <IconClock className="h-3 w-3" />
              {!auth.authorized ? (
                "登录后自动开始扫描"
              ) : scanState.autoScan ? (
                <>
                  下次扫描 <Countdown ts={scanState.nextRunAt} />
                </>
              ) : (
                "自动扫描已关闭"
              )}
            </span>
          </div>
        </div>

        <div className="card flex animate-fade-up flex-col p-5" style={{ animationDelay: "60ms" }}>
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-white">最近下载</h2>
            <button
              onClick={() => onNavigate("downloads")}
              className="text-[12px] text-slate-500 transition hover:text-brand-300"
            >
              全部 →
            </button>
          </div>
          <div className="mt-3 space-y-2.5">
            {recentDownloads.length === 0 && (
              <p className="py-8 text-center text-[12.5px] text-slate-600">还没有下载记录</p>
            )}
            {recentDownloads.slice(0, 5).map((item) => {
              const meta = statusMeta(item.status);
              return (
                <div key={item.id} className="flex items-start gap-2.5 rounded-xl border border-transparent p-1.5 transition hover:border-white/[0.06] hover:bg-white/[0.02]">
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${meta.className}`}>
                    <IconFile className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] text-slate-200" title={item.file_name}>
                      {item.file_name}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">
                      {item.channel_title} · {formatBytes(item.file_size)} · {formatRelative(item.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card animate-fade-up p-5" style={{ animationDelay: "100ms" }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold text-white">扫描记录</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">最近 8 次频道扫描结果</p>
          </div>
          <button
            onClick={() => onNavigate("channels")}
            className="text-[12px] text-slate-500 transition hover:text-brand-300"
          >
            管理频道 →
          </button>
        </div>

        {recentRuns.length === 0 ? (
          <EmptyState
            icon={<IconSpark className="h-5 w-5" />}
            title="还没有扫描记录"
            description="添加频道与订阅关键词后，系统会按设定的间隔自动扫描新消息。"
            action={
              <Button variant="primary" size="sm" onClick={() => onNavigate("channels")}>
                添加第一个频道
              </Button>
            }
          />
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.06]">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-white/[0.02] text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">频道</th>
                  <th className="px-3 py-2 font-medium">扫描</th>
                  <th className="px-3 py-2 font-medium">命中</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 text-right font-medium">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {recentRuns.map((run) => {
                  const meta = statusMeta(run.status);
                  return (
                    <tr key={run.id} className="transition hover:bg-white/[0.02]">
                      <td className="max-w-[220px] truncate px-3 py-2.5 text-slate-200">{run.channel_title}</td>
                      <td className="px-3 py-2.5 font-mono text-slate-400">{run.scanned}</td>
                      <td className="px-3 py-2.5 font-mono">
                        <span className={run.matched > 0 ? "text-ok" : "text-slate-500"}>{run.matched}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge className={meta.className}>
                          <StatusDot className={meta.dot} />
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-500">{formatRelative(run.started_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totals.failed > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-4 py-3">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-err" />
          <div className="text-[12.5px] leading-relaxed text-err/90">
            有 {totals.failed} 个任务下载失败，可能是网络波动或文件已被删除。
            <button onClick={() => onNavigate("downloads")} className="ml-1 underline decoration-rose-400/40 underline-offset-2 hover:text-white">
              去查看
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
