import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ManualHistoryItem, ManualKind, ManualStatus } from "../types";
import { Badge, Button, EmptyState, Modal, StatusDot, useToast } from "./ui";
import { Pager, pageCountOf } from "./Pager";
import { IconClock, IconDownload, IconSearch, IconTrash } from "./icons";
import { formatDateTime, formatRelative, formatTime } from "../utils";

/**
 * 列表里的时间：一小时以内说人话（刚刚 / N 分钟前），再早的直接给
 * 「11-03 20:41」——回查的时候精确时间比「3 天前」有用。
 */
function timeLabel(ts: number): string {
  return Date.now() - ts < 3_600_000 ? formatRelative(ts) : formatTime(ts);
}

/** 状态徽章：颜色和「本次解析」列表对齐，一眼能分清成功 / 没入队 / 失败 */
const STATUS_META: Record<ManualStatus, { label: string; className: string; dot: string }> = {
  ok: { label: "已入队", className: "border-emerald-500/20 bg-emerald-500/10 text-ok", dot: "bg-emerald-400" },
  existing: { label: "之前下过", className: "border-white/10 bg-white/5 text-slate-400", dot: "bg-slate-500" },
  empty: { label: "没入队", className: "border-amber-500/25 bg-amber-500/10 text-warn", dot: "bg-amber-400" },
  error: { label: "失败", className: "border-rose-500/20 bg-rose-500/10 text-err", dot: "bg-rose-400" },
  cancel: { label: "已取消", className: "border-white/10 bg-white/5 text-slate-400", dot: "bg-slate-500" },
};

// 徽章颜色只用主题变量（brand / violet / info / ok / warn / err / slate）：
// Tailwind 原生的 text-sky-200、text-fuchsia-200 在浅色主题下会白得看不清
const KIND_META: Record<ManualKind, { label: string; className: string }> = {
  telegram: { label: "Telegram", className: "border-sky-500/25 bg-sky-500/10 text-info" },
  platform: { label: "第三方平台", className: "border-violet-500/25 bg-violet-500/10 text-violet-300" },
  web: { label: "网页 / m3u8", className: "border-brand-500/25 bg-brand-500/10 text-brand-300" },
};

const PLATFORM_LABEL: Record<string, string> = {
  bilibili: "B站",
  xiaohongshu: "小红书",
  youtube: "YouTube",
};

/** 筛选分档：成功 = 真的入队过；没成功 = 失败 / 没内容 / 取消 */
const FILTERS: Array<{ key: string; label: string; status: string }> = [
  { key: "all", label: "全部", status: "" },
  { key: "ok", label: "成功", status: "ok,existing" },
  { key: "fail", label: "失败", status: "error" },
  { key: "other", label: "未入队", status: "empty,cancel" },
];

const PAGE_SIZE = 20;

/**
 * 手动下载提交记录。
 *
 * 数据由服务端在 POST /api/downloads/link、POST /api/platform/task 里写，
 * 所以刷新页面、换浏览器、甚至用手机提交的记录都在。version 变化时重新拉一次。
 */
