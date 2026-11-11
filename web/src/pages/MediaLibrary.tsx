import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { MediaEpisode, MediaHwInfo, MediaLibraryResponse, MediaSeries, MediaSeriesResponse } from "../types";
import { Button, EmptyState, Modal, Spinner, useToast } from "../components/ui";
import { VideoPlayer } from "../components/VideoPlayer";
import { safeStorageGet, safeStorageSet, safeStorageRemove } from "../utils";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCpu,
  IconDownload,
  IconFolder,
  IconImage,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconSpark,
  IconTv,
  IconVideo,
} from "../components/icons";
import { formatBytes, formatDateTime, formatDuration, formatRelative } from "../utils";

/**
 * 媒体库 —— 仿现代化播放器（SenPlayer / Hills / Infuse 一类）的浏览方式：
 *
 *   目录 → 沉浸式 Hero + 海报墙 + 横向片架 → 剧集详情（背景主视觉 + 选集卡片）→ 影院式播放
 *
 * 数据全部来自磁盘上的 NFO / 封面槽位；播放走 /api/media/stream，
 * 能原生播的按 Range 直出（可拖进度条），容器不兼容的由服务端用 ffmpeg 换封装。
 *
 * 视觉约定：
 * - Hero 是**独立深色卡片**，浅色主题下也不变白，所以压图的白字一律写死 `text-[#fff]`
 *   （主题自适应的 `text-white` 在浅色主题下会变成深色，压在黑遮罩上就看不见了）。
 * - 其余部分全部用主题变量（slate / brand / panel），亮暗两套都要好看。
 */

const DIR_STORAGE_KEY = "tgsub.media.dir";
const SORT_STORAGE_KEY = "tgsub.media.sort";
const EPVIEW_STORAGE_KEY = "tgsub.media.epview";
/**
 * 「浏览器自己解 HEVC」的开关（存本机）。
 *
 * 默认值不再写死「开」：
 * - 浏览器真能解 HEVC（Safari、装了 HEVC 扩展 / 带硬解的 Edge）→ 默认直连，省显卡；
 * - 解不了（多数 Windows / Linux 上的 Chrome）→ 默认关，交给服务端显卡转码。
 * 用户手动点过就以他存的值为准（`"1"` / `"0"`）。
 */
const HEVC_STORAGE_KEY = "tgsub.media.hevc";

/** 这台浏览器能不能自己解 HEVC（Safari / 带硬解的 Edge 返回 "probably"） */
function browserCanPlayHevc(): boolean {
  try {
    const probe = document.createElement("video");
    return (
      probe.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== "" ||
      probe.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== ""
    );
  } catch {
    return false;
  }
}

type SortKey = "updated" | "name";
type EpView = "grid" | "list";

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 面包屑：相对「下载根」拆段；不在下载根之下时只显示最后两段 */
function breadcrumbOf(home: string, dir: string): Array<{ label: string; path: string }> {
  const h = normalizePath(home);
  const d = normalizePath(dir);
  if (!h) return [];
  if (d === h) return [];
  if (d.startsWith(`${h}/`)) {
    const parts = d.slice(h.length + 1).split("/").filter(Boolean);
    const out: Array<{ label: string; path: string }> = [];
    let acc = h;
    for (const part of parts) {
      acc = `${acc}/${part}`;
      out.push({ label: part, path: acc });
    }
    return out;
  }
  const parts = d.split("/").filter(Boolean);
  const tail = parts.slice(-2);
  const out: Array<{ label: string; path: string }> = [];
  let acc = d.slice(0, d.length - tail.join("/").length).replace(/\/+$/, "");
  for (const part of tail) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** 来源徽章文案 */
const ORIGIN_LABEL: Record<string, string> = {
  telegram: "Telegram",
  bilibili: "B站",
  xiaohongshu: "小红书",
  youtube: "YouTube",
  m3u8: "网页",
  manual: "外部",
  other: "外部",
};

function resolutionLabel(height: number | null): string | null {
  if (!height) return null;
  if (height >= 2000) return "4K";
  if (height >= 1000) return "1080P";
  if (height >= 700) return "720P";
  return `${height}P`;
}

function episodeCode(ep: MediaEpisode): string {
  if (ep.season != null && ep.episode != null) {
    return `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
  }
  if (ep.episode != null) return `第 ${ep.episode} 集`;
  return "—";
}

/** NFO 里可能夹着 CDATA 容器或 HTML 标签（抓取工具写的），显示前压成一行干净文本 */
function cleanText(raw: string | null | undefined): string {
  const text = String(raw ?? "");
  if (!text) return "";
  return text
    .replace(/<!\s*\[+CDATA\s*\[+/gi, "")
    .replace(/\]\]\s*>+/g, "")
    .replace(/<\/?[a-z][\w:-]*(?:\s[^>]*)?\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 参数小胶囊：卡片底部那一排「1080P / 190 MB / HEVC」 */
function MetaChip({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10.5px] tabular-nums ring-1 ring-inset ring-white/[0.07] ${
        strong ? "font-medium text-slate-300" : "text-slate-400"
      }`}
    >
      {children}
    </span>
  );
}

/** 覆在图片上的玻璃小标签（Hero / 海报 / 选集卡共用） */
function GlassTag({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-[#fff]/15 bg-black/55 px-2 py-0.5 text-[10.5px] font-medium text-[#fff]/90 backdrop-blur-md ${className}`}
    >
      {children}
    </span>
  );
}

/** 中央播放按钮：hover 时从图片里浮出来 */
function PlayOverlay({ large = false }: { large?: boolean }) {
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15 opacity-0 transition duration-200 group-hover:opacity-100">
      <span
        className={`flex items-center justify-center rounded-full bg-brand-gradient text-[#fff] shadow-glow transition duration-200 ${
          large ? "h-14 w-14" : "h-11 w-11"
        }`}
      >
        <IconPlay className={large ? "h-5 w-5" : "h-4 w-4"} />
      </span>
    </span>
  );
}

/** 无封面时的占位（不要在暗色 Hero 上用主题色，直接写死深色系） */
function ArtPlaceholder({ title, className = "" }: { title: string; className?: string }) {
  return (
    <div className={`flex h-full w-full flex-col items-center justify-center gap-2 bg-ink-800 px-3 text-center ${className}`}>
      <IconImage className="h-7 w-7 text-slate-600" />
      <span className="line-clamp-2 text-[11px] leading-tight text-slate-500">{title}</span>
    </div>
  );
}

/** 分区标题 */
function SectionTitle({
  title,
  count,
  hint,
  extra,
}: {
  title: string;
  count?: number | string;
  hint?: string;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[14px] font-semibold tracking-tight text-slate-100">{title}</h2>
        {count !== undefined && <span className="text-[11px] tabular-nums text-slate-500">{count} 部</span>}
      </div>
      <div className="flex items-center gap-3">
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
        {extra}
      </div>
    </div>
  );
}

/** 网格 / 列表视图切换的小图标（只为这一页服务，不污染公共图标库） */
function GridGlyph({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.3" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.3" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.3" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.3" />
    </svg>
  );
}

