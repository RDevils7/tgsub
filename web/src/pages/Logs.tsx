import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { LogEntry, LogLevel } from "../types";
import { Badge, Button, EmptyState, Modal, Spinner, useToast } from "../components/ui";
import { PageSizeControl, usePageSize } from "../components/PageSize";
import { Pager, pageCountOf } from "../components/Pager";
import { IconDownload, IconRefresh, IconSearch, IconTrash } from "../components/icons";
import { formatBytes, formatDateTime } from "../utils";

const DEFAULT_PAGE_SIZE = 50;

const LEVELS: Array<{ key: LogLevel | "all"; label: string }> = [
  { key: "all", label: "全部" },
  { key: "error", label: "错误" },
  { key: "warn", label: "警告" },
  { key: "info", label: "信息" },
  { key: "debug", label: "调试" },
  { key: "trace", label: "追踪" },
];

/** 各级别的配色：跟随主题，用 Tailwind 的语义色 */
const LEVEL_STYLE: Record<LogLevel, { chip: string; text: string; bar: string }> = {
  trace: { chip: "bg-slate-500/15 text-slate-400", text: "text-slate-400", bar: "bg-slate-500/60" },
  debug: { chip: "bg-sky-500/15 text-sky-400", text: "text-sky-400", bar: "bg-sky-500/60" },
  info: { chip: "bg-brand-500/15 text-brand-300", text: "text-brand-300", bar: "bg-brand-400/70" },
  warn: { chip: "bg-amber-500/15 text-amber-400", text: "text-amber-400", bar: "bg-amber-400/70" },
  error: { chip: "bg-rose-500/15 text-rose-400", text: "text-rose-400", bar: "bg-rose-500/70" },
  fatal: { chip: "bg-red-500/20 text-red-400", text: "text-red-400", bar: "bg-red-500/80" },
};

/** 只显示几个关键字段，其余折叠进「详情」 */
const KEY_FIELDS = ["err", "code", "dcId", "fp", "path", "status", "method", "userId", "reason"];

