import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Channel, MessageLog, MessagePreview } from "../types";
import { Badge, Button, EmptyState, Spinner, StatusDot, useToast } from "../components/ui";
import {
  IconClock,
  IconDownload,
  IconFile,
  IconInbox,
  IconMusic,
  IconPhoto,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconVideo,
} from "../components/icons";
import { formatBytes, formatDateTime, formatRelative, logKindMeta } from "../utils";

const TABS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部" },
  { key: "hit", label: "已命中" },
  { key: "filtered", label: "已过滤" },
  { key: "miss", label: "未命中" },
  { key: "empty", label: "空消息" },
];

const PAGE_SIZE = 50;

const KIND_LABEL: Record<string, string> = {
  photo: "图片",
  video: "视频",
  audio: "音频",
  voice: "语音",
  document: "文件",
  gif: "动图",
};

export interface FileEntry {
  kind: string;
  name: string;
  size: number;
}

/** 消息内文件清单（后端存成 JSON） */
function parseFiles(raw: string | null): FileEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FileEntry[]) : [];
  } catch {
    return [];
  }
}

/** 把「1 个视频 + 8 张图片」压成一句：1 视频 · 8 图片 */
function summarizeFiles(files: FileEntry[]): string {
  const tally = new Map<string, number>();
  for (const file of files) tally.set(file.kind, (tally.get(file.kind) ?? 0) + 1);
  return [...tally.entries()]
    .map(([kind, count]) => `${count} ${KIND_LABEL[kind] ?? kind}`)
    .join(" · ");
}

function KindIcon({ kind }: { kind: string | null }) {
  const cls = "h-3.5 w-3.5";
  if (kind === "video" || kind === "gif") return <IconVideo className={cls} />;
  if (kind === "photo") return <IconPhoto className={cls} />;
  if (kind === "audio" || kind === "voice") return <IconMusic className={cls} />;
  if (kind === "document") return <IconFile className={cls} />;
  return <IconInbox className={cls} />;
}

function messageLink(item: MessageLog, channels: Channel[]): string | null {
  if (item.channel_username) return `https://t.me/${item.channel_username}/${item.message_id}`;
  const channel = channels.find((c) => c.id === item.channel_id);
  if (channel?.username) return `https://t.me/${channel.username}/${item.message_id}`;
  if (channel?.tg_id) return `https://t.me/c/${channel.tg_id.replace(/^-100/, "")}/${item.message_id}`;
  return null;
}

