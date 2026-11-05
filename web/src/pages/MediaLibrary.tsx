import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { MediaEpisode, MediaLibraryResponse, MediaSeries, MediaSeriesResponse } from "../types";
import { Badge, Button, EmptyState, Modal, Spinner, useToast } from "../components/ui";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFolder,
  IconImage,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconVideo,
} from "../components/icons";
import { formatBytes, formatDateTime, formatDuration, formatRelative } from "../utils";

/**
 * 媒体库。
 *
 * 展示的是「你选的目录」（默认下载目录）里的东西，不依赖 Emby：
 *   目录 → 剧集（海报墙）→ 分集列表 → 点某一集直接播
 *
 * 数据全部来自磁盘上的 NFO / 封面槽位；播放走 /api/media/stream，
 * 能原生播的按 Range 直出（可拖进度条），容器不兼容的由服务端用 ffmpeg 换封装。
 */

const DIR_STORAGE_KEY = "tgsub.media.dir";
const SORT_STORAGE_KEY = "tgsub.media.sort";
/**
 * 「我的浏览器能放 HEVC，强制尝试」。
 *
 * HEVC 能不能播是**每台浏览器**的事（Safari / 带 HEVC 扩展的 Edge 能放，
 * 多数 Windows 上的 Chrome 不能），所以这个开关存在本地，不跟着账号走。
 * 打开后请求带 `hevc=1`，服务端不再把 HEVC 判成 unsupported。
 *
 * **默认打开**：只有在这台浏览器上手动关过（存了 "0"）才保持关闭；
 * 没存过（新装 / 清过缓存 / 换设备）一律按开处理，不用每次进媒体库先点一下。
 */
const HEVC_STORAGE_KEY = "tgsub.media.hevc";

type SortKey = "updated" | "name";

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