export function ManualHistory({
  version,
  onReuse,
}: {
  /** 父组件每提交完一轮 +1，用来触发刷新 */
  version: number;
  /** 点「再提交」把链接塞回上面的输入框 */
  onReuse?: (link: string) => void;
}) {
  const [items, setItems] = useState<ManualHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();

  // 搜索框防抖，避免每敲一个字都打一次接口
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(q.trim());
      setPage(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  const status = useMemo(() => FILTERS.find((f) => f.key === filter)?.status ?? "", [filter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.manualHistory({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, status, q: search });
      setItems(res.items);
      setTotal(res.total);
      setSummary(res.summary ?? {});
      // 删到当前页空了就自动回退一页，避免停在空白页
      if (res.items.length === 0 && page > 0) setPage((p) => Math.max(0, p - 1));
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [page, status, search, toast]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const clear = async (scope: "all" | "error") => {
    try {
      const res = await api.manualClear(scope);
      toast.push(`已清空 ${res.count} 条记录`, "success");
      setConfirmClear(false);
      setPage(0);
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  const removeOne = async (id: number) => {
    try {
      await api.manualDelete(id);
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  const counts = {
    ok: summary.ok ?? 0,
    existing: summary.existing ?? 0,
    empty: summary.empty ?? 0,
    error: summary.error ?? 0,
    cancel: summary.cancel ?? 0,
  };
  const allCount = counts.ok + counts.existing + counts.empty + counts.error + counts.cancel;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-400">
            <IconClock className="h-3.5 w-3.5" />
          </span>
          <div>
            <h3 className="text-[13px] font-medium text-slate-100">提交记录</h3>
            <p className="text-[10.5px] text-slate-500">
              每提交一条链接就留一行，链接 / 时间 / 结果 / 失败原因都在，刷新页面也不会丢
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setFilter(f.key);
                setPage(0);
              }}
              className={`rounded-lg border px-2 py-[3px] text-[11px] transition ${
                filter === f.key
                  ? "border-brand-500/40 bg-brand-500/15 text-brand-200"
                  : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:text-slate-200"
              }`}
            >
              {f.label}
            </button>
          ))}
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
            <input
              className="field !w-[150px] !py-1 !pl-6 text-[11.5px]"
              placeholder="搜链接 / 标题"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Button size="sm" variant="ghost" disabled={allCount === 0} onClick={() => setConfirmClear(true)}>
            <IconTrash className="h-3.5 w-3.5" />
            清空
          </Button>
        </div>
      </div>

      {allCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.04] bg-white/[0.015] px-4 py-2 text-[11px] text-slate-500">
          <span>
            共 <span className="text-slate-300">{allCount}</span> 条
          </span>
          <span className="text-slate-700">·</span>
          <span className="text-ok">已入队 {counts.ok}</span>
          {counts.existing > 0 && <span>之前下过 {counts.existing}</span>}
          {counts.empty > 0 && <span className="text-warn/80">没入队 {counts.empty}</span>}
          {counts.error > 0 && <span className="text-err/80">失败 {counts.error}</span>}
          {counts.cancel > 0 && <span>取消 {counts.cancel}</span>}
          {loading && <span className="text-slate-600">刷新中…</span>}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<IconDownload className="h-5 w-5" />}
          title={allCount === 0 ? "还没有提交记录" : "没有符合筛选条件的记录"}
          description={
            allCount === 0
              ? "在上面粘贴 Telegram 消息链接或 B站 / 小红书 / YouTube 视频链接后点「开始下载」，这里会按时间倒序列出每一条的链接与结果。也可以用手机把链接发给 Telegram 机器人。"
              : "换个筛选条件，或清空搜索框再看。"
          }
        />
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {items.map((item) => {
            const meta = STATUS_META[item.status] ?? STATUS_META.empty;
            const kind = KIND_META[item.kind] ?? KIND_META.web;
            return (
              <div key={item.id} className="group px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="shrink-0 font-mono text-[11px] tabular-nums text-slate-500"
                    title={formatDateTime(item.created_at)}
                  >
                    {timeLabel(item.created_at)}
                  </span>
                  <Badge className={meta.className}>
                    <StatusDot className={meta.dot} />
                    {meta.label}
                  </Badge>
                  {item.kind === "platform" && item.platform ? (
                    <Badge className={kind.className}>{PLATFORM_LABEL[item.platform] ?? item.platform}</Badge>
                  ) : (
                    <Badge className={kind.className}>{kind.label}</Badge>
                  )}
                  <a
                    className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-400 transition hover:text-brand-300"
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    title={item.link}
                  >
                    {item.link}
                  </a>
                  {onReuse && (
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-white/[0.08] px-1.5 py-[2px] text-[10.5px] text-slate-500 opacity-0 transition hover:text-brand-300 group-hover:opacity-100"
                      onClick={() => onReuse(item.link)}
                      title="把这条链接填回上面的输入框"
                    >
                      再提交
                    </button>
                  )}
                  <button
                    type="button"
                    className="shrink-0 rounded-md p-1 text-slate-600 opacity-0 transition hover:text-err group-hover:opacity-100"
                    onClick={() => void removeOne(item.id)}
                    title="删除这条记录"
                    aria-label={`删除记录 ${item.link}`}
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                  </button>
                </div>

                {(item.title || item.note) && (
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                    {item.title && (
                      <span className="min-w-0 truncate text-slate-300" title={item.title}>
                        {item.title}
                      </span>
                    )}
                    {item.title && item.note && <span className="text-slate-700">·</span>}
                    {item.note && (
                      <span className="truncate font-mono text-[10.5px] text-slate-500" title={item.note}>
                        {item.note}
                      </span>
                    )}
                  </p>
                )}

                {item.error && (
                  <p className="mt-1 break-words text-[11px] leading-relaxed text-err/80">{item.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {total > PAGE_SIZE && (
        <Pager
          page={page}
          pageCount={pageCountOf(total, PAGE_SIZE)}
          total={total}
          onChange={setPage}
          hint={`每页 ${PAGE_SIZE} 条，按提交时间倒序`}
        />
      )}

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="清空提交记录？"
        description="只删这份历史列表，已经下载的文件和下载队列都不受影响。"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
              取消
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void clear("error")}>
              只清失败与未入队
            </Button>
            <Button size="sm" variant="danger" onClick={() => void clear("all")}>
              全部清空
            </Button>
          </>
        }
      >
        <p className="text-[12px] leading-relaxed text-slate-400">
          当前共 {allCount} 条记录（已入队 {counts.ok} · 之前下过 {counts.existing} · 没入队 {counts.empty} · 失败{" "}
          {counts.error} · 取消 {counts.cancel}）。清空后不可恢复。
        </p>
      </Modal>
    </section>
  );
}