function ListGlyph({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="2" width="13" height="3" rx="1.2" />
      <rect x="1.5" y="6.5" width="13" height="3" rx="1.2" />
      <rect x="1.5" y="11" width="13" height="3" rx="1.2" />
    </svg>
  );
}

/** 首屏骨架屏：Hero + 一排海报，避免只有一行「读取中」的空白感 */
function LibrarySkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="skeleton h-10 w-48" />
        <div className="skeleton h-9 w-64 rounded-full" />
      </div>
      <div className="skeleton h-[264px] w-full rounded-[26px]" />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))] sm:[grid-template-columns:repeat(auto-fill,minmax(166px,1fr))]">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="skeleton aspect-[2/3] rounded-2xl" />
            <div className="skeleton h-3 w-4/5" />
            <div className="skeleton h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MediaLibrary() {
  const toast = useToast();
  const [dir, setDir] = useState<string>(() => safeStorageGet(DIR_STORAGE_KEY));
  const [aiEnriching, setAiEnriching] = useState(false);
  const [listing, setListing] = useState<MediaLibraryResponse | null>(null);
  const [seriesView, setSeriesView] = useState<MediaSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>(() => (safeStorageGet(SORT_STORAGE_KEY) as SortKey) || "updated");
  const [epView, setEpView] = useState<EpView>(() => (safeStorageGet(EPVIEW_STORAGE_KEY) === "list" ? "list" : "grid"));
  // 未设置过：浏览器自己能解 HEVC 就默认直连，否则交给服务端显卡转码
  const [hevc, setHevc] = useState(() => {
    const saved = safeStorageGet(HEVC_STORAGE_KEY);
    if (saved === "0" || saved === "1") return saved === "1";
    return browserCanPlayHevc();
  });
  /** 服务端硬件解码能力（列表 / 剧集接口都会带回来） */
  const [hw, setHw] = useState<MediaHwInfo | null>(null);
  /**
   * 列表加载要读这个开关，但**不能把它放进依赖**：依赖里带 hevc 的话，
   * 一开开关就会跑一遍列表加载，而列表加载会清掉剧集视图 —— 人直接被踢回海报墙。
   * 用 ref 拿当前值，切换时自己决定是重拉剧集还是重扫列表。
   */
  const hevcRef = useRef(hevc);
  const searchRef = useRef<HTMLInputElement>(null);
  // 这两个放进 ref：列表加载的 useEffect 不该因为 toast 对象变化而重跑
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** 媒体目录不可写时只提醒一次，别每切一次目录都弹 */
  const nfoFailedNotified = useRef(false);
  /** localStorage 里记着的目录失效时，只自动回落下载根一次 */
  const rootFallbackTried = useRef(false);
  const [playing, setPlaying] = useState<{ episode: MediaEpisode; list: MediaEpisode[]; index: number } | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [heroBusy, setHeroBusy] = useState(false);
  /** 进入剧集前所在的目录：返回时回到这里，而不是剧集的父目录 */
  const [returnDir, setReturnDir] = useState("");

  /** 输入停顿 300ms 再过滤，避免每个键都重排整个网格 */
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  /** 按 `/` 直接聚焦搜索框、Esc 清空（输入框里不抢键；播放器打开时不抢） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      // 播放器 / 浏览目录这类弹窗打开时不抢键：`/` 会去聚焦背后的搜索框
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && searchInput) {
        setSearchInput("");
        setSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchInput]);

  /** 拉一个目录（不传就是下载根） */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void api
      .mediaLibrary(dir || undefined, hevcRef.current)
      .then((res) => {
        if (!alive) return;
        setListing(res);
        setHw(res.hw ?? null);
        // 目录变了（或第一次进来）就清掉剧集视图
        setSeriesView(null);
        if (res.dir) {
          setDir(res.dir);
          safeStorageSet(DIR_STORAGE_KEY, res.dir);
        }
        // 选中目录后自动给所有缺 NFO 的 strm 补单集 NFO。
        // 纯本地写盘（不解析直链、不抽帧、不回源），后台跑完再轻提示，不阻塞首屏。
        void api
          .mediaEnsureStrmNfo(res.dir)
          .then((summary) => {
            if (!alive) return;
            if (summary.created > 0) {
              toastRef.current.push(`已为 ${summary.created} 个 strm 生成单集 NFO`, "success");
            }
            if (summary.failed > 0 && !nfoFailedNotified.current) {
              nfoFailedNotified.current = true;
              toastRef.current.push(`${summary.failed} 个 strm 的 NFO 写入失败：检查媒体目录的写权限`, "error");
            }
          })
          .catch(() => undefined);
        if (res.isSeries) {
          // 直接落在剧集目录（比如启动时记着上次的位置）→ 返回键回到它的父目录
          setReturnDir(normalizePath(res.dir).split("/").slice(0, -1).join("/"));
          void api
            .mediaSeries(res.dir, hevcRef.current)
            .then((detail) => {
              if (!alive) return;
              setSeriesView(detail);
              if (detail.hw) setHw(detail.hw);
            })
            .catch((err) => {
              if (alive) setError((err as Error).message);
            });
        }
      })
      .catch((err) => {
        if (!alive) return;
        setListing(null);
        const status = (err as { status?: number }).status;
        // 浏览器里记着上次的位置；换了机器/容器、或目录被删之后会一直 403/404。
        // 只自动回落一次，别把真正的网络故障也悄悄吞掉。
        if (dir && (status === 403 || status === 404) && !rootFallbackTried.current) {
          rootFallbackTried.current = true;
          safeStorageRemove(DIR_STORAGE_KEY);
          toastRef.current.push("上次记住的目录已不可用，已回到下载目录", "info");
          setDir("");
          return;
        }
        setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dir, reloadToken]);

  /** 用 AI 给当前目录里「有 NFO 但没简介」的 strm 补媒体信息 */
  const aiEnrichCurrent = async () => {
    if (!dir || aiEnriching) return;
    setAiEnriching(true);
    try {
      const summary = await api.mediaAiEnrichStrmNfo(dir);
      if (summary.enriched > 0) {
        toastRef.current.push(`AI 已为 ${summary.enriched} 个媒体补全简介 / 类型 / 标签`, "success");
      } else {
        toastRef.current.push("没有需要补全的媒体（已有简介或无需处理）", "info");
      }
      if (summary.failed > 0) {
        toastRef.current.push(`${summary.failed} 个写入失败，检查媒体目录写权限`, "error");
      }
    } catch (err) {
      toastRef.current.push((err as Error).message, "error");
    } finally {
      setAiEnriching(false);
    }
  };

  const openSeries = (target: MediaSeries) => {
    // 记住是从哪个目录点进来的
    if (listing?.dir) setReturnDir(listing.dir);
    setLoading(true);
    setError(null);
    void api
      .mediaSeries(target.dir, hevcRef.current)
      .then((detail) => {
        setSeriesView(detail);
        if (detail.hw) setHw(detail.hw);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  const goDir = (next: string) => {
    setSeriesView(null);
    setSearchInput("");
    setSearch("");
    setDir(next);
  };

  const backToList = () => {
    if (seriesView) {
      setSeriesView(null);
      setDir(returnDir || listing?.dir || listing?.home || "");
      return;
    }
    goDir(listing?.parent ?? listing?.home ?? "");
  };

  const crumbs = useMemo(
    () => (listing ? breadcrumbOf(listing.home, listing.dir) : []),
    [listing],
  );

  const visibleSeries = useMemo(() => {
    if (!listing) return [];
    const keyword = search.toLowerCase();
    const list = keyword
      ? listing.series.filter((item) => item.title.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword))
      : [...listing.series];
    return list.sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title, "zh-CN", { numeric: true })
        : b.updatedAt - a.updatedAt,
    );
  }, [listing, search, sort]);

  /** 搜索也覆盖散装视频；注意播放时要用这份「过滤后」的数组当下标基准 */
  const visibleLoose = useMemo(() => {
    if (!listing) return [];
    const keyword = search.toLowerCase();
    return keyword
      ? listing.loose.filter((ep) => ep.title.toLowerCase().includes(keyword) || ep.name.toLowerCase().includes(keyword))
      : [...listing.loose];
  }, [listing, search]);

  const changeSort = (next: SortKey) => {
    setSort(next);
    safeStorageSet(SORT_STORAGE_KEY, next);
  };

  const changeEpView = (next: EpView) => {
    setEpView(next);
    safeStorageSet(EPVIEW_STORAGE_KEY, next);
  };

  /**
   * 切「HEVC 直连」：只影响播放方式，不能把人踢出剧集页 ——
   * 所以在剧集页里就地重拉详情，在列表页才整体重扫。
   */
  const changeHevc = (next: boolean) => {
    hevcRef.current = next;
    setHevc(next);
    safeStorageSet(HEVC_STORAGE_KEY, next ? "1" : "0");
    if (seriesView) {
      const target = seriesView.dir;
      setLoading(true);
      void api
        .mediaSeries(target, next)
        .then((detail) => {
          setSeriesView(detail);
          if (detail.hw) setHw(detail.hw);
        })
        .catch((err) => setError((err as Error).message))
        .finally(() => setLoading(false));
      return;
    }
    setReloadToken((n) => n + 1);
  };

  /** 剧集视图里点某一集播放 */
  const playEpisode = (episodes: MediaEpisode[], index: number) => {
    const episode = episodes[index];
    if (!episode) return;
    if (episode.playMode === "unsupported") {
      toast.push(
        `这个文件是 ${episode.videoCodec?.toUpperCase() ?? "未知编码"}，浏览器解不了、服务端也没有可用的显卡转码，` +
          `可以点左下角「下载」用本地播放器看`,
        "error",
      );
      return;
    }
    setPlaying({ episode, list: episodes, index });
  };

  /** Hero 上「立即播放」：列表接口没有分集，临时拉一次详情再播第一集 */
  const playSeries = async (target: MediaSeries) => {
    setHeroBusy(true);
    try {
      const detail = await api.mediaSeries(target.dir, hevcRef.current);
      if (detail.hw) setHw(detail.hw);
      const index = detail.episodes.findIndex((ep) => ep.playMode !== "unsupported");
      if (index < 0) {
        toast.push("这部剧里的视频浏览器都解不了，服务端也没有可用的显卡转码，可以先下载到本地看", "error");
        return;
      }
      playEpisode(detail.episodes, index);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setHeroBusy(false);
    }
  };

  const featured = !search && !seriesView ? visibleSeries[0] ?? null : null;

  /* ------------------------------ 加载态 ------------------------------ */

  if (loading && !listing) return <LibrarySkeleton />;

  /* -------------------------------- 页面 -------------------------------- */

  return (
    <div className="space-y-5 pb-6">
      {/* 顶部：标题 + 全局操作 + 位置面包屑 */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-[#fff] shadow-glow">
              <IconTv className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-[19px] font-semibold leading-tight tracking-tight text-slate-100">媒体库</h1>
              <p className="text-[11px] text-slate-500">
                本地片库 · {visibleSeries.length} 部剧集
                {visibleLoose.length > 0 && ` · ${visibleLoose.length} 个视频`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                ref={searchRef}
                className="field w-44 rounded-full py-1.5 pl-8 pr-8 text-[12.5px] sm:w-56"
                placeholder="搜索剧名 / 视频"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-white/[0.1] bg-white/[0.05] px-1 text-[10px] text-slate-500 sm:block">
                /
              </kbd>
            </div>

            {!seriesView && (
              <div className="flex items-center gap-0.5 rounded-full border border-white/[0.07] bg-white/[0.03] p-0.5">
                {(
                  [
                    ["updated", "最近更新"],
                    ["name", "名称"],
                  ] as Array<[SortKey, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => changeSort(key)}
                    className={`rounded-full px-2.5 py-1 text-[11.5px] transition ${
                      sort === key ? "bg-brand-gradient text-[#fff]" : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* 显卡能力：部署在有核显的 NAS 上时，浏览器解不了的编码由它转码 */}
            {hw && (
              <span
                className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11.5px] sm:flex ${
                  hw.available
                    ? "border-emerald-500/25 bg-emerald-500/[0.1] text-ok"
                    : "border-white/[0.07] bg-white/[0.02] text-slate-500"
                }`}
                title={
                  hw.available
                    ? `服务端硬件解码可用（${hw.label}）：HEVC 等浏览器解不了的编码会用显卡实时转码`
                    : `没有可用的硬件解码：${hw.reason ?? "未检测到显卡"}。HEVC 等编码只能下载到本地播放`
                }
              >
                <IconCpu className="h-3.5 w-3.5" />
                {hw.available ? `硬解 · ${hw.accel === "software" ? "CPU" : (hw.accel ?? "GPU").toUpperCase()}` : "无硬解"}
              </span>
            )}

            <button
              onClick={() => changeHevc(!hevc)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11.5px] transition ${
                hevc
                  ? "border-amber-500/30 bg-amber-500/[0.12] text-warn"
                  : "border-white/[0.07] bg-white/[0.02] text-slate-500 hover:border-white/[0.14] hover:text-slate-300"
              }`}
              title={
                hevc
                  ? "HEVC 直连：浏览器自己解，不占显卡（Safari / 带硬解的浏览器才放得出来）。解不了就关掉它，改走显卡转码"
                  : hw?.available
                    ? "关：HEVC 等编码交给服务端显卡转码成 H.264；开：浏览器自己直接解 HEVC"
                    : "开：让浏览器直接试播 HEVC（没有显卡转码时只能这样试）；关：标成播不了"
              }
            >
              <IconVideo className="h-3.5 w-3.5" />
              HEVC 直连
              <span className={`h-1.5 w-1.5 rounded-full ${hevc ? "bg-amber-400" : "bg-slate-600"}`} />
            </button>

            {dir && (
              <button
                onClick={() => void aiEnrichCurrent()}
                disabled={aiEnriching}
                className="flex items-center gap-1.5 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/[0.1] px-2.5 py-1.5 text-[11.5px] text-fuchsia-200 transition hover:border-fuchsia-500/50 hover:text-fuchsia-100 disabled:opacity-50"
                title="用 AI 根据剧名补全简介 / 类型 / 标签（只补没有简介的 NFO；需先在设置页启用 AI）"
              >
                {aiEnriching ? <Spinner className="h-3.5 w-3.5" /> : <IconSpark className="h-3.5 w-3.5" />}
                AI 补全简介
              </button>
            )}

            <button
              onClick={() => setBrowseOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[11.5px] text-slate-300 transition hover:border-white/[0.14] hover:text-slate-100"
              title="选择要展示的目录"
            >
              <IconFolder className="h-3.5 w-3.5 text-brand-300" />
              选择目录
              <IconChevronDown className="h-3 w-3 text-slate-500" />
            </button>

            <Button size="sm" onClick={() => setReloadToken((n) => n + 1)} title="重新扫描目录">
              <IconRefresh className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
        </div>

        <nav className="flex min-w-0 flex-wrap items-center gap-1 text-[11.5px] text-slate-500">
          <button
            onClick={() => goDir(listing?.home ?? "")}
            className="flex items-center gap-1 rounded-lg bg-white/[0.04] px-2 py-1 transition hover:bg-white/[0.08] hover:text-slate-300"
            title="回到下载目录"
          >
            <IconFolder className="h-3 w-3" />
            下载目录
          </button>
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <IconChevronRight className="h-3 w-3 text-slate-600" />
              <button
                onClick={() => goDir(crumb.path)}
                className={`max-w-[14rem] truncate rounded px-1 py-0.5 hover:bg-white/[0.06] hover:text-slate-300 ${
                  i === crumbs.length - 1 ? "text-slate-300" : ""
                }`}
                title={crumb.path}
              >
                {crumb.label}
              </button>
            </span>
          ))}
          {seriesView && (
            <span className="flex items-center gap-1">
              <IconChevronRight className="h-3 w-3 text-slate-600" />
              <span className="max-w-[16rem] truncate px-1 text-slate-200">{seriesView.series.title}</span>
            </span>
          )}
        </nav>
      </header>

      {error && (
        <p className="flex items-start gap-1.5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.08] px-3.5 py-2.5 text-[12px] leading-relaxed text-warn">
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {seriesView ? (
        <SeriesView
          detail={seriesView}
          hevc={hevc}
          epView={epView}
          onEpViewChange={changeEpView}
          onBack={backToList}
          onPlay={(index) => playEpisode(seriesView.episodes, index)}
        />
      ) : (
        <LibraryGrid
          listing={listing}
          series={visibleSeries}
          loose={visibleLoose}
          search={search}
          loading={loading}
          featured={featured}
          heroBusy={heroBusy}
          onOpen={openSeries}
          onPlaySeries={(item) => void playSeries(item)}
          onPlayLoose={(ep) => playEpisode(visibleLoose, visibleLoose.findIndex((item) => item.path === ep.path))}
        />
      )}

      {playing && (
        <PlayerDialog
          episode={playing.episode}
          hasPrev={playing.index > 0}
          hasNext={playing.index < playing.list.length - 1}
          onPrev={() => playEpisode(playing.list, playing.index - 1)}
          onNext={() => playEpisode(playing.list, playing.index + 1)}
          onClose={() => setPlaying(null)}
          onPosterSaved={(thumbUrl) => {
            // 弹窗里立刻换海报，同时刷一次列表，卡片上的封面也跟着更新
            setPlaying((prev) =>
              prev
                ? {
                    ...prev,
                    episode: { ...prev.episode, thumbUrl },
                    list: prev.list.map((ep) => (ep.path === prev.episode.path ? { ...ep, thumbUrl } : ep)),
                  }
                : prev,
            );
            setReloadToken((n) => n + 1);
          }}
        />
      )}

      {browseOpen && (
        <BrowseDialog
          start={listing?.dir ?? ""}
          onClose={() => setBrowseOpen(false)}
          onPick={(picked) => {
            setBrowseOpen(false);
            // 挑中的目录可能在下载根之外：先登记成媒体来源，再拉列表。
            // 已经在范围内的目录服务端会直接返回 created=false，不会写垃圾记录。
            void api
              .mediaAddRoot(picked)
              .then((res) => {
                if (res.created) {
                  toastRef.current.push(`已把 ${picked} 登记为媒体目录`, "success");
                }
                goDir(picked);
              })
              .catch((err) => {
                toastRef.current.push(`无法打开这个目录：${(err as Error).message}`, "error");
              });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 海报墙 + Hero + 横向片架                                            */
/* ------------------------------------------------------------------ */

function LibraryGrid({
  listing,
  series,
  loose,
  search,
  loading,
  featured,
  heroBusy,
  onOpen,
  onPlaySeries,
  onPlayLoose,
}: {
  listing: MediaLibraryResponse | null;
  series: MediaSeries[];
  loose: MediaEpisode[];
  search: string;
  loading: boolean;
  featured: MediaSeries | null;
  heroBusy: boolean;
  onOpen: (item: MediaSeries) => void;
  onPlaySeries: (item: MediaSeries) => void;
  onPlayLoose: (ep: MediaEpisode) => void;
}) {
  if (!listing) return null;

  const empty = series.length === 0 && loose.length === 0;
  /**
   * Hero 背景分三档：横版剧照最好；只有竖版海报时**放大虚化**当氛围底（直接把 2:3 拉成横条会糊着脸）；
   * 什么都没有才用网格底纹。
   */
  const backdrop = featured?.landscapeUrl ?? null;
  const ambient = !backdrop ? (featured?.posterUrl ?? null) : null;

  return (
    <div className="space-y-6">
      {/* 焦点推荐：最近更新的一部剧，直接给「立即播放」 */}
      {featured && (
        <section className="relative isolate overflow-hidden rounded-[26px] border border-[#fff]/10 bg-[#080d16] shadow-card">
          <div className="absolute inset-0">
            {backdrop ? (
              <img src={backdrop} alt="" className="h-full w-full scale-105 object-cover object-center opacity-75" />
            ) : ambient ? (
              <>
                <img
                  src={ambient}
                  alt=""
                  className="h-full w-full scale-150 object-cover object-[center_28%] opacity-55 blur-2xl saturate-150"
                />
                <div className="h-full w-full bg-grid-fade opacity-45" />
              </>
            ) : (
              <div className="h-full w-full bg-grid-fade opacity-80" />
            )}
            <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-brand-500/25 blur-3xl" />
            <div className="absolute inset-0 media-hero-shade" />
          </div>

          <div className="relative flex min-h-[248px] flex-col justify-end gap-5 p-5 sm:min-h-[276px] sm:flex-row sm:items-end sm:justify-between sm:p-7">
            <div className="max-w-2xl flex-1 space-y-3 text-[#fff]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-brand-gradient px-2.5 py-1 text-[10.5px] font-medium text-[#fff] shadow-glow">
                  最近更新
                </span>
                <span className="text-[11px] text-[#fff]/65">{ORIGIN_LABEL[featured.origin] ?? "外部"}</span>
                {featured.rating != null && <span className="text-[11px] text-amber-300">★ {featured.rating.toFixed(1)}</span>}
              </div>
              <h2 className="line-clamp-2 text-[26px] font-semibold leading-tight tracking-tight drop-shadow sm:text-[30px]">
                {featured.title}
              </h2>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#fff]/72">
                {featured.year && <span className="tabular-nums">{featured.year}</span>}
                <span>{featured.episodeCount} 集</span>
                <span>{formatBytes(featured.totalSize)}</span>
                {featured.genres.length > 0 && <span>{featured.genres.slice(0, 3).join(" / ")}</span>}
                <span className="text-[#fff]/45">更新于 {formatDateTime(featured.updatedAt)}</span>
              </div>
              <p className="line-clamp-2 max-w-xl text-[12.5px] leading-relaxed text-[#fff]/68">
                {featured.overview?.trim() || "这部剧还没有简介，点「查看分集」看每一集，或去元数据页补一份。"}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                <button
                  onClick={() => onPlaySeries(featured)}
                  disabled={heroBusy}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-gradient px-4 py-2 text-[13px] font-medium text-[#fff] shadow-glow transition hover:brightness-110 active:scale-[0.98] disabled:opacity-60"
                >
                  {heroBusy ? <Spinner className="h-3.5 w-3.5" /> : <IconPlay className="h-3.5 w-3.5" />}
                  立即播放
                </button>
                <button
                  onClick={() => onOpen(featured)}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#fff]/25 bg-[#fff]/10 px-4 py-2 text-[13px] font-medium text-[#fff] backdrop-blur-md transition hover:bg-[#fff]/20"
                >
                  查看分集
                  <IconChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="hidden w-[118px] shrink-0 sm:block">
              <div className="aspect-[2/3] overflow-hidden rounded-2xl bg-[#0d1520] shadow-2xl ring-1 ring-[#fff]/15">
                {featured.posterUrl ? (
                  <img src={featured.posterUrl} alt={featured.title} className="h-full w-full object-cover" />
                ) : (
                  <ArtPlaceholder title={featured.title} className="bg-[#0d1520]" />
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {empty ? (
        <div className="card">
          <EmptyState
            icon={<IconImage className="h-5 w-5" />}
            title={search ? "没有匹配的内容" : "这个目录里还没有视频"}
            description={
              search
                ? "换个关键词试试，或者清空搜索看全部。"
                : "下载完成的视频会出现在这里；也可以点右上角「选择目录」换一个已经在用的媒体目录。"
            }
          />
        </div>
      ) : (
        <>
          {series.length > 0 && (
            <section className="space-y-3">
              <SectionTitle
                title={search ? `「${search}」的搜索结果` : "剧集"}
                count={series.length}
                hint={loading ? "读取中…" : "点封面进入分集"}
              />
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))] sm:[grid-template-columns:repeat(auto-fill,minmax(166px,1fr))]">
                {series.map((item) => (
                  <article key={item.dir} className="group">
                    <button onClick={() => onOpen(item)} className="block w-full text-left" title={item.title}>
                      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-ink-800 shadow-card ring-1 ring-white/[0.08] transition duration-300 group-hover:-translate-y-1 group-hover:shadow-glow group-hover:ring-brand-500/50">
                        {item.posterUrl ? (
                          <img
                            src={item.posterUrl}
                            alt={item.title}
                            loading="lazy"
                            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.06]"
                          />
                        ) : (
                          <ArtPlaceholder title={item.title} />
                        )}
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-black/45 to-transparent" />
                        <div className="absolute left-2 top-2">
                          <GlassTag>{item.episodeCount} 集</GlassTag>
                        </div>
                        <div className="absolute right-2 top-2">
                          <GlassTag>{ORIGIN_LABEL[item.origin] ?? "外部"}</GlassTag>
                        </div>
                        <PlayOverlay large />
                      </div>
                      {/* 标题放图下：海报本身通常自带片名，别再压一层重复文字 */}
                      <p className="mt-2 truncate text-[12.5px] font-medium text-slate-100 transition group-hover:text-brand-300">
                        {item.title}
                      </p>
                      <p className="truncate text-[10.5px] tabular-nums text-slate-500">
                        {[item.year ? String(item.year) : null, `${item.episodeCount} 集`, formatBytes(item.totalSize)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}

          {/* 目录里直接放的视频：横向片架，不占海报墙的位置 */}
          {loose.length > 0 && (
            <section className="space-y-3">
              <SectionTitle title="散装视频" hint={`${loose.length} 个 · 横向滚动，点击直接播放`} />
              <div className="no-scrollbar -mx-1 flex snap-x snap-mandatory gap-3.5 overflow-x-auto px-1 pb-2">
                {loose.map((ep) => (
                  <button
                    key={ep.path}
                    onClick={() => onPlayLoose(ep)}
                    className="group w-[228px] shrink-0 snap-start text-left sm:w-[258px]"
                    title={ep.name}
                  >
                    <div className="relative aspect-video overflow-hidden rounded-2xl bg-ink-800 shadow-card ring-1 ring-white/[0.08] transition duration-300 group-hover:-translate-y-1 group-hover:shadow-glow group-hover:ring-brand-500/50">
                      {ep.thumbUrl ? (
                        <img
                          src={ep.thumbUrl}
                          alt={ep.title}
                          loading="lazy"
                          className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.06]"
                        />
                      ) : (
                        <ArtPlaceholder title={ep.title} />
                      )}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-black/45 to-transparent" />
                      {ep.durationSec != null && (
                        <span className="absolute right-2 top-2 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[#fff] backdrop-blur-md">
                          {formatDuration(ep.durationSec)}
                        </span>
                      )}
                      <PlayOverlay />
                    </div>
                    <p className="mt-1.5 truncate text-[12px] font-medium text-slate-100 transition group-hover:text-brand-300">
                      {ep.title}
                    </p>
                    <p className="truncate text-[10.5px] tabular-nums text-slate-500">
                      {[resolutionLabel(ep.height), formatBytes(ep.size)].filter(Boolean).join(" · ")}
                    </p>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 剧集详情：背景主视觉 + 选集（网格 / 列表）                          */
/* ------------------------------------------------------------------ */

function SeriesView({
  detail,
  hevc,
  epView,
  onEpViewChange,
  onBack,
  onPlay,
}: {
  detail: MediaSeriesResponse;
  /** 这台浏览器开了「HEVC 强制尝试」：分集表里标「试播」的那些就是靠它才可播 */
  hevc: boolean;
  epView: EpView;
  onEpViewChange: (next: EpView) => void;
  onBack: () => void;
  onPlay: (index: number) => void;
}) {
  const { series, episodes } = detail;
  const playable = episodes.findIndex((ep) => ep.playMode !== "unsupported");
  const backdrop = series.landscapeUrl || episodes.find((ep) => ep.thumbUrl)?.thumbUrl || series.posterUrl || null;

  return (
    <div className="space-y-6">
      {/* 主视觉 */}
      <section className="relative isolate overflow-hidden rounded-[26px] border border-[#fff]/10 bg-[#080d16] shadow-card">
        <div className="absolute inset-0">
          {backdrop ? (
            <img src={backdrop} alt="" className="h-full w-full scale-105 object-cover object-center opacity-75" />
          ) : (
            <div className="h-full w-full bg-grid-fade opacity-80" />
          )}
          <div className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-violet-500/25 blur-3xl" />
          <div className="absolute inset-0 media-hero-shade" />
        </div>

        <button
          onClick={onBack}
          className="absolute left-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-full border border-[#fff]/20 bg-black/40 px-3 py-1.5 text-[12px] font-medium text-[#fff] backdrop-blur-md transition hover:bg-black/60 sm:left-6 sm:top-6"
        >
          <IconChevronLeft className="h-3.5 w-3.5" />
          返回目录
        </button>

        <div className="relative flex flex-col gap-5 p-5 pt-16 sm:flex-row sm:items-end sm:p-7 sm:pt-20">
          <div className="hidden w-[132px] shrink-0 sm:block">
            <div className="aspect-[2/3] overflow-hidden rounded-2xl bg-[#0d1520] shadow-2xl ring-1 ring-[#fff]/15">
              {series.posterUrl ? (
                <img src={series.posterUrl} alt={series.title} className="h-full w-full object-cover" />
              ) : (
                <ArtPlaceholder title={series.title} className="bg-[#0d1520]" />
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-3 text-[#fff]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[#fff]/20 bg-[#fff]/10 px-2.5 py-0.5 text-[10.5px] text-[#fff]/85 backdrop-blur-md">
                {ORIGIN_LABEL[series.origin] ?? "外部"}
              </span>
              {series.hasNfo ? (
                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-0.5 text-[10.5px] text-emerald-200">
                  已生成 NFO
                </span>
              ) : (
                <span className="rounded-full border border-[#fff]/15 bg-[#fff]/5 px-2.5 py-0.5 text-[10.5px] text-[#fff]/60">
                  无 NFO
                </span>
              )}
              {series.rating != null && <span className="text-[12px] text-amber-300">★ {series.rating.toFixed(1)}</span>}
            </div>

            <h2 className="line-clamp-2 text-[26px] font-semibold leading-tight tracking-tight drop-shadow sm:text-[32px]">
              {series.title}
            </h2>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#fff]/72">
              {series.year && <span className="tabular-nums">{series.year}</span>}
              <span>{episodes.length} 集</span>
              <span>{formatBytes(series.totalSize)}</span>
              {series.genres.length > 0 && <span>{series.genres.slice(0, 3).join(" / ")}</span>}
              <span className="text-[#fff]/45">最近更新 {formatDateTime(series.updatedAt)}</span>
            </div>

            <p className="line-clamp-3 max-w-3xl text-[12.5px] leading-relaxed text-[#fff]/68">
              {series.overview?.trim() || "这部剧还没有简介，可以去元数据页补一份。"}
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-1.5">
              {playable >= 0 && (
                <button
                  onClick={() => onPlay(playable)}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-gradient px-4 py-2 text-[13px] font-medium text-[#fff] shadow-glow transition hover:brightness-110 active:scale-[0.98]"
                >
                  <IconPlay className="h-3.5 w-3.5" />
                  播放第 {episodes[playable].episode ?? playable + 1} 集
                </button>
              )}
              <span className="text-[11px] text-[#fff]/50">
                {hevc ? "HEVC 试播已开启，标「试播」的集取决于这台浏览器的解码器" : "点任意一集直接播放"}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 选集 */}
      <section className="space-y-3">
        <SectionTitle
          title="选集"
          hint={`共 ${episodes.length} 集`}
          extra={
            <div className="flex items-center gap-0.5 rounded-full border border-white/[0.07] bg-white/[0.03] p-0.5">
              {(
                [
                  ["grid", <GridGlyph key="g" />, "网格视图"],
                  ["list", <ListGlyph key="l" />, "列表视图"],
                ] as Array<[EpView, ReactNode, string]>
              ).map(([key, glyph, label]) => (
                <button
                  key={key}
                  onClick={() => onEpViewChange(key)}
                  title={label}
                  aria-label={label}
                  className={`rounded-full p-1.5 transition ${
                    epView === key ? "bg-brand-gradient text-[#fff]" : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {glyph}
                </button>
              ))}
            </div>
          }
        />

        {episodes.length === 0 ? (
          <div className="card px-4 py-10 text-center text-[12px] text-slate-500">这个目录里没有视频文件。</div>
        ) : epView === "grid" ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(296px,1fr))]">
            {episodes.map((ep, index) => (
              <EpisodeCard key={ep.path} ep={ep} index={index} onPlay={() => onPlay(index)} />
            ))}
          </div>
        ) : (
          <div className="card divide-y divide-white/[0.05] overflow-hidden">
            {episodes.map((ep, index) => (
              <EpisodeRow key={ep.path} ep={ep} onPlay={() => onPlay(index)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** 网格视图的一集：大图 + 集号 + 简介 + 参数 */
function EpisodeCard({ ep, index, onPlay }: { ep: MediaEpisode; index: number; onPlay: () => void }) {
  const unsupported = ep.playMode === "unsupported";
  const res = resolutionLabel(ep.height);
  const plot = cleanText(ep.plot);
  return (
    <button
      onClick={onPlay}
      className={`group group/ep flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-panel/75 text-left shadow-card transition duration-300 hover:-translate-y-1 hover:border-brand-500/40 hover:shadow-glow ${
        unsupported ? "opacity-70" : ""
      }`}
      title={unsupported ? `${ep.videoCodec ?? "该编码"} 浏览器不支持` : ep.name}
    >
      <div className="relative aspect-video shrink-0 overflow-hidden bg-ink-800">
        {ep.thumbUrl ? (
          <img
            src={ep.thumbUrl}
            alt={ep.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover/ep:scale-[1.05]"
          />
        ) : (
          <ArtPlaceholder title={ep.title} />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
        <div className="absolute left-2 top-2">
          <GlassTag className="font-mono">{episodeCode(ep)}</GlassTag>
        </div>
        {unsupported && (
          <div className="absolute right-2 top-2">
            <GlassTag className="border-amber-400/40 bg-amber-500/25">播不了</GlassTag>
          </div>
        )}
        {ep.playMode === "transcode" && (
          <div className="absolute right-2 top-2">
            <GlassTag className="border-emerald-400/35 bg-emerald-500/25">显卡转码</GlassTag>
          </div>
        )}
        {ep.trial && !unsupported && (
          <div className="absolute right-2 top-2">
            <GlassTag className="border-amber-400/40 bg-amber-500/20">试播</GlassTag>
          </div>
        )}
        {ep.durationSec != null && (
          <span className="absolute bottom-2 right-2 rounded-lg bg-black/65 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[#fff] backdrop-blur">
            {formatDuration(ep.durationSec)}
          </span>
        )}
        <PlayOverlay />
      </div>

      {/* 文字区：标题最多两行、简介固定三行高度，同一排卡片永远对得齐 */}
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-start gap-2">
          <span className="mt-[1px] shrink-0 rounded-md bg-brand-500/[0.12] px-1.5 py-[1px] font-mono text-[10.5px] font-medium tabular-nums text-brand-300 ring-1 ring-inset ring-brand-500/25">
            #{String(index + 1).padStart(2, "0")}
          </span>
          <p className="line-clamp-2 text-[13px] font-medium leading-snug text-slate-100 transition group-hover/ep:text-brand-300">
            {ep.title}
          </p>
        </div>
        <p
          title={plot || undefined}
          className={`line-clamp-3 min-h-[3.9em] text-[12px] leading-relaxed ${
            plot ? "text-slate-400" : "text-slate-600"
          }`}
        >
          {plot || "这一集还没有简介，可以去元数据页补一份。"}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
          {res && <MetaChip strong>{res}</MetaChip>}
          <MetaChip>{formatBytes(ep.size)}</MetaChip>
          {ep.videoCodec && <MetaChip strong>{ep.videoCodec.toUpperCase()}</MetaChip>}
          <span className="ml-auto whitespace-nowrap text-[10.5px] tabular-nums text-slate-500">
            {formatRelative(ep.updatedAt)}
          </span>
        </div>
      </div>
    </button>
  );
}

/** 列表视图的一集：信息密度高，适合集数多的剧 */
function EpisodeRow({ ep, onPlay }: { ep: MediaEpisode; onPlay: () => void }) {
  const unsupported = ep.playMode === "unsupported";
  const res = resolutionLabel(ep.height);
  const plot = cleanText(ep.plot);
  return (
    <button
      onClick={onPlay}
      className={`group/ep flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-white/[0.04] ${
        unsupported ? "opacity-70" : ""
      }`}
      title={unsupported ? `${ep.videoCodec ?? "该编码"} 浏览器不支持` : ep.name}
    >
      <span className="relative block aspect-video w-[116px] shrink-0 overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/[0.06] sm:w-[136px]">
        {ep.thumbUrl ? (
          <img
            src={ep.thumbUrl}
            alt={ep.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover/ep:scale-[1.04]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-slate-600">
            <IconVideo className="h-5 w-5" />
          </span>
        )}
        {ep.durationSec != null && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] font-medium tabular-nums text-[#fff]">
            {formatDuration(ep.durationSec)}
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-[#fff]/90 backdrop-blur transition group-hover/ep:scale-110 group-hover/ep:bg-brand-500/85">
            {unsupported ? <IconAlert className="h-3.5 w-3.5" /> : <IconPlay className="h-3.5 w-3.5" />}
          </span>
        </span>
      </span>

      <span className="min-w-0 flex-1 pt-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-400">
            {episodeCode(ep)}
          </span>
          <span className="truncate text-[13px] font-medium text-slate-100">{ep.title}</span>
          {unsupported && <span className="text-[10.5px] text-warn">浏览器不支持 {ep.videoCodec?.toUpperCase()}</span>}
          {ep.playMode === "transcode" && (
            <span
              className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-ok"
              title="浏览器解不了这个编码，播放时由服务端显卡实时转码成 H.264"
            >
              显卡转码
            </span>
          )}
          {ep.trial && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-warn" title="HEVC：靠这台浏览器的解码器播">
              试播
            </span>
          )}
        </span>
        {plot && <span className="mt-1 line-clamp-2 block text-[11.5px] leading-relaxed text-slate-400">{plot}</span>}
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {res && <MetaChip strong>{res}</MetaChip>}
          <MetaChip>{formatBytes(ep.size)}</MetaChip>
          {ep.videoCodec && <MetaChip strong>{ep.videoCodec.toUpperCase()}</MetaChip>}
          {ep.width && ep.height ? (
            <MetaChip>
              {ep.width}×{ep.height}
            </MetaChip>
          ) : null}
        </span>
      </span>

      <span className="hidden shrink-0 pt-1 text-[10.5px] text-slate-600 sm:block">{formatRelative(ep.updatedAt)}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 播放：影院式弹窗                                                    */
/* ------------------------------------------------------------------ */

/** 播放弹窗里的「本集简介」：默认两行，长了手动展开，别让玩家去猜省略号后面是什么 */
function EpisodeOverview({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > 84;
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3.5 py-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-medium tracking-wide text-slate-500">本集简介</span>
        {long && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand-300 transition hover:text-brand-200"
          >
            {open ? "收起" : "展开"}
            <IconChevronDown className={`h-3 w-3 transition ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
      <p className={`text-[12.5px] leading-relaxed text-slate-400 ${open || !long ? "" : "line-clamp-2"}`}>{text}</p>
    </div>
  );
}

function PlayerDialog({
  episode,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onPosterSaved,
}: {
  episode: MediaEpisode;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onPosterSaved: (thumbUrl: string) => void;
}) {
  const toast = useToast();
  const [failed, setFailed] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [poster, setPoster] = useState(episode.thumbUrl);

  useEffect(() => {
    setFailed(null);
    setRetryKey(0);
    setPoster(episode.thumbUrl);
  }, [episode.path]);

  /**
   * 封面来自播放器里已经解码的那一帧，保存时顺带补一份单集 NFO。
   * 自动截用 overwrite=false（已有封面就不动），手动挑画面用 true。
   */
  const savePoster = useCallback(
    async (dataUrl: string, overwrite: boolean): Promise<boolean> => {
      try {
        const result = await api.mediaSavePoster(episode.path, dataUrl, overwrite);
        setPoster(result.thumbUrl);
        onPosterSaved(result.thumbUrl);
        if (overwrite) {
          toast.push(result.nfoCreated ? "封面已更新，并生成了单集 NFO" : "封面已更新", "success");
        } else if (result.posterCreated) {
          toast.push(result.nfoCreated ? "已自动截取封面并生成单集 NFO" : "已自动截取封面", "success");
        }
        return true;
      } catch (err) {
        // 自动截取失败别打扰播放；手动覆盖必须给反馈
        if (overwrite) toast.push(`封面保存失败：${(err as Error).message}`, "error");
        return false;
      }
    },
    [episode.path, onPosterSaved, toast],
  );

  /** `[` / `]` 切集：不用左右方向键，那是 <video> 自己拖进度用的 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (e.key === "[" && hasPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "]" && hasNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext, onPrev, onNext]);

  const remux = episode.playMode === "remux";
  const transcode = episode.playMode === "transcode";
  /** 实时流（换封装 / 转码）：没有 Content-Length，跳转只能重开一路流 —— 见 VideoPlayer */
  const seekable = remux || transcode;

  const errorCopy = () => {
    const codec = episode.videoCodec?.toUpperCase() ?? "";
    if (episode.isStrm) {
      return "播放源连不上，或 strm 里的直链已失效：这类地址由播放代理临时签发，通常有有效期，" +
        "也可能触发了限流（上游 403/429 时服务端会暂停 10 分钟再放行）。" +
        "请回视频页重新生成一条直链，或稍后再试。";
    }
    if (transcode) {
      return `显卡转码失败${codec ? `（源编码 ${codec}）` : ""}：服务端没能把这一集转成 H.264。` +
        "常见原因是显卡设备没映射进容器（docker-compose 里的 devices: /dev/dri）、驱动缺失，或这一路转码被中断。" +
        "可以点「重试播放」，或点左下角「下载」用本地播放器看。";
    }
    if (episode.trial) {
      return "这台浏览器解不了 HEVC：当前是「HEVC 直连」，能不能解码由浏览器决定。" +
        "把工具栏的「HEVC 直连」关掉，就会改走服务端显卡转码。";
    }
    return `浏览器播不了这个文件${codec ? `（${codec}）` : ""}：多数是容器或编码不受支持。` +
      "可以点左下角「下载」用本地播放器看，或在元数据页重新归档到 Emby 观看。";
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={episode.title}
      description={[
        episodeCode(episode),
        episode.durationSec ? formatDuration(episode.durationSec) : null,
        resolutionLabel(episode.height),
        episode.videoCodec?.toUpperCase() ?? null,
        transcode ? "显卡转码" : remux ? "实时换封装" : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      width="max-w-6xl"
      footer={
        <>
          <a
            href={episode.streamUrl}
            download={episode.name}
            className="btn-ghost mr-auto flex items-center gap-1.5 text-[12.5px]"
            title="下载这个文件（原文件，不转码）"
          >
            <IconDownload className="h-3.5 w-3.5" />
            下载
          </a>
          <Button size="sm" disabled={!hasPrev} onClick={onPrev} title="上一集（快捷键 [）">
            <IconChevronLeft className="h-3.5 w-3.5" />
            上一集
          </Button>
          <Button size="sm" disabled={!hasNext} onClick={onNext} title="下一集（快捷键 ]）">
            下一集
            <IconChevronRight className="h-3.5 w-3.5" />
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        {failed ? (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-2xl bg-black px-6 text-center ring-1 ring-white/[0.06]">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-500/25 bg-rose-500/10 text-err">
              <IconAlert className="h-5 w-5" />
            </span>
            <p className="max-w-lg text-[12.5px] leading-relaxed text-err">{failed}</p>
            <Button
              size="sm"
              onClick={() => {
                setFailed(null);
                setRetryKey((n) => n + 1);
              }}
            >
              <IconRefresh className="h-3.5 w-3.5" />
              重试播放
            </Button>
          </div>
        ) : (
          <VideoPlayer
            key={`${episode.path}#${retryKey}`}
            src={episode.streamUrl}
            seekable={seekable}
            durationSec={episode.durationSec}
            poster={poster}
            badge={[
              episode.isStrm
                ? "链接播放"
                : transcode
                  ? "显卡转码"
                  : remux
                    ? "实时换封装"
                    : episode.trial
                      ? "HEVC 直连"
                      : "原文件直出",
              episode.videoCodec?.toUpperCase() ?? null,
            ]
              .filter(Boolean)
              .join(" · ")}
            preload={episode.isStrm ? "metadata" : "auto"}
            autoPoster={Boolean(episode.isStrm && !poster)}
            onSavePoster={episode.isStrm ? savePoster : undefined}
            hasPrev={hasPrev}
            hasNext={hasNext}
            onPrev={onPrev}
            onNext={onNext}
            onError={() => setFailed(errorCopy())}
          />
        )}

        {/* 卡片里只能放三行，完整简介放这儿看 */}
        <EpisodeOverview text={cleanText(episode.plot)} />

        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-[11px] leading-relaxed text-slate-500">
          <p>
            {transcode && <span className="mr-1 text-ok">显卡转码：</span>}
            {transcode
              ? "浏览器解不了这个编码，服务端用显卡把画面实时转成 H.264（解码和编码都在 GPU 上，CPU 基本不烧）。" +
                "这种流没有总长度，进度条是自绘的：拖动它、或在上方输入框里填「秒 / 分:秒」回车，都会让服务端从那一秒重新起一路流，等 1~3 秒。"
              : episode.trial
                ? "HEVC 直连：靠这台浏览器的解码器播；黑屏或报错说明它解不了，可在工具栏关掉「HEVC 直连」改走显卡转码。进度条可以直接拖。"
                : remux
                  ? "这个文件是 MKV / TS 这类容器，服务端正在实时换封装成 MP4 播放；跳转同样是从目标秒重新起一段流，等 1 秒左右。"
                  : "原文件直出（支持 Range），拖动进度条和「跳到指定秒」都是瞬时的。"}
            <span className="ml-1 text-slate-600">{episode.name}</span>
          </p>
          <span className="shrink-0 text-slate-600">
            空格 播放/暂停 · ←→ 5 秒 · Shift+←→ 30 秒 · 数字键跳 10% · [ / ] 切集 · f 全屏 · Esc 关闭
          </span>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 目录选择                                                            */
/* ------------------------------------------------------------------ */

function BrowseDialog({
  start,
  onClose,
  onPick,
}: {
  start: string;
  onClose: () => void;
  onPick: (dir: string) => void;
}) {
  const toast = useToast();
  const [current, setCurrent] = useState(start);
  const [data, setData] = useState<{ path: string; parent: string | null; dirs: Array<{ name: string; path: string }>; home: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (next?: string) => {
      setLoading(true);
      void api
        .metadataBrowse(next || current || undefined)
        .then((res) => {
          setData({ path: res.path, parent: res.parent, dirs: res.dirs, home: res.home });
          setCurrent(res.path);
        })
        .catch((err) => toast.push((err as Error).message, "error"))
        .finally(() => setLoading(false));
    },
    [current, toast],
  );

  useEffect(() => {
    load(start || undefined);
    // 只在打开时按起点加载一次，之后由用户点目录驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      open
      onClose={onClose}
      title="选择媒体目录"
      description="挑一个装有剧集的目录，媒体库会把它下面每个剧集文件夹当成一部剧；下载根目录之外的位置会自动登记为媒体来源"
      width="max-w-2xl"
      footer={
        <>
          <Button size="sm" onClick={() => load(data?.home)}>
            回到下载目录
          </Button>
          <Button size="sm" variant="primary" onClick={() => onPick(current)} disabled={!current}>
            <IconCheck className="h-3.5 w-3.5" />
            用这个目录
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
          <IconFolder className="h-3.5 w-3.5 shrink-0 text-brand-300" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-400" title={current}>
            {current || "…"}
          </span>
          {data?.parent && (
            <button
              onClick={() => load(data.parent ?? undefined)}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
            >
              上一层
            </button>
          )}
        </div>

        <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-white/[0.06]">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-slate-500">
              <Spinner className="h-3.5 w-3.5" />
              读取中
            </div>
          )}
          {!loading && data?.dirs.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-slate-500">这个目录下没有子文件夹。</p>
          )}
          {!loading &&
            data?.dirs.map((dir) => (
              <button
                key={dir.path}
                onClick={() => load(dir.path)}
                className="flex w-full items-center gap-2 border-b border-white/[0.04] px-3 py-2 text-left text-[12.5px] text-slate-300 transition last:border-0 hover:bg-white/[0.04] hover:text-white"
              >
                <IconFolder className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                <span className="min-w-0 flex-1 truncate">{dir.name}</span>
                <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-600" />
              </button>
            ))}
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500">
          选中后会自动登记为媒体来源，之后可以直接打开；系统目录和数据目录不允许设为媒体库目录。
        </p>
      </div>
    </Modal>
  );
}
