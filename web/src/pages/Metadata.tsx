import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type {
  BrowseResult,
  CropRect,
  FrameCandidate,
  ImageName,
  ImageScope,
  MediaOrigin,
  MetadataDetail,
  MetadataFolderItem,
  MetadataOriginGroup,
  MetadataSource,
  MetadataExcludedItem,
  NfoFields,
  RenamePlanPreview,
} from "../types";
import { Badge, Button, EmptyState, Modal, Spinner, useToast } from "../components/ui";
import { CropDialog } from "../components/CropDialog";
import { MediaDeleteDialog, type DeleteTarget } from "../components/MediaDeleteDialog";
import { TransferDialog, type TransferTarget } from "../components/TransferDialog";
import { BatchDeleteDialog } from "../components/BatchDeleteDialog";
import { PageSizeControl, usePageSize } from "../components/PageSize";
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconCopy,
  IconCrop,
  IconDownload,
  IconEdit,
  IconFolder,
  IconImage,
  IconMove,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSpark,
  IconTrash,
  IconUpload,
  IconVideo,
  IconX,
} from "../components/icons";
import { formatBytes, formatDateTime, formatDuration } from "../utils";

/* ------------------------------ 常量 ------------------------------ */

const IMAGE_SLOTS: Array<{ name: ImageName; label: string; ratio: string; aspect: number; hint: string }> = [
  { name: "poster", label: "海报 poster", ratio: "aspect-[2/3]", aspect: 2 / 3, hint: "2:3 · 1000×1500" },
  { name: "landscape", label: "横版 landscape", ratio: "aspect-video", aspect: 16 / 9, hint: "16:9 · 1920×1080" },
  { name: "fanart", label: "背景 fanart", ratio: "aspect-video", aspect: 16 / 9, hint: "16:9 · 1920×1080" },
  { name: "thumb", label: "缩略图 thumb", ratio: "aspect-video", aspect: 16 / 9, hint: "16:9 · 1280×720" },
  { name: "banner", label: "横幅 banner", ratio: "aspect-[1000/185]", aspect: 1000 / 185, hint: "1000×185" },
];

/**
 * 单集只有缩略图这一种专属图片。
 *
 * poster / landscape / fanart / banner 都是「整部剧共用」的概念 ——
 * Emby 里它们放在剧集目录，单集文件旁边放这些名字没有意义，
 * 所以选中具体某一集时只显示 thumb。
 */
const EPISODE_IMAGE_NAMES: ImageName[] = ["thumb"];

/** 按作用域取该显示哪些图片槽位 */
function slotsOf(scope: ImageScope): typeof IMAGE_SLOTS {
  if (scope === "episode") return IMAGE_SLOTS.filter((s) => EPISODE_IMAGE_NAMES.includes(s.name));
  return IMAGE_SLOTS;
}

const EMPTY_FIELDS: NfoFields = {
  title: "",
  originaltitle: "",
  showtitle: "",
  season: "",
  episode: "",
  year: "",
  aired: "",
  premiered: "",
  plot: "",
  outline: "",
  studio: "",
  rating: "",
  tags: [],
  genres: [],
};

const FIELD_KEYS: Array<keyof NfoFields> = [
  "title",
  "originaltitle",
  "showtitle",
  "season",
  "episode",
  "year",
  "aired",
  "premiered",
  "plot",
  "outline",
  "studio",
  "rating",
];

/** 表单比较用（忽略空数组顺序差异） */
function sameFields(a: NfoFields, b: NfoFields): boolean {
  for (const key of FIELD_KEYS) if ((a[key] as string) !== (b[key] as string)) return false;
  return (
    a.tags.join("\u0001") === b.tags.join("\u0001") && a.genres.join("\u0001") === b.genres.join("\u0001")
  );
}

function scopeLabel(scope: ImageScope): string {
  return scope === "episode" ? "单集图片" : "剧集图片";
}

/** 选中的目标：文件夹 = 剧集级，文件 = 单集级 */
interface Selection {
  key: string;
  kind: "file" | "folder";
}

/* ------------------------------ 页面 ------------------------------ */