function summarize(entry: LogEntry): string {
  const parts: string[] = [];
  for (const key of KEY_FIELDS) {
    const value = entry.fields[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      parts.push(`${key}=${value}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(" · ");
}

export default function Logs() {
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [fileSize, setFileSize] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [pageSize, setPageSize] = usePageSize("logs", DEFAULT_PAGE_SIZE);
  const toast = useToast();
  /** 已加载的最早时间戳：自动刷新时只拉更新的，避免整页跳动 */
  const newestRef = useRef<number>(0);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      try {
        const res = await api.logs({
          level,
          q: search,
          limit: pageSize,
          offset: page * pageSize,
        });
        setItems(res.items);
        setTotal(res.total);
        setCounts(res.counts);
        setFileSize(res.fileSize);
        if (res.items.length > 0) {
          newestRef.current = Math.max(...res.items.map((i) => i.time));
        }
      } catch (err) {
        if (!opts.silent) toast.push((err as Error).message, "error");
      } finally {
        setLoading(false);
      }
    },
    [level, search, page, pageSize, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 自动刷新：只在停留在第一页时刷新，避免用户翻页时被拽回去
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      if (page !== 0) return;
      void load({ silent: true });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load, page]);

  const doClear = async () => {
    setClearing(true);
    try {
      await api.logsClear();
      newestRef.current = 0;
      setClearOpen(false);
      toast.push("日志已清空", "success");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setClearing(false);
    }
  };

  const download = () => {
    window.open("/api/logs/download", "_blank");
  };

  const pageCount = useMemo(() => pageCountOf(total, pageSize), [total, pageSize]);

  const levelCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of LEVELS) {
      map[item.key] = item.key === "all" ? total : (counts[item.key] ?? 0);
    }
    return map;
  }, [counts, total]);

  return (
    <div className="card overflow-hidden">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {LEVELS.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                setLevel(item.key);
                setPage(0);
              }}
              className={`rounded-lg px-2.5 py-1 text-[12px] transition-colors ${
                level === item.key
                  ? "bg-white/[0.09] font-medium text-white"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              }`}
            >
              {item.label}
              <span className="ml-1.5 font-mono text-[10.5px] text-slate-500">
                {levelCounts[item.key] ?? 0}
              </span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <form
            className="relative"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(keyword.trim());
              setPage(0);
            }}
          >
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              className="field !w-[190px] !pl-8"
              placeholder="搜索日志内容…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </form>

          <Button
            size="sm"
            onClick={() => {
              setSearch(keyword.trim());
              setPage(0);
            }}
          >
            <IconSearch className="h-3.5 w-3.5" />
            搜索
          </Button>

          <Button size="sm" onClick={() => void load()} loading={loading && items.length === 0}>
            {!loading && <IconRefresh className="h-3.5 w-3.5" />}
            刷新
          </Button>

          <Button size="sm" onClick={download} title="下载完整日志文件">
            <IconDownload className="h-3.5 w-3.5" />
            下载
          </Button>

          <Button size="sm" variant="danger" onClick={() => setClearOpen(true)}>
            <IconTrash className="h-3.5 w-3.5" />
            清空
          </Button>
        </div>
      </div>

      {/* 说明条 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-white/[0.06] px-4 py-2 text-[11.5px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            className="h-3 w-3 accent-brand-500"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          每 5 秒自动刷新
        </span>
        <span>日志文件：{formatBytes(fileSize)}</span>
        <span className="text-slate-600">
          文件位于数据目录 logs/app.log，超过 10MB 自动轮转，重启后仍可查看
        </span>
      </div>

      {/* 日志列表 */}
      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-slate-500">
          <Spinner />
          加载中…
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="暂无日志" description="没有匹配的日志记录" />
      ) : (
        <div className="max-h-[calc(100vh-330px)] min-h-[300px] overflow-y-auto">
          {items.map((entry, index) => {
            const style = LEVEL_STYLE[entry.level] ?? LEVEL_STYLE.info;
            const summary = summarize(entry);
            const extra = Object.entries(entry.fields).filter(
              ([k]) => !KEY_FIELDS.includes(k),
            );
            const open = expanded === index;
            return (
              <div
                key={`${entry.time}-${index}`}
                className="group border-b border-white/[0.04] px-4 py-2.5 transition-colors hover:bg-white/[0.02]"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase ${style.chip}`}
                  >
                    {entry.level}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-500">
                    {formatDateTime(entry.time)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[12.5px] leading-relaxed ${style.text}`}>{entry.msg}</p>
                    {summary && (
                      <p className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-slate-500">
                        {summary}
                      </p>
                    )}
                    {open && extra.length > 0 && (
                      <pre className="mt-2 overflow-x-auto rounded-lg border border-white/[0.06] bg-black/20 p-2.5 text-[11px] leading-relaxed text-slate-400">
                        {extra.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}
                      </pre>
                    )}
                  </div>
                  {extra.length > 0 && (
                    <button
                      onClick={() => setExpanded(open ? null : index)}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 opacity-0 transition-opacity hover:text-slate-300 group-hover:opacity-100"
                    >
                      {open ? "收起" : "详情"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-2.5">
        <PageSizeControl value={pageSize} onChange={(size) => {
          setPageSize(size);
          setPage(0);
        }} />
        <Pager
          page={page}
          pageCount={pageCount}
          total={total}
          unit="条"
          onChange={setPage}
        />
      </div>

      <Modal
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="清空日志"
        footer={
          <>
            <Button size="sm" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button size="sm" variant="danger" loading={clearing} onClick={() => void doClear()}>
              确认清空
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-slate-300">
          将清空内存中的日志缓冲与磁盘上的 <code className="text-slate-400">logs/app.log</code>。
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
          清空后无法恢复。排障期间建议先「下载」留一份存档。
        </p>
      </Modal>
    </div>
  );
}