export default function Monitor() {
  const [status, setStatus] = useState("all");
  const [channelId, setChannelId] = useState(0);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MessageLog[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({ all: 0 });
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [hover, setHover] = useState<{ item: MessageLog; rect: DOMRect } | null>(null);
  const [preview, setPreview] = useState<MessagePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewCache = useRef(new Map<number, MessagePreview>());
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const hoverId = useRef<number | null>(null);
  const toast = useToast();
  const stateRef = useRef({ status, channelId, query });
  stateRef.current = { status, channelId, query };

  /* 悬停预览：延时 260ms 才弹，避免鼠标划过整列时闪一片 */
  const openPreview = (item: MessageLog, el: HTMLElement) => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      const rect = el.getBoundingClientRect();
      hoverId.current = item.id;
      setHover({ item, rect });
      const cached = previewCache.current.get(item.id);
      if (cached) {
        setPreview(cached);
        setPreviewLoading(false);
        return;
      }
      setPreview(null);
      setPreviewLoading(true);
      void api
        .messagePreview(item.id)
        .then((res) => {
          previewCache.current.set(item.id, res);
          // 鼠标已经移到别的行：结果丢掉，别串台
          if (hoverId.current === item.id) {
            setPreview(res);
            setPreviewLoading(false);
          }
        })
        .catch(() => {
          if (hoverId.current === item.id) {
            setPreview(null);
            setPreviewLoading(false);
          }
        });
    }, 260);
  };

  const scheduleHide = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    showTimer.current = null;
    hideTimer.current = window.setTimeout(() => {
      hoverId.current = null;
      setHover(null);
      setPreview(null);
      hideTimer.current = null;
    }, 180);
  };

  /* 滚动后浮层位置会错，直接收起来 */
  useEffect(() => {
    if (!hover) return undefined;
    const hide = () => {
      hoverId.current = null;
      setHover(null);
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [hover]);

  useEffect(
    () => () => {
      if (showTimer.current !== null) window.clearTimeout(showTimer.current);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const fetchPage = useCallback(async (offset: number, append: boolean, silent = false) => {
    const { status: st, channelId: cid, query: q } = stateRef.current;
    if (!silent) setLoading(!append);
    try {
      const res = await api.messages({
        status: st,
        channelId: cid,
        q: q.trim(),
        limit: PAGE_SIZE,
        offset,
      });
      setTotal(res.total);
      setCounts(res.counts ?? { all: 0 });
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
    } catch (err) {
      if (!silent) toast.push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void api
      .channels()
      .then((res) => setChannels(res.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetchPage(0, false);
  }, [status, channelId, fetchPage]);

  /* 静默轮询：只在停留在第一页时刷新，避免打断已展开的历史 */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (items.length > PAGE_SIZE) return;
      void fetchPage(0, false, true);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [fetchPage, items.length]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      await fetchPage(items.length, true);
    } finally {
      setLoadingMore(false);
    }
  };

  const clearAll = async () => {
    if (!window.confirm("确定清空全部监控记录？此操作不影响已下载的文件。")) return;
    try {
      const res = await api.clearMessages();
      toast.push(`已清空 ${res.count} 条监控记录`, "success");
      await fetchPage(0, false);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  /** 手动补下载：不判断关键词，直接把这天消息里的文件拉下来 */
  const download = async (item: MessageLog) => {
    setBusyId(item.id);
    try {
      const { item: result } = await api.downloadLink({
        channelId: item.channel_id,
        messageId: item.message_id,
      });
      const parts: string[] = [];
      if (result.queued > 0) parts.push(`已入队 ${result.queued} 个文件`);
      if (result.existing > 0) parts.push(`${result.existing} 个之前已下载`);
      if (result.skipped > 0) parts.push(`${result.skipped} 个被大小限制跳过`);
      toast.push(parts.length ? parts.join(" · ") : "没有需要下载的文件", result.queued > 0 ? "success" : "info");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  };

  const activeChannel = useMemo(() => channels.find((c) => c.id === channelId) ?? null, [channels, channelId]);

  return (
    <div className="space-y-4">
      {/* 筛选区 */}
      <div className="card p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] tracking-wide text-slate-500">频道</span>
          <button
            onClick={() => setChannelId(0)}
            className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition ${
              channelId === 0
                ? "bg-white/[0.08] text-white shadow-sm"
                : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
            }`}
          >
            全部频道
          </button>
          {channels.map((channel) => (
            <button
              key={channel.id}
              onClick={() => setChannelId(channel.id)}
              title={channel.title}
              className={`max-w-[220px] truncate rounded-lg px-2.5 py-1 text-[12px] font-medium transition ${
                channelId === channel.id
                  ? "bg-white/[0.08] text-white shadow-sm"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              }`}
            >
              {channel.title}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.05] pt-3">
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
            {TABS.map((tab) => {
              const count = counts[tab.key] ?? 0;
              const active = status === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setStatus(tab.key)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition ${
                    active
                      ? "bg-white/[0.08] text-white shadow-sm"
                      : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                  }`}
                >
                  {tab.label}
                  <span
                    className={`rounded-md px-1 py-px font-mono text-[10.5px] ${
                      active ? "bg-white/10 text-slate-200" : "text-slate-600"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-1 items-center justify-end gap-2">
            <div className="relative flex-1 sm:max-w-[260px]">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                className="field py-2 pl-8 text-[12.5px]"
                placeholder="搜索正文 / 文件名 / 关键词"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void fetchPage(0, false);
                }}
              />
            </div>
            <Button size="sm" onClick={() => void fetchPage(0, false)} title="刷新">
              <IconRefresh className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="danger" onClick={() => void clearAll()} title="清空监控记录">
              <IconTrash className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* 统计条 */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11.5px] text-slate-500">
        <span className="flex items-center gap-2">
          <IconClock className="h-3 w-3" />
          共 {total} 条消息
          {activeChannel && <span className="text-slate-600">· {activeChannel.title}</span>}
        </span>
        <span>
          当前显示 {items.length} 条（每页 {PAGE_SIZE} 条）· 一条消息内的多个文件只算一条
        </span>
      </div>

      {/* 表格 */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-slate-500">
            <Spinner className="h-5 w-5" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconInbox className="h-5 w-5" />}
            title="暂无监控记录"
            description="每次扫描到的消息都会记录在这里，包括未命中关键词的消息，方便你回看为什么没有下载。"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] border-collapse text-left">
              <thead>
                <tr className="border-b border-white/[0.06] text-[11px] tracking-wide text-slate-500">
                  <th className="px-4 py-2.5 font-medium">时间</th>
                  <th className="px-3 py-2.5 font-medium">消息</th>
                  <th className="px-3 py-2.5 font-medium">状态</th>
                  <th className="px-3 py-2.5 font-medium">结果</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {items.map((item) => {
                  const meta = logKindMeta(item.kind);
                  const link = messageLink(item, channels);
                  const isOpen = expanded === item.id;
                  const files = parseFiles(item.file_names);
                  return (
                    <Fragment key={item.id}>
                      <tr className="align-top transition hover:bg-white/[0.02]">
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <span className="font-mono text-[11.5px] text-slate-400" title={formatRelative(item.created_at)}>
                            {formatDateTime(item.created_at)}
                          </span>
                          {item.seen_count > 1 && (
                            <p
                              className="mt-0.5 text-[10.5px] text-slate-600"
                              title={`最近扫描 ${formatDateTime(item.last_seen_at)}`}
                            >
                              重扫 ×{item.seen_count - 1}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="font-mono text-[12px] text-slate-300">#{item.message_id}</p>
                          {channelId === 0 && (
                            <p
                              className="mt-0.5 max-w-[160px] truncate text-[10.5px] text-slate-600"
                              title={item.channel_title}
                            >
                              {item.channel_title}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge className={meta.className}>
                            <StatusDot className={meta.dot} />
                            {meta.label}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {item.matched_keyword && (
                              <span className="chip !px-1.5 !py-0 text-[10.5px]">{item.matched_keyword}</span>
                            )}
                            {item.media_kind && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                                <KindIcon kind={item.media_kind} />
                                {item.file_count > 1
                                  ? `${item.file_count} 个文件`
                                  : (KIND_LABEL[item.media_kind] ?? item.media_kind)}
                              </span>
                            )}
                            {files.length > 1 ? (
                              <span className="text-[11px] text-slate-400">{summarizeFiles(files)}</span>
                            ) : (
                              item.file_name && (
                                <span
                                  className="max-w-[240px] truncate font-mono text-[11px] text-slate-400"
                                  title={item.file_name}
                                >
                                  {item.file_name}
                                </span>
                              )
                            )}
                            {item.file_size > 0 && (
                              <span className="text-[11px] text-slate-600">{formatBytes(item.file_size)}</span>
                            )}
                          </div>
                          <p
                            className="mt-1 line-clamp-2 max-w-[520px] cursor-help text-[11.5px] leading-relaxed text-slate-500 transition hover:text-slate-300"
                            onMouseEnter={(e) => openPreview(item, e.currentTarget)}
                            onMouseLeave={scheduleHide}
                          >
                            {item.excerpt || "（无文本内容）"}
                          </p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              onClick={() => void download(item)}
                              loading={busyId === item.id}
                              disabled={item.file_count === 0 && !item.file_name}
                              title={
                                item.file_count === 0 && !item.file_name
                                  ? "这条消息没有媒体文件"
                                  : "立即下载这条消息里的文件"
                              }
                            >
                              <IconDownload className="h-3 w-3" />
                              下载
                            </Button>
                            <Button size="sm" onClick={() => setExpanded(isOpen ? null : item.id)}>
                              {isOpen ? "收起" : "查看"}
                            </Button>
                            {link ? (
                              <a
                                className="btn-ghost !px-2.5 !py-1.5 !text-[12px]"
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                              >
                                打开
                              </a>
                            ) : (
                              <span className="btn-ghost !cursor-not-allowed !px-2.5 !py-1.5 !text-[12px] !text-slate-600">
                                打开
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr className="bg-white/[0.015]">
                          <td colSpan={5} className="px-4 py-3">
                            <div className="grid grid-cols-1 gap-x-8 gap-y-2 text-[11.5px] sm:grid-cols-2 lg:grid-cols-3">
                              <Detail label="消息 ID" value={`#${item.message_id}`} mono />
                              <Detail label="相册 ID" value={item.grouped_id ?? "—"} mono />
                              <Detail label="频道" value={item.channel_title} />
                              <Detail
                                label="命中关键词"
                                value={item.matched_keyword ?? "—"}
                                highlight={Boolean(item.matched_keyword)}
                              />
                              <Detail label="命中订阅" value={item.subscription_name ?? "—"} />
                              <Detail label="扫描批次" value={item.run_id ? `#${item.run_id}` : "—"} mono />
                              <Detail
                                label="最近扫描"
                                value={item.last_seen_at ? formatDateTime(item.last_seen_at) : formatDateTime(item.created_at)}
                                mono
                              />
                              <Detail label="扫描次数" value={`第 ${item.seen_count || 1} 次`} />
                              <Detail
                                label="消息链接"
                                value={link ?? "（频道无公开用户名，无法生成链接）"}
                                mono
                              />
                              <Detail
                                label="本消息文件"
                                value={
                                  files.length > 1
                                    ? `${files.length} 个（${summarizeFiles(files)}）`
                                    : (item.file_name ?? "无可下载媒体")
                                }
                                mono={files.length <= 1}
                              />
                              <Detail
                                label="总大小"
                                value={item.file_size > 0 ? formatBytes(item.file_size) : "—"}
                              />
                            </div>
                            {files.length > 1 && (
                              <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/20 p-3">
                                <p className="mb-1.5 text-[10.5px] tracking-wide text-slate-500">
                                  消息内文件（这条消息里的 {files.length} 个文件，只算一条记录）
                                </p>
                                <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                                  {files.map((file, index) => (
                                    <li
                                      key={`${file.name}-${index}`}
                                      className="flex items-center gap-2 text-[11.5px] text-slate-400"
                                    >
                                      <KindIcon kind={file.kind} />
                                      <span
                                        className="min-w-0 flex-1 truncate font-mono text-[11px]"
                                        title={file.name}
                                      >
                                        {file.name}
                                      </span>
                                      <span className="shrink-0 text-[10.5px] text-slate-600">
                                        {file.size > 0 ? formatBytes(file.size) : "—"}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/20 p-3">
                              <p className="mb-1.5 text-[10.5px] tracking-wide text-slate-500">完整正文</p>
                              <p className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-300">
                                {item.excerpt || "（无文本内容）"}
                              </p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {items.length < total && (
          <div className="border-t border-white/[0.06] p-3 text-center">
            <Button size="sm" onClick={() => void loadMore()} loading={loadingMore}>
              加载更多（剩余 {total - items.length}）
            </Button>
          </div>
        )}
      </div>

      {hover &&
        createPortal(
          <HoverPreview
            item={hover.item}
            anchor={hover.rect}
            data={preview}
            loading={previewLoading}
            onEnter={() => {
              if (hideTimer.current !== null) {
                window.clearTimeout(hideTimer.current);
                hideTimer.current = null;
              }
            }}
            onLeave={scheduleHide}
          />,
          document.body,
        )}
    </div>
  );
}

/** 监控记录里的正文是「说明 + 文件名」拼起来的，预览时把文件名去掉，只留剧情介绍 */
const FILE_TOKEN_RE =
  /\S+\.(?:jpe?g|png|webp|gif|bmp|mp4|mkv|mov|avi|flv|ts|mp3|m4a|flac|wav|ogg|pdf|zip|rar|7z|txt|srt|ass)\b/gi;

function cleanExcerpt(text: string): string {
  return text
    .replace(FILE_TOKEN_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 悬停浮层：完整正文 + 3 张封面图。
 *
 * 图片优先用「下载时真正挑中的那 3 张」（拼图时复制到 data/covers），
 * 没下载过的消息由后端按需从 Telegram 取前 3 张，并保证之后下载沿用同一组。
 */
function HoverPreview({
  item,
  anchor,
  data,
  loading,
  onEnter,
  onLeave,
}: {
  item: MessageLog;
  anchor: DOMRect;
  data: MessagePreview | null;
  loading: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = Math.min(Math.max(12, anchor.left), Math.max(12, vw - width - 12));
    let top = anchor.bottom + 8;
    if (top + height > vh - 12) {
      const above = anchor.top - height - 8;
      top = above >= 12 ? above : Math.max(12, vh - height - 12);
    }
    setPos({ left, top, ready: true });
  }, [anchor, data, loading]);

  const covers = data?.covers ?? [];
  const source = data?.source ?? "none";
  // 优先用完整正文（列表摘要只有 400 字），接口补到全文后立刻换成全文
  const body = cleanExcerpt(data?.item.full_text || item.full_text || item.excerpt || "") || "（无文本内容）";

  return (
    <div
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        width: 420,
        maxWidth: "calc(100vw - 24px)",
        opacity: pos.ready ? 1 : 0,
        transition: "opacity 120ms ease-out",
      }}
      className="pointer-events-auto z-[80] overflow-hidden rounded-xl border border-white/[0.12] bg-[#11161f] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-3.5 py-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-slate-300">{item.channel_title}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-slate-500">#{item.message_id}</span>
      </div>

      <div className="max-h-[240px] overflow-y-auto px-3.5 py-2.5">
        <p className="whitespace-pre-wrap break-words text-[12px] leading-[1.75] text-slate-300">{body}</p>
      </div>

      <div className="border-t border-white/[0.07] px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center justify-between text-[10.5px] text-slate-500">
          <span>封面图</span>
          <span className="font-mono">
            {loading ? "读取中…" : covers.length ? `${covers.length} 张` : "—"}
          </span>
        </div>
        {loading ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="aspect-[2/3] animate-pulse rounded-lg border border-white/[0.06] bg-white/[0.04]"
                />
              ))}
            </div>
            <p className="mt-2 text-[10.5px] text-slate-600">首次预览正在从 Telegram 取图，之后打开就很快了</p>
          </>
        ) : covers.length ? (
          <div className="grid grid-cols-3 gap-2">
            {covers.map((cover) => (
              <a
                key={cover.file}
                href={cover.url}
                target="_blank"
                rel="noreferrer"
                title={`第 ${cover.index} 张 · 点击查看大图`}
                className="group relative overflow-hidden rounded-lg border border-white/[0.08] bg-black/40"
              >
                <img
                  src={cover.url}
                  alt={`封面 ${cover.index}`}
                  loading="lazy"
                  className="aspect-[2/3] w-full object-cover transition duration-200 group-hover:scale-[1.03]"
                />
                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 font-mono text-[9.5px] text-slate-300">
                  {cover.index}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-white/[0.08] px-3 py-3 text-center text-[11px] text-slate-500">
            {data?.note ?? "这条记录没有可预览的图片"}
          </p>
        )}
        {covers.length > 0 && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-slate-600">
            {source === "download"
              ? "下载时实际用作 Emby 封面的 3 张原图"
              : "原消息里的图片，下载做封面时会沿用同样这 3 张"}
          </p>
        )}
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="w-[76px] shrink-0 text-slate-600">{label}</span>
      <span
        className={`min-w-0 flex-1 break-all ${mono ? "font-mono" : ""} ${
          highlight ? "text-emerald-300" : "text-slate-300"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