export default function Metadata() {
  const toast = useToast();

  const [pageSize, setPageSize] = usePageSize("metadata", 20);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  /** 来源分区筛选：空字符串 = 全部 */
  const [origin, setOrigin] = useState<MediaOrigin | "">("");
  const [originGroups, setOriginGroups] = useState<MetadataOriginGroup[]>([]);
  const [items, setItems] = useState<MetadataFolderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  /** 展开的文件夹 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<MetadataDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<"basic" | "images" | "nfo">("basic");
  const [kind, setKind] = useState<"episode" | "show">("show");

  const [fields, setFields] = useState<NfoFields>(EMPTY_FIELDS);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [genNfo, setGenNfo] = useState(false);
  const [genImages, setGenImages] = useState(false);

  const [picker, setPicker] = useState<{ scope: ImageScope; name: ImageName } | null>(null);
  const [imageScope, setImageScope] = useState<ImageScope>("series");
  const [addOpen, setAddOpen] = useState(false);
  /** 待删除的媒体条目（剧集目录 / 单集视频） */
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  /** 勾选的条目（视频或剧集目录，存的是路径标识） */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [transfer, setTransfer] = useState<TransferTarget | null>(null);
  const [batchDelete, setBatchDelete] = useState<DeleteTarget[] | null>(null);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const fetchList = useCallback(
    async (target: number, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await api.metadataItems({
          q: query.trim(),
          limit: pageSize,
          offset: target * pageSize,
          origin: origin || undefined,
        });
        setItems(res.items);
        setTotal(res.total);
        setOriginGroups(res.origins);
        const last = Math.max(0, Math.ceil(res.total / pageSize) - 1);
        if (target > last) setPage(last);
        setSelected((prev) => {
          const fallback = res.items[0] ? { key: res.items[0].key, kind: "folder" as const } : null;
          if (!prev) return fallback;
          const stillThere = res.items.some((i) => i.key === prev.key || i.files.some((f) => f.key === prev.key));
          return stillThere ? prev : fallback;
        });
      } catch (err) {
        if (!silent) toast.push((err as Error).message, "error");
      } finally {
        setLoading(false);
      }
    },
    [pageSize, query, origin, toast],
  );

  useEffect(() => {
    void fetchList(page);
  }, [fetchList, page]);

  // 换页 / 换来源 / 换搜索词时勾选会跨页失效，直接清空免得删错东西
  useEffect(() => {
    setChecked(new Set());
  }, [page, origin, query]);

  const loadDetail = useCallback(
    async (key: string, silent = false) => {
      if (!silent) setDetailLoading(true);
      try {
        const res = await api.metadataDetail(key);
        setDetail(res);
        setDirty(false);
      } catch (err) {
        toast.push((err as Error).message, "error");
      } finally {
        setDetailLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void loadDetail(selected.key);
  }, [selected, loadDetail]);

  // 目标换了：文件夹只能编辑剧集信息，文件可以切单集 / 剧集
  useEffect(() => {
    if (!detail) return;
    setKind(detail.target.kind === "folder" ? "show" : "episode");
    // 图片作用域跟着目标走：剧集目录看剧集图片，单集看单集图片
    setImageScope(detail.target.kind === "folder" ? "series" : "episode");
  }, [detail]);

  // 切换「单集 / 剧集」时换一套字段
  useEffect(() => {
    if (!detail) return;
    setFields(detail.fields[kind] ?? EMPTY_FIELDS);
    setDirty(false);
  }, [kind, detail]);

  const update = (patch: Partial<NfoFields>) => {
    setFields((prev) => {
      const next = { ...prev, ...patch };
      setDirty(!sameFields(next, detail?.fields[kind] ?? EMPTY_FIELDS));
      return next;
    });
  };

  const save = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await api.saveMetaFields(detail.target.key, kind, fields);
      toast.push(kind === "episode" ? "单集元数据已保存" : "剧集信息已保存", "success");
      setFields(res.fields);
      setDirty(false);
      await loadDetail(detail.target.key, true);
      await fetchList(page, true);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  /**
   * 一键生成 NFO：整部剧的单集 NFO + tvshow.nfo。
   * 若是 tgsub 下载的（监控/下载列表里有记录），后端会复用下载时的信息补全，尽量不空着。
   */
  const generateNfo = async () => {
    if (!selected) return;
    setGenNfo(true);
    try {
      const res = await api.generateNfo(selected.key);
      toast.push(`已生成 ${res.nfoCount} 份 NFO（${res.files} 个视频）`, "success");
      await loadDetail(selected.key, true);
      await fetchList(page, true);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setGenNfo(false);
    }
  };

  /**
   * 一键生成图片：缺封面时用 ffmpeg 随机截帧生成横版/竖版封面。
   * 无论选中的是剧集目录还是某一集，后端都会覆盖整个剧集 —— 单集缩略图每集都要有。
   */
  const generateImages = async () => {
    if (!selected) return;
    setGenImages(true);
    try {
      const res = await api.generateImages(selected.key);
      toast.push(`已生成 ${res.coverCount} 张封面（${res.files} 个视频）`, "success");
      await loadDetail(selected.key, true);
      await fetchList(page, true);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setGenImages(false);
    }
  };

  const imageOf = (scope: ImageScope, name: ImageName) =>
    detail?.images.find((img) => img.scope === scope && img.name === name) ?? null;

  const removeImage = async (scope: ImageScope, name: ImageName) => {
    if (!detail) return;
    try {
      await api.deleteImage(detail.target.key, scope, name);
      toast.push("图片已删除", "success");
      await loadDetail(detail.target.key, true);
      await fetchList(page, true);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 勾选/取消一个视频（可跨文件夹，合并时按集号统一排序） */
  const toggleCheck = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isFolderTarget = detail?.target.kind === "folder";
  /**
   * 图片作用域跟着选中目标走：
   *  - 选中剧集目录 → 只有剧集图片（整部剧共用）
   *  - 选中具体视频 → 只有单集图片（这一集自己的缩略图）
   * 剧集图片要到左边点剧集那一行去改，这里不重复展示。
   */
  const scopes: ImageScope[] = isFolderTarget ? ["series"] : ["episode"];

  /** 勾选的具体条目（目录或视频），批量操作都基于它 */
  const checkedEntries: DeleteTarget[] = [];
  for (const folder of items) {
    if (checked.has(folder.key)) {
      checkedEntries.push({ key: folder.key, kind: "folder", name: folder.name, path: folder.dir });
    }
    for (const file of folder.files) {
      if (checked.has(file.key)) {
        checkedEntries.push({ key: file.key, kind: "file", name: file.name, path: file.path });
      }
    }
  }
  /** 合并只对视频有意义：勾了剧集目录就没法按集号重排 */
  const onlyFiles = checkedEntries.length > 0 && checkedEntries.every((entry) => entry.kind === "file");

  /**
   * 列表分组：选了某个来源就只显示这一组（不重复显示分组标题），
   * 选「全部」时按来源分区展示，顺序以后端返回的 origins 为准。
   */
  const groups: Array<{ origin: MediaOrigin; label: string; folders: MetadataFolderItem[] }> = origin
    ? [
        {
          origin,
          label: originGroups.find((g) => g.origin === origin)?.label ?? origin,
          folders: items,
        },
      ]
    : originGroups
        .map((group) => ({
          origin: group.origin,
          label: group.label,
          folders: items.filter((folder) => folder.origin === group.origin),
        }))
        .filter((group) => group.folders.length > 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
      {/* 左侧：文件夹树（一个文件夹一条记录，展开看里面的每个视频） */}
      <section className={`card flex min-h-0 flex-col overflow-hidden ${selected ? "max-lg:hidden" : ""}`}>
        <div className="flex items-center gap-2 border-b border-white/[0.06] p-3">
          <div className="relative flex-1">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPage(0);
                  void fetchList(0);
                }
              }}
              placeholder="搜索剧名 / 文件名"
              className="field !py-2 !pl-8 !text-[12.5px]"
            />
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)} title="手动添加视频或视频目录">
            <IconPlus className="h-3.5 w-3.5" />
            添加
          </Button>
          <Button size="sm" onClick={() => void fetchList(page)} title="刷新">
            <IconRefresh className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* 来源分区：Telegram / B站 / 小红书 / YouTube / 网页(m3u8) / 外部目录 */}
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => {
              setOrigin("");
              setPage(0);
            }}
            className={`shrink-0 rounded-lg border px-2 py-[3px] text-[11.5px] transition ${
              origin === ""
                ? "border-brand-500/30 bg-brand-500/15 text-brand-200"
                : "border-white/[0.07] text-slate-400 hover:text-slate-200"
            }`}
          >
            全部
            <span className="ml-1 tabular-nums text-[10.5px] opacity-70">{originGroups.reduce((n, g) => n + g.count, 0)}</span>
          </button>
          {originGroups.map((group) => (
            <button
              key={group.origin}
              onClick={() => {
                setOrigin(group.origin);
                setPage(0);
              }}
              className={`shrink-0 rounded-lg border px-2 py-[3px] text-[11.5px] transition ${
                origin === group.origin
                  ? "border-brand-500/30 bg-brand-500/15 text-brand-200"
                  : "border-white/[0.07] text-slate-400 hover:text-slate-200"
              }`}
            >
              {group.label}
              <span className="ml-1 tabular-nums text-[10.5px] opacity-70">{group.count}</span>
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && items.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-slate-500">
              <Spinner /> 加载中…
            </div>
          )}
          {!loading && items.length === 0 && (
            <EmptyState
              icon={<IconVideo className="h-5 w-5" />}
              title="还没有可管理的媒体"
              description="下载完成的视频会按文件夹聚合到这里，也可以手动添加本地视频或目录"
              action={
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <IconPlus className="h-3.5 w-3.5" />
                  手动添加
                </Button>
              }
            />
          )}

          <ul className="divide-y divide-white/[0.05]">
            {groups.map((group) => (
              <Fragment key={group.origin}>
                {/* 分组标题：只在「全部」视图里出现，选了具体来源就不重复占位 */}
                {origin === "" && (
                  <li className="sticky top-0 z-[1] flex items-center gap-2 border-b border-white/[0.06] bg-ink-850/95 px-3 py-1.5 backdrop-blur">
                    <span className="text-[11px] font-medium text-slate-300">{group.label}</span>
                    <span className="tabular-nums text-[10.5px] text-slate-500">{group.folders.length}</span>
                  </li>
                )}
                {group.folders.map((folder) => {
              const open = expanded.has(folder.key);
              const active = selected?.key === folder.key;
              return (
                <li key={folder.key}>
                  {/* 首级：文件夹 = 一条记录，显示剧集信息 */}
                  <div
                    className={`flex items-start gap-2 px-2.5 py-2.5 transition ${
                      active ? "bg-brand-500/[0.12]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    {/* 勾选后可整体移动 / 复制 / 删除 */}
                    <input
                      type="checkbox"
                      className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-brand-500"
                      checked={checked.has(folder.key)}
                      onChange={() => toggleCheck(folder.key)}
                      aria-label={`选择 ${folder.name}`}
                      title="勾选后可移动、复制或批量删除"
                    />
                    <button
                      onClick={() => toggleExpand(folder.key)}
                      className="mt-1 shrink-0 rounded p-0.5 text-slate-500 transition hover:text-slate-300"
                      title={open ? "收起" : "展开文件"}
                      aria-label={open ? "收起" : "展开"}
                    >
                      <IconChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
                    </button>

                    <button
                      onClick={() => setSelected({ key: folder.key, kind: "folder" })}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                      title={folder.dir}
                    >
                      <span className="relative h-[62px] w-[42px] shrink-0 overflow-hidden rounded-md border border-white/10 bg-ink-900">
                        {folder.posterUrl ? (
                          <img src={folder.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-slate-600">
                            <IconFolder className="h-4 w-4" />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-[12.5px] font-medium ${
                            active ? "text-white" : "text-slate-200"
                          }`}
                          title={folder.name}
                        >
                          {folder.name}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-500">
                          <span className="rounded bg-white/[0.06] px-1.5 py-[1px] tabular-nums text-slate-400">
                            {folder.fileCount} 个视频
                          </span>
                          {folder.missing && (
                            <span className="rounded bg-err/15 px-1.5 py-[1px] text-err" title="磁盘上找不到这个目录了，只能删记录">
                              磁盘缺失
                            </span>
                          )}
                          <span className={folder.nfoExists ? "text-ok/80" : "text-warn/80"}>
                            {folder.nfoExists ? "tvshow.nfo" : "无 tvshow.nfo"}
                          </span>
                          <span>· {folder.imageCount} 图</span>
                          <span>· {formatBytes(folder.totalSize)}</span>
                        </span>
                        {folder.sourcePaths.length > 0 && (
                          <span
                            className="mt-1 block truncate font-mono text-[10px] text-slate-600"
                            title={folder.sourcePaths.join("\n")}
                          >
                            来自 {folder.sourcePaths[0]}
                            {folder.sourcePaths.length > 1 ? ` 等 ${folder.sourcePaths.length} 个来源` : ""}
                          </span>
                        )}
                      </span>
                    </button>

                    {/* 每一项都能删：剧集目录可整目录删除，也可只移出列表 */}
                    <Button
                      size="sm"
                      variant="danger"
                      className="mt-0.5 shrink-0 !px-1.5 !py-1"
                      onClick={() =>
                        setDeleteTarget({
                          key: folder.key,
                          kind: "folder",
                          name: folder.name,
                          path: folder.dir,
                        })
                      }
                      title="删除这个剧集目录"
                    >
                      <IconTrash className="h-3 w-3" />
                    </Button>
                  </div>

                  {/* 子级：文件夹里的每个视频 */}
                  {open && (
                    <ul className="border-t border-white/[0.04] bg-black/[0.12] py-1">
                      {folder.files.length === 0 && (
                        <li className="px-8 py-2 text-[11.5px] text-slate-600">这个目录里没有视频</li>
                      )}
                      {folder.files.map((file) => {
                        const fileActive = selected?.key === file.key;
                        return (
                          <li key={file.key}>
                            <div
                              className={`flex items-center gap-1 py-1.5 pl-9 pr-2 transition ${
                                fileActive ? "bg-brand-500/[0.14]" : "hover:bg-white/[0.03]"
                              }`}
                            >
                              {/* 勾选后可跨文件夹合并成一部剧 */}
                              <input
                                type="checkbox"
                                className="mr-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-brand-500"
                                checked={checked.has(file.key)}
                                onChange={() => toggleCheck(file.key)}
                                aria-label={`选择 ${file.name}`}
                                title="勾选后可与其他文件夹的视频合并成一部剧"
                              />
                              <button
                                onClick={() => setSelected({ key: file.key, kind: "file" })}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                title={file.path}
                              >
                                <IconVideo className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                <span className="min-w-0 flex-1">
                                  <span
                                    className={`block truncate text-[12px] ${
                                      fileActive ? "text-white" : "text-slate-300"
                                    }`}
                                  >
                                    {file.name}
                                  </span>
                                </span>
                                {file.episode !== null && (
                                  <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-[1px] text-[10px] tabular-nums text-slate-400">
                                    S{String(file.season ?? 1).padStart(2, "0")}E{String(file.episode).padStart(2, "0")}
                                  </span>
                                )}
                                <span
                                  className={`shrink-0 text-[10px] ${file.nfoExists ? "text-ok/80" : "text-warn/70"}`}
                                >
                                  {file.nfoExists ? "NFO" : "无"}
                                </span>
                              </button>
                              {/* 每一集都能删 */}
                              <Button
                                size="sm"
                                variant="danger"
                                className="shrink-0 !px-1.5 !py-0.5"
                                onClick={() =>
                                  setDeleteTarget({
                                    key: file.key,
                                    kind: "file",
                                    name: file.name,
                                    path: file.path,
                                  })
                                }
                                title="删除这一集"
                              >
                                <IconTrash className="h-3 w-3" />
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
                })}
              </Fragment>
            ))}
          </ul>
        </div>

        {/* 勾选后浮出的操作条：合并 / 移动 / 复制 / 删除。
            挂到 body 上 —— 页面容器带 animate-fade-up（transform 常驻），
            里面的 fixed 会以容器为基准定位，滚到视口外就看不见了。 */}
        {checked.size > 0 &&
          createPortal(
            <div className="fixed inset-x-0 bottom-5 z-40 mx-auto flex w-[min(94vw,660px)] flex-wrap items-center gap-1.5 rounded-2xl border border-brand-500/30 bg-ink-850/95 px-3.5 py-2.5 shadow-card backdrop-blur">
              <span className="mr-1 text-[11.5px] text-slate-300">
                已选 <span className="tabular-nums font-semibold text-white">{checkedEntries.length}</span> 项
              </span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setMergeOpen(true)}
                disabled={!onlyFiles}
                title={
                  onlyFiles
                    ? "把这些视频按集号排序，重命名成一部剧"
                    : "合并只能针对视频分集，勾选剧集目录请改用「移动」"
                }
              >
                <IconSpark className="h-3.5 w-3.5" />
                合并
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  setTransfer({
                    keys: checkedEntries.map((entry) => entry.key),
                    action: "move",
                    names: checkedEntries.map((entry) => entry.name),
                  })
                }
                title="把选中的剧集目录 / 视频整体搬到另一个目录"
              >
                <IconMove className="h-3.5 w-3.5" />
                移动
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  setTransfer({
                    keys: checkedEntries.map((entry) => entry.key),
                    action: "copy",
                    names: checkedEntries.map((entry) => entry.name),
                  })
                }
                title="复制一份副本到另一个目录，原文件保留"
              >
                <IconCopy className="h-3.5 w-3.5" />
                复制
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setBatchDelete(checkedEntries)}
                title="批量删除选中的条目"
              >
                <IconTrash className="h-3.5 w-3.5" />
                删除
              </Button>
              <Button size="sm" className="ml-auto" onClick={() => setChecked(new Set())} title="清空选择">
                清空
              </Button>
            </div>,
            document.body,
          )}

        <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2">
          <PageSizeControl
            value={pageSize}
            onChange={(n) => {
              setPageSize(n);
              setPage(0);
            }}
          />
          <div className="flex items-center gap-1 text-[11.5px] text-slate-500">
            <button
              className="rounded-md p-1 hover:bg-white/5 disabled:opacity-30"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              title="上一页"
            >
              <IconChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="tabular-nums">
              {page + 1}/{pageCount}
            </span>
            <button
              className="rounded-md p-1 hover:bg-white/5 disabled:opacity-30"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              title="下一页"
            >
              <IconChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* 右侧：详情 */}
      <section className={`card flex min-h-0 flex-col overflow-hidden ${selected ? "" : "max-lg:hidden"}`}>
        {selected && (
          <div className="flex items-center border-b border-white/[0.06] p-3 lg:hidden">
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              <IconChevronLeft className="h-4 w-4" />
              返回列表
            </Button>
          </div>
        )}
        {!selected && (
          <div className="flex flex-1 items-center justify-center py-20 text-[13px] text-slate-500">
            左侧选一个文件夹或视频开始编辑
          </div>
        )}

        {selected && !detail && (
          <div className="flex flex-1 items-center justify-center gap-2 py-20 text-[13px] text-slate-500">
            <Spinner /> 读取元数据…
          </div>
        )}

        {detail && (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] p-4">
              <div className="min-w-0">
                <h2 className="truncate text-[15px] font-semibold text-white" title={detail.target.path}>
                  {detail.fields[kind].title || detail.target.name}
                </h2>
                <p className="mt-1 truncate text-[11.5px] text-slate-500" title={detail.target.path}>
                  {detail.target.path}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge className="border-white/10 bg-white/[0.04] text-slate-400">
                    {detail.target.kind === "folder" ? "剧集目录" : "单集视频"}
                  </Badge>
                  {detail.target.missing && (
                    <Badge className="border-err/25 bg-err/10 text-err">
                      <IconAlert className="h-3 w-3" /> 磁盘上找不到，只能清理记录
                    </Badge>
                  )}
                  {detail.download && (
                    <Badge className="border-white/10 bg-white/[0.04] text-slate-400">
                      {detail.download.channel_title}
                    </Badge>
                  )}
                  {detail.nfo.episode?.exists ? (
                    <Badge className="border-ok/20 bg-ok/10 text-ok">
                      <IconCheck className="h-3 w-3" /> 单集 NFO
                    </Badge>
                  ) : (
                    !isFolderTarget && (
                      <Badge className="border-warn/20 bg-warn/10 text-warn">缺单集 NFO</Badge>
                    )
                  )}
                  {detail.nfo.show?.exists && (
                    <Badge className="border-white/10 bg-white/[0.04] text-slate-400">tvshow.nfo</Badge>
                  )}
                  {detail.ffmpeg.available ? (
                    <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-300">
                      ffmpeg {detail.ffmpeg.version ?? ""}
                    </Badge>
                  ) : (
                    <Badge className="border-rose-500/20 bg-rose-500/10 text-rose-300">
                      <IconAlert className="h-3 w-3" /> 无 ffmpeg
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  onClick={() => void loadDetail(detail.target.key)}
                  loading={detailLoading}
                  title="重新读取"
                >
                  <IconRefresh className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  onClick={() => void generateNfo()}
                  loading={genNfo}
                  title="为整个剧集批量生成单集 NFO 与 tvshow.nfo（tgsub 下载的会复用下载信息补全）"
                >
                  <IconSpark className="h-3.5 w-3.5" />
                  生成 NFO
                </Button>
                <Button
                  size="sm"
                  onClick={() => void generateImages()}
                  loading={genImages}
                  title="为整个剧集批量生成封面（缺图时随机截帧）"
                >
                  <IconImage className="h-3.5 w-3.5" />
                  生成图片
                </Button>
                {isFolderTarget && (
                  <Button
                    size="sm"
                    onClick={() => setRenameOpen(true)}
                    title="把目录和每一集的文件名一起改成「剧名S01E01」，集号按原顺序重排"
                  >
                    <IconEdit className="h-3.5 w-3.5" />
                    重命名文件
                  </Button>
                )}
                {detail.download && (
                  <a
                    className="btn-ghost !px-2.5 !py-1.5 !text-[12.5px]"
                    href={`/api/downloads/${detail.download.id}/file`}
                    download
                  >
                    <IconDownload className="h-3.5 w-3.5" />
                    视频
                  </a>
                )}
              </div>
            </header>

            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {[
                { key: "basic" as const, label: "基本信息", icon: <IconEdit className="h-3.5 w-3.5" /> },
                { key: "images" as const, label: "图片", icon: <IconImage className="h-3.5 w-3.5" /> },
                { key: "nfo" as const, label: "NFO 原文", icon: <IconCode className="h-3.5 w-3.5" /> },
              ].map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12.5px] transition ${
                    tab === t.key
                      ? "border-brand-400 text-white"
                      : "border-transparent text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-1 py-1.5">
                {(["episode", "show"] as const).map((k) => {
                  const disabled = k === "episode" && isFolderTarget;
                  return (
                    <button
                      key={k}
                      disabled={disabled}
                      onClick={() => setKind(k)}
                      title={disabled ? "单集 NFO 需要选中具体视频文件" : undefined}
                      className={`rounded-lg px-2 py-1 text-[11.5px] transition disabled:opacity-35 ${
                        kind === k ? "bg-brand-500/15 text-brand-200" : "text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {k === "episode" ? "单集" : "剧集(tvshow)"}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {tab === "basic" && (
                <BasicTab
                  detail={detail}
                  kind={kind}
                  fields={fields}
                  dirty={dirty}
                  saving={saving}
                  onChange={update}
                  onSave={() => void save()}
                  onOpenRaw={() => setTab("nfo")}
                />
              )}
              {tab === "images" && (
                <ImagesTab
                  detail={detail}
                  scopes={scopes}
                  imageScope={imageScope}
                  setImageScope={setImageScope}
                  imageOf={imageOf}
                  onPick={(scope, name) => setPicker({ scope, name })}
                  onRemove={(scope, name) => void removeImage(scope, name)}
                  onOpenSettings={() => {
                    window.location.hash = "/settings";
                  }}
                />
              )}
              {tab === "nfo" && (
                <NfoTab
                  detail={detail}
                  kind={kind}
                  onSaved={async () => {
                    if (!selected) return;
                    await loadDetail(selected.key, true);
                    await fetchList(page, true);
                  }}
                />
              )}
            </div>
          </>
        )}
      </section>

      {detail && picker && (
        <ImagePicker
          detail={detail}
          scope={picker.scope}
          name={picker.name}
          onClose={() => setPicker(null)}
          onDone={async () => {
            setPicker(null);
            await loadDetail(detail.target.key, true);
            await fetchList(page, true);
          }}
        />
      )}

      <AddSourceDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={async () => {
          await fetchList(page, true);
        }}
      />

      {/* 删除媒体条目（可连磁盘文件一起删，也可只移出列表） */}
      <MediaDeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDone={async () => {
          await fetchList(page, true);
        }}
      />

      {/* 移动 / 复制到另一个目录 */}
      <TransferDialog
        target={transfer}
        onClose={() => setTransfer(null)}
        onDone={async () => {
          setChecked(new Set());
          await fetchList(page, true);
        }}
      />

      {/* 批量删除勾选的条目 */}
      <BatchDeleteDialog
        items={batchDelete}
        onClose={() => setBatchDelete(null)}
        onDone={async () => {
          setChecked(new Set());
          await fetchList(page, true);
        }}
      />

      {/* 合并勾选的视频为一部剧（可跨文件夹） */}
      {mergeOpen && (
        <MergeSeriesDialog
          keys={[...checked]}
          onClose={() => setMergeOpen(false)}
          onDone={async (key) => {
            setMergeOpen(false);
            setChecked(new Set());
            await fetchList(page, true);
            setSelected({ key, kind: "folder" });
          }}
        />
      )}

      {/* 剧集改名：目录与每一集的文件名一起改 */}
      {renameOpen && detail && detail.target.kind === "folder" && (
        <RenameSeriesDialog
          itemKey={detail.target.key}
          currentTitle={detail.fields.show.title || detail.target.name}
          onClose={() => setRenameOpen(false)}
          onDone={async (key) => {
            setRenameOpen(false);
            await fetchList(page, true);
            // 目录名变了，旧的 key 已经失效，切到新路径
            setSelected({ key, kind: "folder" });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ 基本信息 ------------------------------ */

function BasicTab({
  detail,
  kind,
  fields,
  dirty,
  saving,
  onChange,
  onSave,
  onOpenRaw,
}: {
  detail: MetadataDetail;
  kind: "episode" | "show";
  fields: NfoFields;
  dirty: boolean;
  saving: boolean;
  onChange: (patch: Partial<NfoFields>) => void;
  onSave: () => void;
  onOpenRaw: () => void;
}) {
  const probe = detail.video?.probe ?? null;
  const slot = detail.nfo[kind];
  const locked = Boolean(slot && !slot.editable);
  /** 剧集目录下的视频信息来自第一集，标注一下免得误解 */
  const fromFirst = detail.video?.source === "first";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <InfoCell label="时长" value={probe?.duration ? formatDuration(probe.duration) : "—"} />
        <InfoCell
          label="分辨率"
          value={probe?.width && probe?.height ? `${probe.width}×${probe.height}` : "—"}
        />
        <InfoCell label="编码" value={probe ? `${probe.videoCodec ?? "?"} / ${probe.audioCodec ?? "?"}` : "—"} />
        <InfoCell
          label="码率 / 帧率"
          value={probe ? `${probe.bitrate ? `${Math.round(probe.bitrate / 1000)} kbps` : "—"} · ${probe.fps ?? "?"}fps` : "—"}
        />
      </div>

      {fromFirst && (
        <p className="text-[11.5px] text-slate-500">以上视频信息取自第一集，剧集封面同样以第一集为准。</p>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11.5px] text-slate-400">
        <span className="text-slate-500">文件：</span>
        <span className="font-mono text-slate-300">{slot?.file ?? "（将新建）"}</span>
        {slot?.exists && <span className="text-slate-500">· {formatBytes(slot.size)}</span>}
        {locked && (
          <span className="ml-auto flex items-center gap-1 text-warn">
            <IconAlert className="h-3.5 w-3.5" />
            该 NFO 含嵌套标签，请用「NFO 原文」编辑
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="标题 title" value={fields.title} onChange={(v) => onChange({ title: v })} />
        {/* tvshow.nfo 没有 showtitle 这个概念，只在单集里出现 */}
        {kind === "episode" && (
          <Field label="剧名 showtitle" value={fields.showtitle} onChange={(v) => onChange({ showtitle: v })} />
        )}
        <Field label="原名 originaltitle" value={fields.originaltitle} onChange={(v) => onChange({ originaltitle: v })} />
        <Field label="制片厂 studio" value={fields.studio} onChange={(v) => onChange({ studio: v })} />
        {kind === "episode" && (
          <>
            <div className="grid grid-cols-3 gap-2 sm:col-span-2">
              <Field label="季 season" value={fields.season} onChange={(v) => onChange({ season: v })} mono />
              <Field label="集 episode" value={fields.episode} onChange={(v) => onChange({ episode: v })} mono />
              <Field label="年份 year" value={fields.year} onChange={(v) => onChange({ year: v })} mono />
            </div>
            <Field label="首播 aired" value={fields.aired} onChange={(v) => onChange({ aired: v })} placeholder="2026-11-01" />
            <Field label="评分 rating" value={fields.rating} onChange={(v) => onChange({ rating: v })} placeholder="0-10" mono />
          </>
        )}
        {kind === "show" && (
          <Field label="首播 premiered" value={fields.premiered} onChange={(v) => onChange({ premiered: v })} placeholder="2026-11-01" />
        )}
      </div>

      <TagEditor label="标签 tag（剧情/来源等）" values={fields.tags} onChange={(tags) => onChange({ tags })} />
      <TagEditor label="分类 genre" values={fields.genres} onChange={(genres) => onChange({ genres })} />

      <div>
        <label className="label">简介 plot</label>
        <textarea
          className="field min-h-[110px] leading-relaxed"
          value={fields.plot}
          onChange={(e) => onChange({ plot: e.target.value })}
          placeholder="Emby 详情页显示的剧情简介"
        />
      </div>
      <div>
        <label className="label">短简介 outline</label>
        <textarea
          className="field min-h-[60px] leading-relaxed"
          value={fields.outline}
          onChange={(e) => onChange({ outline: e.target.value })}
          placeholder="留空时会取简介前 200 字"
        />
      </div>

      <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-2 border-t border-white/[0.06] bg-ink-850/95 px-4 py-3 backdrop-blur">
        <span className="text-[11.5px] text-slate-500">
          {dirty
            ? "有未保存的修改"
            : detail.download
              ? `已同步 · ${formatDateTime(detail.download.finished_at)} 下载`
              : "手动来源 · 已与磁盘同步"}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onOpenRaw} title="用原始 XML 编辑">
            <IconCode className="h-3.5 w-3.5" />
            原文
          </Button>
          <Button size="sm" variant="primary" loading={saving} disabled={!dirty || locked} onClick={onSave}>
            <IconCheck className="h-3.5 w-3.5" />
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <p className="text-[10.5px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-[12.5px] tabular-nums text-slate-200" title={value}>
        {value}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className={`field ${mono ? "font-mono tabular-nums" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function TagEditor({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
  };

  return (
    <div>
      <label className="label">{label}</label>
      <div className="rounded-xl border border-white/[0.08] bg-ink-900/70 p-2">
        <div className="flex flex-wrap gap-1.5">
          {values.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-lg border border-brand-500/25 bg-brand-500/10 px-2 py-0.5 text-[11.5px] text-brand-200"
            >
              {tag}
              <button
                onClick={() => onChange(values.filter((v) => v !== tag))}
                className="text-brand-300/70 transition hover:text-white"
                aria-label={`移除 ${tag}`}
              >
                <IconX className="h-3 w-3" />
              </button>
            </span>
          ))}
          {values.length === 0 && <span className="px-1 py-0.5 text-[11.5px] text-slate-600">暂无</span>}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            className="field !py-1.5 !text-[12px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="输入后回车添加"
          />
          <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={add} disabled={!draft.trim()}>
            添加
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 图片 ------------------------------ */

function ImagesTab({
  detail,
  scopes,
  imageScope,
  setImageScope,
  imageOf,
  onPick,
  onRemove,
  onOpenSettings,
}: {
  detail: MetadataDetail;
  scopes: ImageScope[];
  imageScope: ImageScope;
  setImageScope: (scope: ImageScope) => void;
  imageOf: (scope: ImageScope, name: ImageName) => MetadataDetail["images"][number] | null;
  onPick: (scope: ImageScope, name: ImageName) => void;
  onRemove: (scope: ImageScope, name: ImageName) => void;
  onOpenSettings: () => void;
}) {
  const [zoom, setZoom] = useState<{ url: string; label: string } | null>(null);

  return (
    <div className="space-y-4">
      {!detail.ffmpeg.available && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2.5">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div className="text-[12px] leading-relaxed text-amber-100/90">
            未找到 ffmpeg，暂时无法从视频截图。可在
            <button onClick={onOpenSettings} className="mx-1 underline decoration-amber-400/50 hover:text-white">
              设置
            </button>
            里填写 ffmpeg 可执行文件路径，或安装 ffmpeg 后点右上角刷新。
            <span className="mt-0.5 block text-[11px] text-amber-200/60">{detail.ffmpeg.error}</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {scopes.length > 1 ? (
          <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
            {scopes.map((scope) => (
              <button
                key={scope}
                onClick={() => setImageScope(scope)}
                className={`rounded-lg px-2.5 py-1 text-[12px] transition ${
                  imageScope === scope ? "bg-brand-500/20 text-brand-100" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {scopeLabel(scope)}
              </button>
            ))}
          </div>
        ) : (
          <span className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[12px] text-brand-100">
            {scopeLabel(imageScope)}
          </span>
        )}
        <p className="text-[11.5px] text-slate-500">
          {imageScope === "episode"
            ? "文件名带集数前缀，Emby 会优先用它"
            : "放在剧集目录，整剧共用；截图取自第一集"}
        </p>
      </div>

      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {slotsOf(imageScope).map((slot) => {
          const img = imageOf(imageScope, slot.name);
          return (
            <div key={slot.name} className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]">
              <div className="relative h-[168px] w-full bg-ink-950/60">
                {img ? (
                  <>
                    <img
                      src={img.url}
                      alt={slot.label}
                      className="h-full w-full cursor-zoom-in rounded-lg object-contain"
                      onClick={() => setZoom({ url: img.url, label: slot.label })}
                    />
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] tabular-nums text-[#fff]/80">
                      {img.width && img.height ? `${img.width}×${img.height}` : formatBytes(img.size)}
                    </span>
                  </>
                ) : (
                  <button
                    onClick={() => onPick(imageScope, slot.name)}
                    className="flex h-full w-full flex-col items-center justify-center gap-1 text-slate-600 transition hover:text-slate-400"
                  >
                    <IconImage className="h-5 w-5" />
                    <span className="text-[11px]">未设置</span>
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[12px] text-slate-200">{slot.label}</p>
                  <p className="text-[10.5px] text-slate-500">{slot.hint}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" onClick={() => onPick(imageScope, slot.name)} title="更换">
                    <IconEdit className="h-3 w-3" />
                  </Button>
                  {img && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onRemove(imageScope, slot.name)}
                      title="删除这张图"
                    >
                      <IconTrash className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {detail.extras.length > 0 && (
        <div>
          <p className="label">目录里的其它图片（只读）</p>
          <div className="flex flex-wrap gap-2">
            {detail.extras.map((file) => (
              <a
                key={file.file}
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="overflow-hidden rounded-lg border border-white/10"
                title={file.file}
              >
                <img src={file.url} alt={file.file} className="h-16 w-16 rounded-lg object-cover" />
              </a>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11.5px] leading-relaxed text-slate-500">
        改完图片后，在 Emby 里对该剧「刷新元数据 → 替换现有图片」才会立刻更新；新剧直接扫描即可。
      </p>

      <Modal
        open={Boolean(zoom)}
        onClose={() => setZoom(null)}
        title={zoom?.label ?? ""}
        width="max-w-3xl"
        footer={
          <Button size="sm" onClick={() => setZoom(null)}>
            关闭
          </Button>
        }
      >
        {zoom && <img src={zoom.url} alt={zoom.label} className="max-h-[70vh] w-full rounded-xl object-contain" />}
      </Modal>
    </div>
  );
}

/* ------------------------------ 手动添加来源 ------------------------------ */

function AddSourceDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [path, setPath] = useState("");
  const [sources, setSources] = useState<MetadataSource[]>([]);
  const [excluded, setExcluded] = useState<MetadataExcludedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const res = await api.metadataSources();
      setSources(res.items);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  const loadExcluded = useCallback(async () => {
    try {
      const res = await api.metadataExcluded();
      setExcluded(res.items);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  const browseTo = useCallback(
    async (target?: string) => {
      setLoading(true);
      try {
        const res = await api.metadataBrowse(target);
        setBrowse(res);
        setPath(res.path);
      } catch (err) {
        toast.push((err as Error).message, "error");
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (!open) return;
    void browseTo();
    void loadSources();
    void loadExcluded();
  }, [open, browseTo, loadSources, loadExcluded]);

  const add = async (target: string, title?: string) => {
    setBusy(true);
    try {
      await api.addMetadataSource(target, title);
      toast.push("已添加媒体来源", "success");
      await loadSources();
      await onAdded();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    try {
      await api.removeMetadataSource(id);
      toast.push("已移除来源", "success");
      await loadSources();
      await onAdded();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  /** 取消隐藏：被「仅从列表移除」的条目重新回到列表里 */
  const restore = async (target: string) => {
    setBusy(true);
    try {
      await api.restoreMetadataExcluded(target);
      toast.push("已恢复显示", "success");
      await loadExcluded();
      await onAdded();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="手动添加媒体来源"
      description="除了项目下载的文件，也可以选服务器上的本地视频文件或视频目录，一样能生成 NFO 和封面。"
      width="max-w-3xl"
      footer={
        <Button size="sm" onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="space-y-4">
        {/* 已登记的来源 */}
        <div>
          <p className="label">已添加的来源（{sources.length}）</p>
          {sources.length === 0 ? (
            <p className="text-[11.5px] text-slate-500">还没有手动添加的来源。</p>
          ) : (
            <ul className="space-y-1.5">
              {sources.map((source) => (
                <li
                  key={source.id}
                  className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5"
                >
                  <IconFolder className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate font-mono text-[11.5px] text-slate-300"
                      title={source.path}
                    >
                      {source.path}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-slate-500">
                      {source.kind === "dir" ? "目录" : "文件"}
                      {source.fileCount > 0 && ` · ${source.fileCount} 个视频`}
                      {source.folderCount > 1 &&
                        ` · 展开为 ${source.folderCount} 个剧集：${source.folderNames.join("、")}`}
                      {source.folderCount === 1 && source.folderNames[0] &&
                        ` · 剧集「${source.folderNames[0]}」`}
                    </span>
                  </span>
                  <Badge className="shrink-0 border-white/10 bg-white/[0.04] text-slate-400">
                    {source.kind === "dir" ? "目录" : "文件"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => void remove(source.id)}
                    title="移除"
                  >
                    <IconTrash className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {sources.length > 0 && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
              添加一个上级目录时，会自动按里面的剧集文件夹拆开显示；移除来源不会删除磁盘文件。
            </p>
          )}
        </div>

        {/* 被「仅从列表移除」隐藏的条目：可以恢复显示 */}
        <div>
          <p className="label">已隐藏的项目（{excluded.length}）</p>
          {excluded.length === 0 ? (
            <p className="text-[11.5px] text-slate-500">没有被隐藏的项目。</p>
          ) : (
            <ul className="space-y-1.5">
              {excluded.map((item) => (
                <li
                  key={item.path}
                  className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5"
                >
                  <IconFolder className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-300" title={item.path}>
                    {item.path}
                  </span>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void restore(item.path)}
                    title="恢复显示"
                  >
                    恢复
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {excluded.length > 0 && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
              这些条目只从列表里移除了，磁盘文件仍在。恢复后会重新显示。
            </p>
          )}
        </div>

        {/* 目录浏览 */}
        <div>
          <p className="label">浏览服务器目录</p>
          <div className="flex items-center gap-1.5">
            <input
              className="field font-mono !py-1.5 !text-[11.5px]"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && path.trim()) void browseTo(path.trim());
              }}
              placeholder="输入绝对路径后回车"
            />
            <Button size="sm" className="shrink-0" loading={loading} onClick={() => void browseTo(path.trim())}>
              跳转
            </Button>
          </div>

          {browse && (
            <div className="mt-2 overflow-hidden rounded-xl border border-white/[0.07]">
              <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400"
                  title={browse.path}
                >
                  {browse.path}
                </span>
                {browse.parent && (
                  <Button size="sm" onClick={() => void browseTo(browse.parent ?? undefined)} title="上一级">
                    <IconChevronLeft className="h-3 w-3" />
                    上一级
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void add(browse.path)}
                  title="把当前目录作为媒体来源"
                >
                  <IconFolder className="h-3 w-3" />
                  添加此目录
                </Button>
              </div>

              <div className="max-h-[260px] overflow-y-auto">
                {browse.dirs.length === 0 && browse.files.length === 0 && (
                  <p className="px-3 py-6 text-center text-[11.5px] text-slate-500">这个目录里没有视频</p>
                )}
                {browse.dirs.map((dir) => (
                  <button
                    key={dir.path}
                    onClick={() => void browseTo(dir.path)}
                    className="flex w-full items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 text-left transition hover:bg-white/[0.04]"
                  >
                    <IconFolder className="h-3.5 w-3.5 shrink-0 text-brand-300" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{dir.name}</span>
                    <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                  </button>
                ))}
                {browse.files.map((file) => (
                  <div key={file.path} className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5">
                    <IconVideo className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300" title={file.path}>
                      {file.name}
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-slate-500">
                      {formatBytes(file.size)}
                    </span>
                    <Button size="sm" disabled={busy} onClick={() => void add(file.path)} title="把这个视频作为来源">
                      <IconPlus className="h-3 w-3" />
                      添加
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------ 图片来源选择 ------------------------------ */

function ImagePicker({
  detail,
  scope,
  name,
  onClose,
  onDone,
}: {
  detail: MetadataDetail;
  scope: ImageScope;
  name: ImageName;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const toast = useToast();
  const slot = IMAGE_SLOTS.find((s) => s.name === name) ?? IMAGE_SLOTS[0];
  const key = detail.target.key;
  /** 剧集目录：截图取自第一集；单集：就是它自己 */
  const isSeriesTarget = detail.target.kind === "folder";
  const [tab, setTab] = useState<"frame" | "upload" | "existing">(
    detail.ffmpeg.available && detail.video?.exists ? "frame" : "upload",
  );
  const [busy, setBusy] = useState(false);

  // 截图
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [at, setAt] = useState(0);
  const [fit, setFit] = useState<"cover" | "contain" | "stretch" | "blur">("blur");
  const [candidates, setCandidates] = useState<FrameCandidate[]>([]);
  const [grabbing, setGrabbing] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const duration = detail.video?.probe?.duration ?? 0;

  // 上传
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 手动框选：src 是要框的画面，apply 决定框完拿这张图做什么
  const [cropper, setCropper] = useState<{ src: string; apply: (crop: CropRect | null) => void } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const openCropper = (src: string, apply: (crop: CropRect | null) => void) => {
    setCropper({ src, apply });
  };
  const closeCropper = () => {
    if (cropper?.src.startsWith("blob:")) URL.revokeObjectURL(cropper.src);
    setCropper(null);
  };

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toast.push(message, "success");
      await onDone();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const grab = async () => {
    setGrabbing(true);
    try {
      const res = await api.frameCandidates(key, 8);
      setCandidates(res.items);
      if (res.items.length > 0) {
        setSelectedFrame(0);
        setAt(res.items[0].at);
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setGrabbing(false);
    }
  };

  useEffect(() => {
    if (tab !== "frame" || candidates.length > 0 || grabbing) return;
    void grab();
    // 打开截图页时自动抽一组候选帧，省一次点击
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const seekTo = (seconds: number) => {
    setAt(seconds);
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, seconds);
    }
  };

  /** 先取当前时间点的原始画面，让用户框选，再按框选范围截图落盘 */
  const cropFrame = async () => {
    setPreviewing(true);
    try {
      const res = await api.framePreview(key, at);
      openCropper(res.url, (crop) => {
        setCropper(null);
        void run(
          () => api.captureFrame(key, { at, scope, name, fit, crop }),
          crop ? "已按框选范围截取封面" : "已从视频截取并写入封面",
        );
      });
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setPreviewing(false);
    }
  };

  const otherImages = detail.images.filter((img) => !(img.scope === scope && img.name === name));

  return (
    <>
      <Modal
      open
      onClose={onClose}
      title={`更换 ${scopeLabel(scope)} · ${slot.label}`}
      description={`目标尺寸 ${slot.hint.replace(/^[^·]*·\s*/, "")}，非该比例会按「${
        fit === "cover" ? "裁剪铺满" : fit === "contain" ? "留黑边完整显示" : fit === "blur" ? "模糊填充" : "拉伸"
      }」处理`}
      width="max-w-3xl"      footer={
        <>
          <Button size="sm" onClick={onClose}>
            取消
          </Button>
          {tab === "frame" && (
            <>
              <Button size="sm" loading={previewing} onClick={() => void cropFrame()} title="拖动选框指定要截取的画面范围">
                <IconCrop className="h-3.5 w-3.5" />
                框选这一帧
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                onClick={() =>
                  void run(
                    () => api.captureFrame(key, { at, scope, name, fit }),
                    "已从视频截取并写入封面",
                  )
                }
              >
                <IconCamera className="h-3.5 w-3.5" />
                用 {at.toFixed(1)}s 这一帧
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {[
            { key: "frame" as const, label: "从视频截图", icon: <IconCamera className="h-3.5 w-3.5" />, disabled: false },
            { key: "upload" as const, label: "上传图片", icon: <IconUpload className="h-3.5 w-3.5" />, disabled: false },
            { key: "existing" as const, label: "用已有图片", icon: <IconPhoto className="h-3.5 w-3.5" />, disabled: false },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition ${
                tab === t.key ? "bg-brand-500/20 text-brand-100" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* 缩放方式对所有来源（截图 / 上传 / 复用）生效，比例不符时默认模糊填充 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-slate-500">缩放方式</span>
          <select
            value={fit}
            onChange={(e) => setFit(e.target.value as "cover" | "contain" | "stretch" | "blur")}
            className="field !w-auto !py-1 !text-[11.5px]"
            title="比例与目标尺寸不一致时怎么处理"
          >
            <option value="blur">模糊填充（推荐）</option>
            <option value="contain">留黑边（完整显示）</option>
            <option value="cover">裁剪铺满</option>
            <option value="stretch">拉伸变形</option>
          </select>
          <span className="text-[11px] text-slate-600">
            {fit === "blur"
              ? "完整画面居中，空出来的边用同一张图的模糊版填满"
              : fit === "contain"
                ? "比例不一致时补黑边，不裁掉画面"
                : fit === "cover"
                  ? "比例不一致时裁掉超出部分"
                  : "比例不一致时强行拉伸"}
          </span>
        </div>

        {tab === "frame" && (
          <div className="space-y-3">
            {!detail.ffmpeg.available || !detail.video?.exists ? (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-[12px] text-amber-100/90">
                {detail.video?.exists ? "未找到 ffmpeg，无法截图。" : "视频文件不在了，无法截图。"}
              </div>
            ) : (
              <>
                {isSeriesTarget && (
                  <p className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[11.5px] text-slate-400">
                    剧集封面取自第一集，下面播放与截取的都是第一集的画面。
                  </p>
                )}
                <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
                  <video
                    ref={videoRef}
                    src={`/api/metadata/video?key=${encodeURIComponent(key)}`}
                    poster={detail.images.find((img) => img.name === "poster")?.url}
                    controls
                    preload="metadata"
                    className="max-h-[42vh] w-full bg-black"
                    onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(duration))}
                    step={0.2}
                    value={Math.min(at, Math.max(1, Math.floor(duration)))}
                    onChange={(e) => seekTo(Number(e.target.value))}
                    className="h-1.5 flex-1 min-w-[160px] cursor-pointer appearance-none rounded-full bg-white/10 accent-brand-400"
                  />
                  <span className="w-[128px] shrink-0 whitespace-nowrap text-right text-[11.5px] tabular-nums text-slate-400">
                    {at.toFixed(1)}s / {duration ? formatDuration(duration) : "—"}
                  </span>
                  <Button size="sm" onClick={() => void grab()} loading={grabbing}>
                    <IconRefresh className="h-3.5 w-3.5" />
                    抽帧
                  </Button>
                </div>

                {candidates.length > 0 && (
                  <div>
                    <p className="label">候选帧（点一下定位到该时间点）</p>
                    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
                      {candidates.map((frame) => (
                        <button
                          key={frame.index}
                          onClick={() => {
                            setSelectedFrame(frame.index);
                            seekTo(frame.at);
                          }}
                          className={`relative overflow-hidden rounded-md border transition ${
                            selectedFrame === frame.index
                              ? "border-brand-400 ring-1 ring-brand-400/40"
                              : "border-white/10 hover:border-white/25"
                          }`}
                          title={`${frame.at}s`}
                        >
                          <img src={frame.url} alt={`${frame.at}s`} className="aspect-video w-full object-cover" />
                          <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[9.5px] tabular-nums text-[#fff]/80">
                            {frame.at.toFixed(0)}s
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === "upload" && (
          <div className="space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                // 选完图先让用户框选（比例锁定当前封面类型），再上传
                const url = URL.createObjectURL(file);
                openCropper(url, (crop) => {
                  setCropper(null);
                  URL.revokeObjectURL(url);
                  void run(
                    () => api.uploadImage(key, scope, name, file, { fit, crop }),
                    "图片已上传并写入封面",
                  );
                });
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.02] py-10 text-slate-400 transition hover:border-brand-400/40 hover:bg-brand-500/[0.05] disabled:opacity-50"
            >
              {busy ? <Spinner /> : <IconUpload className="h-6 w-6" />}
              <span className="text-[12.5px]">点击选择本地图片（jpg / png / webp，≤ 30MB）</span>
              <span className="text-[11px] text-slate-600">
                选完可以框选画面，比例锁定 {slot.hint.replace(/^([^·]*)·.*$/, "$1").trim()}；不框则按
                {fit === "blur" ? "模糊填充（默认）" : fit === "contain" ? "留黑边" : fit === "cover" ? "裁剪" : "拉伸"}
              </span>
            </button>
          </div>
        )}

        {tab === "existing" && (
          <div className="space-y-4">
            <div>
              <p className="label">消息里的原图</p>
              {detail.covers.length === 0 ? (
                <p className="text-[11.5px] text-slate-500">这条消息没有可用的图片缓存。</p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {detail.covers.map((cover) => (
                    <button
                      key={cover.file}
                      disabled={busy}
                      onClick={() =>
                        openCropper(`/api/messages/cover/${cover.file}`, (crop) => {
                          setCropper(null);
                          void run(
                            () => api.useCoverImage(key, { file: cover.file, scope, name, fit, crop }),
                            "已使用消息原图",
                          );
                        })
                      }
                      className="overflow-hidden rounded-lg border border-white/10 transition hover:border-brand-400/50 disabled:opacity-50"
                      title="点一下可以框选画面"
                    >
                      <img
                        src={`/api/messages/cover/${cover.file}`}
                        alt={cover.file}
                        className="aspect-[2/3] w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="label">目录里已有的图片</p>
              {otherImages.length === 0 ? (
                <p className="text-[11.5px] text-slate-500">还没有别的图片可复用。</p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {otherImages.map((img) => (
                    <button
                      key={`${img.scope}-${img.name}`}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api.copyImage(key, {
                              fromScope: img.scope,
                              fromName: img.name,
                              toScope: scope,
                              toName: name,
                              fit,
                            }),
                          `已复制「${img.label}」`,
                        )
                      }
                      className="overflow-hidden rounded-lg border border-white/10 text-left transition hover:border-brand-400/50 disabled:opacity-50"
                      title={img.file}
                    >
                      <img src={img.url} alt={img.file} className="aspect-video w-full object-cover" />
                      <span className="block truncate px-1.5 py-1 text-[10.5px] text-slate-400">
                        {img.scope === "episode" ? "单集 · " : ""}
                        {img.file}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      </Modal>

      {cropper && (
        <CropDialog
          open
          src={cropper.src}
          ratio={slot.aspect}
          targetLabel={slot.hint.replace(/^([^·]*)·.*$/, "$1").trim()}
          onCancel={closeCropper}
          onApply={(crop) => cropper.apply(crop)}
          onUseFull={() => cropper.apply(null)}
        />
      )}
    </>
  );
}

/* ------------------------------ NFO 原文 ------------------------------ */

function NfoTab({
  detail,
  kind,
  onSaved,
}: {
  detail: MetadataDetail;
  kind: "episode" | "show";
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const key = detail.target.key;
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [exists, setExists] = useState(false);
  const [file, setFile] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.readNfo(key, kind);
      setContent(res.content);
      setOriginal(res.content);
      setExists(res.exists);
      setFile(res.file);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [key, kind, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = content !== original;

  const save = async () => {
    setSaving(true);
    try {
      await api.saveNfoRaw(key, kind, content);
      setOriginal(content);
      setExists(true);
      toast.push("NFO 已保存", "success");
      await onSaved();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11.5px] text-slate-500">
          <span className="font-mono text-slate-300">{file || `${kind}.nfo`}</span>
          <span>·</span>
          <span>{exists ? "已存在" : "将按表单值新建"}</span>
          <span>·</span>
          <span className="tabular-nums">{content.length} 字符</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={() => void load()} loading={loading} title="重新读取磁盘上的文件">
            <IconRefresh className="h-3.5 w-3.5" />
            重新读取
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
            <IconCheck className="h-3.5 w-3.5" />
            保存
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-slate-500">
          <Spinner /> 读取中…
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="field min-h-[46vh] w-full whitespace-pre font-mono text-[11.5px] leading-relaxed"
        />
      )}

      <p className="text-[11.5px] leading-relaxed text-slate-500">
        直接改 XML 会原样写回磁盘；保存时会尝试把能识别的字段同步回数据库，后续自动生成时保持一致。
        保存后 Emby 需要「刷新元数据」才会看到变化。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 改名 / 合并剧集                                                     */
/* ------------------------------------------------------------------ */

/** 从路径里取文件名（前端没有 node:path） */
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

const pad2 = (n: number): string => String(Math.max(0, Math.floor(n))).padStart(2, "0");

/**
 * 改名 / 合并共用的预览：一行一个「原文件 → 新文件」。
 *
 * 磁盘操作不可撤销，动手前必须让人看清每一条会变成什么。
 */
function RenamePlanView({ plan }: { plan: RenamePlanPreview }) {
  const last = plan.items.length;
  return (
    <div className="space-y-2.5">
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11.5px]">
        <div className="flex gap-2">
          <span className="w-16 shrink-0 text-slate-500">目标目录</span>
          <span className="min-w-0 break-all font-mono text-slate-300">{plan.targetDir}</span>
        </div>
        <div className="mt-1 flex gap-2">
          <span className="w-16 shrink-0 text-slate-500">命名规则</span>
          <span className="min-w-0 break-all font-mono text-slate-300">
            {plan.title}S{pad2(plan.season)}E01 … E{pad2(last)}
          </span>
        </div>
      </div>

      {plan.warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warn">
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {w}
        </p>
      ))}

      {plan.conflicts.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-rose-300">
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          目标位置已有同名文件：{plan.conflicts.slice(0, 5).join("、")}
          {plan.conflicts.length > 5 ? ` 等 ${plan.conflicts.length} 个` : ""}。换个剧名或先处理这些文件。
        </p>
      )}

      <div className="max-h-[44vh] overflow-y-auto rounded-xl border border-white/[0.07]">
        <table className="w-full border-collapse text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-ink-850">
            <tr className="text-left text-slate-500">
              <th className="w-9 px-2 py-1.5 font-normal">#</th>
              <th className="px-2 py-1.5 font-normal">原文件</th>
              <th className="w-6 px-0 py-1.5 font-normal" />
              <th className="px-2 py-1.5 font-normal">新文件</th>
            </tr>
          </thead>
          <tbody>
            {plan.items.map((item, idx) => {
              const unchanged = baseName(item.from) === baseName(item.to);
              return (
                <tr key={`${item.from}-${idx}`} className="border-t border-white/[0.05]">
                  <td className="px-2 py-1.5 tabular-nums text-slate-600">{idx + 1}</td>
                  <td className="break-all px-2 py-1.5 text-slate-400" title={item.from}>
                    {baseName(item.from)}
                  </td>
                  <td className="px-0 py-1.5 text-center text-slate-600">→</td>
                  <td
                    className={`break-all px-2 py-1.5 ${unchanged ? "text-slate-500" : "text-slate-200"}`}
                    title={item.to}
                  >
                    {baseName(item.to)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        同名的 <span className="font-mono">.nfo</span> 与缩略图会跟着改名，剧集封面不受影响；
        改完会通知 Emby 重新识别这个目录。
      </p>
    </div>
  );
}

/** 合并：把勾选的视频（可跨文件夹）按集号排成一部剧 */
function MergeSeriesDialog({
  keys,
  onClose,
  onDone,
}: {
  keys: string[];
  onClose: () => void;
  onDone: (key: string) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [plan, setPlan] = useState<RenamePlanPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dep = keys.join("|");

  useEffect(() => {
    const name = title.trim();
    if (!name) {
      setPlan(null);
      setError(null);
      return undefined;
    }
    let alive = true;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api
        .previewMerge(keys, name)
        .then((res) => {
          if (!alive) return;
          setPlan(res.plan);
          setError(null);
        })
        .catch((err: Error) => {
          if (!alive) return;
          setPlan(null);
          setError(err.message);
        })
        .finally(() => {
          if (alive) setPreviewing(false);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // keys 用 dep 代替，避免每次渲染都重新预览
  }, [title, dep]);

  const run = async () => {
    if (!plan || plan.conflicts.length > 0) return;
    setRunning(true);
    try {
      const res = await api.mergeSeries(keys, title.trim());
      toast.push(`已合并 ${res.result.moved} 个视频 → ${res.title}`, "success");
      onDone(res.key);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="合并为剧集"
      description="勾选的视频会按集号排序，重排成连续的 E01…EN，并搬进同一个剧集目录"
      width="max-w-2xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-slate-500">
            {plan ? `${plan.items.length} 个文件` : `已选 ${keys.length} 个视频`}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={running}
              disabled={!plan || previewing || plan.conflicts.length > 0}
              onClick={() => void run()}
            >
              <IconCheck className="h-3.5 w-3.5" />
              开始合并
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">剧集名称</label>
          <input
            className="field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：我的妈妈徐秋曼"
            autoFocus
          />
          <p className="mt-1 text-[11px] text-slate-500">
            会建成「剧名/剧名S01E01.mp4」这样的结构；目标目录默认取勾选文件的公共上级目录。
          </p>
        </div>

        {previewing && (
          <div className="flex items-center gap-2 py-6 text-[12px] text-slate-500">
            <Spinner /> 正在算新的文件名…
          </div>
        )}
        {!previewing && error && (
          <p className="flex items-start gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/[0.08] px-3 py-2 text-[11.5px] leading-relaxed text-rose-300">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
        {!previewing && plan && <RenamePlanView plan={plan} />}
      </div>
    </Modal>
  );
}

/** 剧集改名：目录名 + 目录内每一集的文件名一起改 */
function RenameSeriesDialog({
  itemKey,
  currentTitle,
  onClose,
  onDone,
}: {
  itemKey: string;
  currentTitle: string;
  onClose: () => void;
  onDone: (key: string) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(currentTitle);
  const [plan, setPlan] = useState<RenamePlanPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const name = title.trim();
    if (!name) {
      setPlan(null);
      return undefined;
    }
    let alive = true;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api
        .previewRenameSeries(itemKey, name)
        .then((res) => {
          if (!alive) return;
          setPlan(res.plan);
          setError(null);
        })
        .catch((err: Error) => {
          if (!alive) return;
          setPlan(null);
          setError(err.message);
        })
        .finally(() => {
          if (alive) setPreviewing(false);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [title, itemKey]);

  const run = async () => {
    if (!plan || plan.conflicts.length > 0) return;
    setRunning(true);
    try {
      const res = await api.renameSeries(itemKey, title.trim());
      toast.push(`已重命名 ${res.result.moved} 个视频，并同步了 ${res.nfoUpdated} 份 NFO`, "success");
      onDone(res.key);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="重命名剧集文件"
      description="目录名与每一集的文件名一起改成「剧名S01E01」，集号按原顺序重排成连续"
      width="max-w-2xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-slate-500">{plan ? `${plan.items.length} 个文件` : "—"}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={running}
              disabled={!plan || previewing || plan.conflicts.length > 0}
              onClick={() => void run()}
            >
              <IconCheck className="h-3.5 w-3.5" />
              开始重命名
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">剧集名称</label>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <p className="mt-1 text-[11px] text-slate-500">
            只改名字、不动集号的话，把「剧名」改成想要的名字即可 —— 顺序保持原样。
          </p>
        </div>

        {previewing && (
          <div className="flex items-center gap-2 py-6 text-[12px] text-slate-500">
            <Spinner /> 正在算新的文件名…
          </div>
        )}
        {!previewing && error && (
          <p className="flex items-start gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/[0.08] px-3 py-2 text-[11.5px] leading-relaxed text-rose-300">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
        {!previewing && plan && <RenamePlanView plan={plan} />}
      </div>
    </Modal>
  );
}
