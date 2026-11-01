import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { DownloadItem } from "../types";
import { Badge, Button, EmptyState, Modal, ProgressBar, Spinner, StatusDot, useToast } from "../components/ui";
import { PageSizeControl, usePageSize } from "../components/PageSize";
import { Pager, pageCountOf } from "../components/Pager";
import {
  IconDownload,
  IconFile,
  IconMusic,
  IconPause,
  IconPhoto,
  IconPlay,
  IconPriority,
  IconRefresh,
  IconSearch,
  IconStop,
  IconTrash,
  IconVideo,
} from "../components/icons";
import { formatBytes, formatDateTime, formatDuration, formatEta, formatRelative, formatSpeed, statusMeta } from "../utils";

const TABS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部" },
  { key: "downloading", label: "下载中" },
  { key: "queued", label: "排队中" },
  { key: "paused", label: "已暂停" },
  { key: "stopped", label: "已停止" },
  { key: "done", label: "已完成" },
  { key: "failed", label: "失败" },
  { key: "skipped", label: "已跳过" },
];

const DEFAULT_PAGE_SIZE = 30;

function KindIcon({ kind }: { kind: string | null }) {
  const cls = "h-3.5 w-3.5";
  if (kind === "video" || kind === "gif") return <IconVideo className={cls} />;
  if (kind === "photo") return <IconPhoto className={cls} />;
  if (kind === "audio" || kind === "voice") return <IconMusic className={cls} />;
  return <IconFile className={cls} />;
}

const Dot = () => <span className="text-slate-700">·</span>;

/**
 * 下载进度明细：总大小 / 已下载 / 实时速度 / 剩余时间 / 开始与结束的完整时间。
 * 不同状态展示的字段不一样，避免「等待下载」的任务显示不存在的速度。
 */
function DownloadStats({ item }: { item: DownloadItem }) {
  const total = item.file_size > 0 ? item.file_size : 0;
  const downloaded =
    item.status === "done"
      ? total || item.downloaded_bytes || 0
      : Math.min(item.downloaded_bytes ?? 0, total || Number.MAX_SAFE_INTEGER);
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : item.progress;

  if (item.status === "downloading") {
    return (
      <div className="mt-2 max-w-md">
        <ProgressBar value={pct} />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] tabular-nums text-slate-400">
          <span>
            已下载 <span className="text-slate-100">{formatBytes(downloaded)}</span>
            <span className="text-slate-600"> / </span>
            <span className="text-slate-300">{formatBytes(total)}</span>
            <span className="ml-1.5 rounded bg-brand-500/10 px-1 py-0.5 text-[10px] font-medium text-brand-300">
              {pct}%
            </span>
          </span>
          <Dot />
          <span className="text-brand-300">{item.speed_bps ? formatSpeed(item.speed_bps) : "测速中…"}</span>
          <Dot />
          <span>剩余 {item.eta_seconds != null ? formatEta(item.eta_seconds) : "计算中…"}</span>
          {item.started_at && (
            <>
              <Dot />
              <span title="开始下载时间">开始 {formatDateTime(item.started_at)}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  if (item.status === "queued") {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 text-[11px] tabular-nums text-slate-500">
        <span>
          总大小 <span className="text-slate-300">{formatBytes(total)}</span>
        </span>
        <Dot />
        <span className="text-warn/80">等待下载（串行队列）</span>
      </p>
    );
  }

  // 暂停 / 停止：保留中断时的进度，继续后会从头再下一遍（gramjs 不支持断点续传）
  if (item.status === "paused" || item.status === "stopped") {
    return (
      <div className="mt-2 max-w-md">
        <ProgressBar value={pct} />
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] tabular-nums text-slate-500">
          <span>
            已下载 <span className="text-slate-300">{formatBytes(downloaded)}</span>
            <span className="text-slate-600"> / </span>
            <span className="text-slate-400">{formatBytes(total)}</span>
          </span>
          <Dot />
          <span className={item.status === "paused" ? "text-info/80" : "text-err"}>
            {item.status === "paused" ? "已暂停" : "已停止"}
            <span className="text-slate-600">（继续后从头下载）</span>
          </span>
          {item.finished_at && item.status === "stopped" && (
            <>
              <Dot />
              <span>停止于 {formatDateTime(item.finished_at)}</span>
            </>
          )}
        </p>
      </div>
    );
  }

  const elapsed = item.started_at && item.finished_at ? (item.finished_at - item.started_at) / 1000 : null;
  const avgSpeed = elapsed && elapsed > 0 && total > 0 ? total / elapsed : null;

  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] tabular-nums text-slate-500">
      <span>
        总大小 <span className="text-slate-300">{formatBytes(total)}</span>
      </span>
      {(item.status === "failed" || item.status === "skipped") && downloaded > 0 && (
        <>
          <Dot />
          <span>
            已下载 <span className="text-slate-400">{formatBytes(downloaded)}</span>
          </span>
        </>
      )}
      {avgSpeed && (
        <>
          <Dot />
          <span>平均 {formatSpeed(avgSpeed)}</span>
        </>
      )}
      {elapsed !== null && (
        <>
          <Dot />
          <span>用时 {formatDuration(elapsed)}</span>
        </>
      )}
      {item.started_at && (
        <>
          <Dot />
          <span title="开始下载时间">开始 {formatDateTime(item.started_at)}</span>
        </>
      )}
      {item.finished_at && (
        <>
          <Dot />
          <span>
            {item.status === "done" ? "完成" : "结束"} {formatDateTime(item.finished_at)}
          </span>
        </>
      )}
    </p>
  );
}