export default function MediaLibrary() {
  const toast = useToast();
  const [dir, setDir] = useState<string>(() => localStorage.getItem(DIR_STORAGE_KEY) ?? "");
  const [listing, setListing] = useState<MediaLibraryResponse | null>(null);
  const [seriesView, setSeriesView] = useState<MediaSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>(() => (localStorage.getItem(SORT_STORAGE_KEY) as SortKey) || "updated");
  // 默认开：localStorage 没值（或不是明确的 "0"）就当打开，手动关过才记成 "0"
  const [hevc, setHevc] = useState(() => localStorage.getItem(HEVC_STORAGE_KEY) !== "0");
  /**
   * 列表加载要读这个开关，但**不能把它放进依赖**：依赖里带 hevc 的话，
   * 一开开关就会跑一遍列表加载，而列表加载会清掉剧集视图 —— 人直接被踢回海报墙。
   * 用 ref 拿当前值，切换时自己决定是重拉剧集还是重扫列表。
   */
  const hevcRef = useRef(hevc);
  const [playing, setPlaying] = useState<{ episode: MediaEpisode; list: MediaEpisode[]; index: number } | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  /** 进入剧集前所在的目录：返回时回到这里，而不是剧集的父目录 */
  const [returnDir, setReturnDir] = useState("");

  /** 输入停顿 300ms 再过滤，避免每个键都重排整个网格 */
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
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
        // 目录变了（或第一次进来）就清掉剧集视图
        setSeriesView(null);
        if (res.dir) {
          setDir(res.dir);
          localStorage.setItem(DIR_STORAGE_KEY, res.dir);
        }
        if (res.isSeries) {
          // 直接落在剧集目录（比如启动时记着上次的位置）→ 返回键回到它的父目录
          setReturnDir(normalizePath(res.dir).split("/").slice(0, -1).join("/"));
          void api
            .mediaSeries(res.dir, hevcRef.current)
            .then((detail) => {
              if (alive) setSeriesView(detail);
            })
            .catch((err) => {
              if (alive) setError((err as Error).message);
            });
        }
      })
      .catch((err) => {
        if (!alive) return;
        setListing(null);
        setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dir, reloadToken]);

  const openSeries = (target: MediaSeries) => {
    // 记住是从哪个目录点进来的
    if (listing?.dir) setReturnDir(listing.dir);
    setLoading(true);
    setError(null);
    void api
      .mediaSeries(target.dir, hevcRef.current)
      .then((detail) => setSeriesView(detail))
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

  const changeSort = (next: SortKey) => {
    setSort(next);
    localStorage.setItem(SORT_STORAGE_KEY, next);
  };

  /**
   * 切「HEVC 试播」：只影响播放方式，不能把人踢出剧集页 ——
   * 所以在剧集页里就地重拉详情，在列表页才整体重扫。
   */
  const changeHevc = (next: boolean) => {
    hevcRef.current = next;
    setHevc(next);
    localStorage.setItem(HEVC_STORAGE_KEY, next ? "1" : "0");
    if (seriesView) {
      const target = seriesView.dir;
      setLoading(true);
      void api
        .mediaSeries(target, next)
        .then((detail) => setSeriesView(detail))
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
        `这个文件是 ${episode.videoCodec?.toUpperCase() ?? "未知编码"}，浏览器播不了，可以用播放器或 Emby 打开`,
        "error",
      );
      return;
    }
    setPlaying({ episode, list: episodes, index });
  };

  /* ------------------------------ 加载态 ------------------------------ */

  if (loading && !listing) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-[12.5px] text-slate-500">
        <Spinner className="h-4 w-4" />
        正在读取媒体库…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 工具条：位置 + 面包屑 + 搜索 + 刷新 */}
      <div className="card p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setBrowseOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[12.5px] text-slate-300 transition hover:border-white/[0.14] hover:text-white"
            title="选择要展示的目录"
          >
            <IconFolder className="h-3.5 w-3.5 text-brand-300" />
            选择目录
            <IconChevronDown className="h-3 w-3 text-slate-500" />
          </button>

          <div className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-slate-500">
            <button
              onClick={() => goDir(listing?.home ?? "")}
              className="rounded px-1 py-0.5 hover:bg-white/[0.06] hover:text-slate-300"
              title="回到下载目录"
            >
              下载目录
            </button>
            {crumbs.map((crumb, i) => (
              <span key={crumb.path} className="flex items-center gap-1">
                <span className="text-slate-700">/</span>
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
                <span className="text-slate-700">/</span>
                <span className="max-w-[16rem] truncate px-1 text-slate-200">{seriesView.series.title}</span>
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                className="field w-44 py-1.5 pl-8 text-[12.5px] sm:w-56"
                placeholder="搜索剧名"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            {!seriesView && (
              <div className="flex items-center gap-1 rounded-lg border border-white/[0.06] p-0.5">
                {(
                  [
                    ["updated", "最近更新"],
                    ["name", "名称"],
                  ] as Array<[SortKey, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => changeSort(key)}
                    className={`rounded-md px-2 py-1 text-[11.5px] transition ${
                      sort === key ? "bg-white/[0.09] text-white" : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => changeHevc(!hevc)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] transition ${
                hevc
                  ? "border-amber-500/30 bg-amber-500/[0.12] text-warn"
                  : "border-white/[0.07] bg-white/[0.02] text-slate-500 hover:border-white/[0.14] hover:text-slate-300"
              }`}
              title="默认开启：不再把 HEVC 标成播不了，实际能不能解由这台浏览器决定；放不出来可点这里关掉"
            >
              <IconVideo className="h-3.5 w-3.5" />
              HEVC 试播
              {hevc && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
            </button>
            <Button size="sm" onClick={() => setReloadToken((n) => n + 1)} title="重新扫描目录">
              <IconRefresh className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.08] px-3 py-2 text-[12px] leading-relaxed text-warn">
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {seriesView ? (
        <SeriesView
          detail={seriesView}
          hevc={hevc}
          onBack={backToList}
          onPlay={(index) => playEpisode(seriesView.episodes, index)}
        />
      ) : (
        <LibraryGrid
          listing={listing}
          series={visibleSeries}
          search={search}
          loading={loading}
          onOpen={openSeries}
          onPlayLoose={(index) => playEpisode(listing?.loose ?? [], index)}
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
        />
      )}

      {browseOpen && (
        <BrowseDialog
          start={listing?.dir ?? ""}
          onClose={() => setBrowseOpen(false)}
          onPick={(picked) => {
            setBrowseOpen(false);
            goDir(picked);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 海报墙                                                              */
/* ------------------------------------------------------------------ */

function LibraryGrid({
  listing,
  series,
  search,
  loading,
  onOpen,
  onPlayLoose,
}: {
  listing: MediaLibraryResponse | null;
  series: MediaSeries[];
  search: string;
  loading: boolean;
  onOpen: (item: MediaSeries) => void;
  onPlayLoose: (index: number) => void;
}) {
  if (!listing) return null;

  const loose = listing.loose;
  const empty = series.length === 0 && loose.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <p className="text-[11.5px] text-slate-500">
          {search ? `「${search}」的搜索结果` : "这个目录里的剧集"}
          <span className="ml-2 tabular-nums text-slate-400">{series.length}</span> 部
          {loose.length > 0 && <span className="ml-2 text-slate-500">· 散装视频 {loose.length} 个</span>}
        </p>
        {loading && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Spinner className="h-3 w-3" />
            读取中
          </span>
        )}
      </div>

      {empty ? (
        <div className="card">
          <EmptyState
            icon={<IconImage className="h-5 w-5" />}
            title={search ? "没有匹配的剧集" : "这个目录里还没有视频"}
            description={
              search
                ? "换个关键词试试，或者清空搜索看全部。"
                : "下载完成的视频会出现在这里；也可以点左上角「选择目录」换一个已经在用的媒体目录。"
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {series.map((item) => (
            <article key={item.dir} className="group">
              <button onClick={() => onOpen(item)} className="block w-full text-left" title={item.title}>
                <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/[0.08] transition duration-300 group-hover:ring-brand-500/40">
                  {item.posterUrl ? (
                    <img
                      src={item.posterUrl}
                      alt={item.title}
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-slate-600">
                      <IconImage className="h-6 w-6" />
                      <span className="px-2 text-center text-[10.5px] leading-tight">{item.title}</span>
                    </div>
                  )}

                  <span className="absolute left-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-[#fff]/90 backdrop-blur">
                    {item.episodeCount} 集
                  </span>
                  <span className="absolute right-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] text-[#fff]/85 backdrop-blur">
                    {ORIGIN_LABEL[item.origin] ?? "外部"}
                  </span>

                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition duration-200 group-hover:opacity-100">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-[#fff] backdrop-blur">
                      <IconPlay className="h-4 w-4" />
                    </span>
                  </span>
                </div>
                <p className="mt-1.5 truncate text-[12.5px] font-medium leading-snug text-slate-200">{item.title}</p>
                <p className="truncate text-[10.5px] tabular-nums text-slate-500">
                  {[item.year ? String(item.year) : null, `${item.episodeCount} 集`, formatBytes(item.totalSize)]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </button>
            </article>
          ))}

          {/* 目录里直接放的视频（没归进剧集文件夹）也列出来 */}
          {loose.map((ep, index) => (
            <article key={ep.path} className="group">
              <button onClick={() => onPlayLoose(index)} className="block w-full text-left" title={ep.name}>
                <div className="relative aspect-video overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/[0.08] transition duration-300 group-hover:ring-brand-500/40">
                  {ep.thumbUrl ? (
                    <img
                      src={ep.thumbUrl}
                      alt={ep.title}
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-ink-800 to-ink-900 px-2 text-slate-600">
                      <IconVideo className="h-7 w-7" />
                      <span className="line-clamp-2 text-center text-[10.5px] leading-tight text-slate-400">{ep.title}</span>
                    </div>
                  )}
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-5">
                    <span className="line-clamp-1 text-[11px] leading-tight text-[#fff]/90">{ep.title}</span>
                  </span>
                  {ep.durationSec != null && (
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] tabular-nums text-[#fff]/85 backdrop-blur">
                      {formatDuration(ep.durationSec)}
                    </span>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition duration-200 group-hover:opacity-100">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-[#fff] backdrop-blur">
                      <IconPlay className="h-4 w-4" />
                    </span>
                  </span>
                </div>
                <p className="mt-1.5 truncate text-[12.5px] font-medium leading-snug text-slate-200">{ep.title}</p>
                <p className="truncate text-[10.5px] tabular-nums text-slate-500">
                  {[formatBytes(ep.size), resolutionLabel(ep.height)].filter(Boolean).join(" · ")}
                </p>
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 剧集详情                                                            */
/* ------------------------------------------------------------------ */

function SeriesView({
  detail,
  hevc,
  onBack,
  onPlay,
}: {
  detail: MediaSeriesResponse;
  /** 这台浏览器开了「HEVC 强制尝试」：分集表里标「试播」的那些就是靠它才可播 */
  hevc: boolean;
  onBack: () => void;
  onPlay: (index: number) => void;
}) {
  const { series, episodes } = detail;
  const playable = episodes.findIndex((ep) => ep.playMode !== "unsupported");
  const totalSize = series.totalSize;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[12px] text-slate-400 transition hover:bg-white/[0.05] hover:text-slate-200"
        >
          <IconChevronLeft className="h-3.5 w-3.5" />
          返回目录
        </button>
        <span className="text-[11px] text-slate-500">
          最近更新 {formatDateTime(series.updatedAt)}
        </span>
      </div>

      {/* 头部：海报 + 信息 */}
      <div className="card overflow-hidden">
        <div className="flex flex-col gap-4 p-4 sm:flex-row">
          <div className="w-full shrink-0 sm:w-[150px]">
            <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/[0.08]">
              {series.posterUrl ? (
                <img src={series.posterUrl} alt={series.title} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-slate-600">
                  <IconImage className="h-6 w-6" />
                  <span className="text-[10.5px]">无海报</span>
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h2 className="text-[17px] font-semibold leading-tight text-white">{series.title}</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500">
                {series.year && <span className="tabular-nums">{series.year}</span>}
                <span>{episodes.length} 集</span>
                <span>{formatBytes(totalSize)}</span>
                {series.genres.length > 0 && <span>{series.genres.slice(0, 3).join(" / ")}</span>}
                {series.rating != null && (
                  <span className="text-amber-300">
                    ★ {series.rating.toFixed(1)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className="border-white/10 bg-white/[0.04] text-slate-300">
                {ORIGIN_LABEL[series.origin] ?? "外部"}
              </Badge>
              {series.hasNfo ? (
                <Badge className="border-emerald-500/20 bg-emerald-500/10 text-ok">已生成 NFO</Badge>
              ) : (
                <Badge className="border-white/10 bg-white/[0.04] text-slate-500">无 NFO</Badge>
              )}
            </div>

            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-400">
              {series.overview?.trim() || "这部剧还没有简介，可以去元数据页补一份。"}
            </p>

            {playable >= 0 && (
              <Button size="sm" variant="primary" onClick={() => onPlay(playable)}>
                <IconPlay className="h-3.5 w-3.5" />
                播放第 {episodes[playable].episode ?? playable + 1} 集
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 分集列表 */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">分集（{episodes.length}）</p>
          <p className="text-[11px] text-slate-600">
            {hevc ? "已开启 HEVC 试播：标「试播」的集取决于这台浏览器的解码器" : "点任意一集直接播放"}
          </p>
        </div>
        {episodes.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-slate-500">这个目录里没有视频文件。</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {episodes.map((ep, index) => {
              const unsupported = ep.playMode === "unsupported";
              const res = resolutionLabel(ep.height);
              return (
                <button
                  key={ep.path}
                  onClick={() => onPlay(index)}
                  className={`group/ep flex w-full items-start gap-3 px-4 py-3 text-left transition ${
                    unsupported ? "opacity-60" : "hover:bg-white/[0.03]"
                  }`}
                  title={unsupported ? `${ep.videoCodec ?? "该编码"} 浏览器不支持` : ep.name}
                >
                  {/* 缩略图：下载时生成的图优先，没有就服务端抽一帧 */}
                  <span className="relative block aspect-video w-[116px] shrink-0 overflow-hidden rounded-lg bg-ink-800 ring-1 ring-white/[0.06] sm:w-[132px]">
                    {ep.thumbUrl ? (
                      <img
                        src={ep.thumbUrl}
                        alt={ep.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-500 group-hover/ep:scale-[1.03]"
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
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-[#fff]/90 backdrop-blur transition group-hover/ep:scale-110 group-hover/ep:bg-brand-500/80">
                        {unsupported ? <IconAlert className="h-3.5 w-3.5" /> : <IconPlay className="h-3.5 w-3.5" />}
                      </span>
                    </span>
                  </span>

                  {/* 集号 / 标题 / 简介 / 参数 */}
                  <span className="min-w-0 flex-1 pt-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[10px] tabular-nums text-slate-400">
                        {episodeCode(ep)}
                      </span>
                      <span className="truncate text-[13px] font-medium text-slate-100">{ep.title}</span>
                      {unsupported && (
                        <span className="text-[10.5px] text-warn">浏览器不支持 {ep.videoCodec?.toUpperCase()}</span>
                      )}
                      {ep.trial && (
                        <span
                          className="rounded bg-amber-500/10 px-1 py-0.5 text-[10px] text-warn"
                          title="HEVC：靠这台浏览器的解码器播，放不出来会给出提示"
                        >
                          试播
                        </span>
                      )}
                    </span>
                    {ep.plot.trim() && (
                      <span className="mt-1 line-clamp-2 block text-[11.5px] leading-relaxed text-slate-500">{ep.plot.trim()}</span>
                    )}
                    <span className="mt-1 block truncate text-[10.5px] tabular-nums text-slate-500">
                      {[
                        res,
                        formatBytes(ep.size),
                        ep.videoCodec?.toUpperCase() ?? null,
                        ep.width && ep.height ? `${ep.width}×${ep.height}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>

                  <span className="hidden shrink-0 pt-1 text-[10.5px] text-slate-600 sm:block">
                    {formatRelative(ep.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 播放                                                                */
/* ------------------------------------------------------------------ */

function PlayerDialog({
  episode,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: {
  episode: MediaEpisode;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    setFailed(null);
  }, [episode.path]);

  const remux = episode.playMode === "remux";

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
      ]
        .filter(Boolean)
        .join(" · ")}
      width="max-w-5xl"
      footer={
        <>
          <a
            href={episode.streamUrl}
            download={episode.name}
            className="btn-ghost flex items-center gap-1.5 text-[12.5px]"
            title="下载这个文件"
          >
            <IconDownload className="h-3.5 w-3.5" />
            下载
          </a>
          <Button size="sm" disabled={!hasPrev} onClick={onPrev}>
            <IconChevronLeft className="h-3.5 w-3.5" />
            上一集
          </Button>
          <Button size="sm" disabled={!hasNext} onClick={onNext}>
            下一集
            <IconChevronRight className="h-3.5 w-3.5" />
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {failed ? (
          <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.08] px-3.5 py-3 text-[12px] leading-relaxed text-err">
            {failed}
          </div>
        ) : (
          <video
            key={episode.streamUrl}
            src={episode.streamUrl}
            controls
            autoPlay
            playsInline
            className="aspect-video w-full rounded-xl bg-black"
            onError={() =>
              setFailed(
                episode.trial
                  ? `这台浏览器解不了 HEVC：开关「HEVC 试播」只是不再拦着，能不能解码还是看浏览器自己。` +
                    "可以关掉开关让列表恢复标记，或点左下角「下载」用本地播放器看。"
                  : `浏览器播不了这个文件${episode.videoCodec ? `（${episode.videoCodec.toUpperCase()}）` : ""}：` +
                    "多数是容器或编码不受支持。可以点左下角「下载」用本地播放器看，或在元数据页重新归档到 Emby 观看。",
              )
            }
          />
        )}
        <p className="text-[11px] leading-relaxed text-slate-500">
          {episode.trial && <span className="mr-1 text-warn">HEVC 试播：</span>}
          {episode.trial
            ? "这一集的编码是 HEVC，靠这台浏览器的解码器播；黑屏或报错就说明它解不了。"
            : remux
              ? "这个文件是 MKV / TS 这类容器，服务端正在实时换封装成 MP4 播放 —— 能正常看，但拖不了进度条。"
              : "原文件直出，支持拖动进度条。"}
          <span className="ml-1 text-slate-600">{episode.name}</span>
        </p>
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
      description="挑一个装有剧集的目录，媒体库会把它下面每个剧集文件夹当成一部剧"
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
          只能选下载目录内或已登记的来源目录 —— 其它位置服务端没有权限读。
        </p>
      </div>
    </Modal>
  );
}