export default function Downloads() {
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  /** 当前页（从 0 开始） */
  const [page, setPage] = useState(0);
  /** 正在执行的动作，形如 "12:pause"，避免同一行多个按钮同时转圈 */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pageSize, setPageSize] = usePageSize("downloads", DEFAULT_PAGE_SIZE);
  /** 清空弹窗 */
  const [clearOpen, setClearOpen] = useState(false);
  const [clearScope, setClearScope] = useState<"finished" | "all">("finished");
  const [clearPurge, setClearPurge] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [liveSpeed, setLiveSpeed] = useState(0);
  const toast = useToast();
  const queryRef = useRef(query);
  queryRef.current = query;

  const fetchPage = useCallback(
    async (target: number) => {
      const res = await api.downloads({
        status,
        q: queryRef.current.trim(),
        limit: pageSize,
        offset: target * pageSize,
      });
      setTotal(res.total);
      setLiveSpeed(res.queue?.speed ?? 0);
      setItems(res.items);
      // 页码越界（删到最后一页空了、或条数变少）退回最后一页
      const last = pageCountOf(res.total, pageSize) - 1;
      if (target > last) setPage(last);
    },
    [status, pageSize],
  );

  const reload = useCallback(async () => {
    try {
      await fetchPage(page);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [fetchPage, page, toast]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [page, reload]);

  /* 有进行中的任务时自动刷新 */
  const hasActive = useMemo(
    () => items.some((i) => i.status === "downloading" || i.status === "queued"),
    [items],
  );

  useEffect(() => {
    if (!hasActive) return undefined;
    // 下载中的任务 1 秒刷新一次，速度与剩余时间才跟得上
    const timer = window.setInterval(() => {
      void fetchPage(page).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActive, fetchPage, page]);

  const search = () => {
    setLoading(true);
    setPage(0);
    void fetchPage(0).catch((err: Error) => {
      toast.push(err.message, "error");
      setLoading(false);
    });
  };

  const retry = async (item: DownloadItem) => {
    setBusyKey(`${item.id}:retry`);
    try {
      await api.retryDownload(item.id);
      toast.push("已加入下载队列", "success");
      await reload();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusyKey(null);
    }
  };

  /** 队列控制：暂停 / 停止 / 继续 / 插队 */
  const control = async (item: DownloadItem, action: "pause" | "stop" | "resume" | "jump") => {
    setBusyKey(`${item.id}:${action}`);
    try {
      const call = {
        pause: api.pauseDownload,
        stop: api.stopDownload,
        resume: api.resumeDownload,
        jump: api.jumpDownload,
      }[action];
      await call(item.id);
      // 正在跑的任务要等当前分片写完才会真正中断，别把提示写成已经完成
      const running = item.status === "downloading";
      toast.push(
        {
          pause: running ? "正在暂停：当前分片写完即中断" : "已暂停",
          stop: running ? "正在停止：当前分片写完即中断" : "已停止",
          resume: "已继续下载",
          jump: "已插队到队首",
        }[action],
        "success",
      );
      await reload();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (item: DownloadItem) => {
    setBusyKey(`${item.id}:remove`);
    try {
      await api.deleteDownload(item.id, item.status === "done");
      toast.push(item.status === "done" ? "记录与文件已删除" : "记录已删除", "success");
      await reload();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusyKey(null);
    }
  };

  const retryAll = async () => {
    try {
      const res = await api.retryFailed();
      toast.push(`已重新入队 ${res.count} 个任务`, "success");
      await reload();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      const res = await api.clearDownloads(clearScope, clearPurge);
      const parts = [`已清空 ${res.count} 条记录`];
      if (res.purged > 0) parts.push(`删除 ${res.purged} 个文件`);
      if (clearScope === "all" && res.queue.active > 0) parts.push(`${res.queue.active} 个下载中的任务已保留`);
      toast.push(parts.join(" · "), res.count > 0 ? "success" : "info");
      setClearOpen(false);
      setPage(0);
      await fetchPage(0);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setStatus(tab.key);
                setPage(0);
              }}
              className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition ${
                status === tab.key
                  ? "bg-white/[0.08] text-white shadow-sm"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 items-center justify-end gap-2">
          <div className="relative flex-1 sm:max-w-[260px]">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              className="field py-2 pl-8 text-[12.5px]"
              placeholder="搜索文件名 / 关键词 / 频道"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") search();
              }}
            />
          </div>
          <PageSizeControl
            value={pageSize}
            onChange={(n) => {
              setPageSize(n);
              setPage(0);
            }}
          />
          <Button size="sm" onClick={search} title="刷新">
            <IconRefresh className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={retryAll} title="重试所有失败任务">
            重试失败
          </Button>
          <Button size="sm" variant="danger" onClick={() => setClearOpen(true)} title="清空下载记录">
            <IconTrash className="h-3.5 w-3.5" />
            清空
          </Button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5 text-[11.5px] text-slate-500">
          <span>共 {total} 条记录</span>
          {hasActive && (
            <span className="flex items-center gap-1.5 tabular-nums text-brand-300">
              <Spinner className="h-3 w-3" /> 实时刷新中
              {liveSpeed > 0 && <span className="text-brand-200/80">· 当前速度 {formatSpeed(liveSpeed)}</span>}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex h-48 items-center justify-center text-slate-500">
            <Spinner className="h-5 w-5" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconDownload className="h-5 w-5" />}
            title="暂无下载记录"
            description="当频道消息命中订阅关键词后，文件会自动出现在这里。"
          />
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {items.map((item) => {
              const meta = statusMeta(item.status);
              return (
                <div key={item.id} className="flex items-start gap-3 px-4 py-3 transition hover:bg-white/[0.02]">
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${meta.className}`}>
                    <KindIcon kind={item.media_kind} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {(() => {
                      // 封面图下载时是临时名（.art-N.jpg），合成后已删除，展示成可读标签
                      const isArt = Boolean(item.save_name?.startsWith(".art-"));
                      const label = isArt ? "封面图（已合成 poster/landscape/fanart）" : (item.save_name ?? item.file_name);
                      return (
                        <p
                          className={`truncate text-[13px] ${isArt ? "text-slate-400" : "text-slate-100"}`}
                          title={isArt ? item.file_name : label}
                        >
                          {label}
                        </p>
                      );
                    })()}
                      <Badge className={meta.className}>
                        <StatusDot className={meta.dot} />
                        {meta.label}
                      </Badge>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
                      <span className="truncate">{item.channel_title}</span>
                      {item.save_dir && (
                        <>
                          <span className="text-slate-700">·</span>
                          <span
                            className="max-w-[180px] truncate font-mono text-[10.5px] text-slate-400"
                            title={`保存在 ${item.save_dir}/${item.save_name ?? ""}`}
                          >
                            {item.save_dir}/
                          </span>
                        </>
                      )}
                      {item.matched_keyword && (
                        <>
                          <span className="text-slate-700">·</span>
                          <span className="chip !px-1.5 !py-0 text-[10.5px]">{item.matched_keyword}</span>
                        </>
                      )}
                      <span className="text-slate-700">·</span>
                      <span className="tabular-nums" title={`命中/入队于 ${formatRelative(item.created_at)}`}>
                        入队 {formatDateTime(item.created_at)}
                      </span>
                    </p>

                    <DownloadStats item={item} />
                    {item.error && (
                      <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-err/80">{item.error}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    {item.status === "done" && (
                      <a
                        className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                        href={`/api/downloads/${item.id}/file`}
                        download
                      >
                        <IconDownload className="h-3 w-3" />
                        下载
                      </a>
                    )}
                    {(item.status === "failed" || item.status === "skipped") && (
                      <Button size="sm" onClick={() => void retry(item)} loading={busyKey === `${item.id}:retry`}>
                        重试
                      </Button>
                    )}

                    {/* 队列控制：暂停 / 停止 / 继续 / 插队 */}
                    {(item.status === "queued" || item.status === "paused" || item.status === "stopped") && (
                      <Button
                        size="sm"
                        onClick={() => void control(item, "jump")}
                        loading={busyKey === `${item.id}:jump`}
                        title={
                          item.status === "queued"
                            ? "插队：立刻排到队首；若有任务在下载，它会先让位，稍后自动续上"
                            : "继续并插队：立刻排到队首开始下载"
                        }
                      >
                        <IconPriority className="h-3 w-3" />
                        插队
                      </Button>
                    )}
                    {item.status === "downloading" && (
                      <Button
                        size="sm"
                        onClick={() => void control(item, "pause")}
                        loading={busyKey === `${item.id}:pause`}
                        title="暂停：立即中断，已下载进度会保留显示，继续后从头下载"
                      >
                        <IconPause className="h-3 w-3" />
                        暂停
                      </Button>
                    )}
                    {item.status === "queued" && (
                      <Button
                        size="sm"
                        onClick={() => void control(item, "pause")}
                        loading={busyKey === `${item.id}:pause`}
                        title="暂停：移出队列，稍后再继续"
                      >
                        <IconPause className="h-3 w-3" />
                        暂停
                      </Button>
                    )}
                    {(item.status === "downloading" || item.status === "queued" || item.status === "paused") && (
                      <Button
                        size="sm"
                        onClick={() => void control(item, "stop")}
                        loading={busyKey === `${item.id}:stop`}
                        title="停止：结束这个任务，之后可以点「继续」重新下载"
                      >
                        <IconStop className="h-3 w-3" />
                        停止
                      </Button>
                    )}
                    {(item.status === "paused" || item.status === "stopped") && (
                      <Button
                        size="sm"
                        onClick={() => void control(item, "resume")}
                        loading={busyKey === `${item.id}:resume`}
                        title="继续：重新排到队首开始下载（gramjs 不支持断点续传，会从头下）"
                      >
                        <IconPlay className="h-3 w-3" />
                        继续
                      </Button>
                    )}

                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void remove(item)}
                      loading={busyKey === `${item.id}:remove`}
                      title={item.status === "done" ? "删除记录与文件" : "删除记录"}
                    >
                      <IconTrash className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {total > 0 && (
          <Pager
            page={page}
            pageCount={pageCountOf(total, pageSize)}
            total={total}
            unit="条记录"
            onChange={(next) => setPage(next)}
          />
        )}
      </div>

      <Modal
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="清空下载记录"
        description="只删除记录，不会停掉正在进行的下载。选择「全部」时，正在下载的任务会自动保留。"
        width="max-w-md"
        footer={
          <>
            <Button size="sm" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button size="sm" variant="danger" loading={clearing} onClick={() => void clearAll()}>
              确定清空
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {[
            {
              key: "finished" as const,
              label: "只清已结束的记录",
              hint: "完成 / 失败 / 跳过 / 已停止；排队中、暂停中、下载中的都保留",
            },
            { key: "all" as const, label: "清空全部记录", hint: "仅保留「下载中」的任务，其余全部删除" },
          ].map((opt) => (
            <button
              key={opt.key}
              onClick={() => setClearScope(opt.key)}
              className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                clearScope === opt.key
                  ? "border-brand-500/40 bg-brand-500/10"
                  : "border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]"
              }`}
            >
              <span
                className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${
                  clearScope === opt.key ? "border-brand-400 bg-brand-400" : "border-slate-600"
                }`}
              />
              <span>
                <span className="block text-[13px] text-slate-100">{opt.label}</span>
                <span className="mt-0.5 block text-[11.5px] text-slate-500">{opt.hint}</span>
              </span>
            </button>
          ))}

          <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-rose-500"
              checked={clearPurge}
              onChange={(e) => setClearPurge(e.target.checked)}
            />
            <span>
              <span className="block text-[13px] text-slate-100">同时删除磁盘上的文件</span>
              <span className="mt-0.5 block text-[11.5px] text-slate-500">
                只删下载目录内的原文件，Emby 已生成的海报与 nfo 不受影响；无法恢复，请谨慎勾选
              </span>
            </span>
          </label>

          <p className="pt-1 text-[11.5px] text-slate-500">当前筛选下共 {total} 条记录。</p>
        </div>
      </Modal>
    </div>
  );
}
