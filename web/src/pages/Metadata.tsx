import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  FrameCandidate,
  ImageName,
  ImageScope,
  MetadataDetail,
  MetadataListItem,
  NfoFields,
} from "../types";
import { Badge, Button, EmptyState, Modal, Spinner, useToast } from "../components/ui";
import { PageSizeControl, usePageSize } from "../components/PageSize";
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconDownload,
  IconEdit,
  IconImage,
  IconPhoto,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUpload,
  IconVideo,
  IconX,
} from "../components/icons";
import { formatBytes, formatDateTime, formatDuration } from "../utils";

/* ------------------------------ 常量 ------------------------------ */

const IMAGE_SLOTS: Array<{ name: ImageName; label: string; ratio: string; hint: string }> = [
  { name: "poster", label: "海报 poster", ratio: "aspect-[2/3]", hint: "2:3 · 1000×1500" },
  { name: "landscape", label: "横版 landscape", ratio: "aspect-video", hint: "16:9 · 1920×1080" },
  { name: "fanart", label: "背景 fanart", ratio: "aspect-video", hint: "16:9 · 1920×1080" },
  { name: "thumb", label: "缩略图 thumb", ratio: "aspect-video", hint: "16:9 · 1280×720" },
  { name: "banner", label: "横幅 banner", ratio: "aspect-[1000/185]", hint: "1000×185" },
];

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

/* ------------------------------ 页面 ------------------------------ */

export default function Metadata() {
  const toast = useToast();

  const [pageSize, setPageSize] = usePageSize("metadata", 20);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MetadataListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MetadataDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<"basic" | "images" | "nfo">("basic");
  const [kind, setKind] = useState<"episode" | "show">("episode");

  const [fields, setFields] = useState<NfoFields>(EMPTY_FIELDS);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [picker, setPicker] = useState<{ scope: ImageScope; name: ImageName } | null>(null);
  const [imageScope, setImageScope] = useState<ImageScope>("series");

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const fetchList = useCallback(
    async (target: number, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await api.metadataItems({ q: query.trim(), limit: pageSize, offset: target * pageSize });
        setItems(res.items);
        setTotal(res.total);
        const last = Math.max(0, Math.ceil(res.total / pageSize) - 1);
        if (target > last) setPage(last);
        setSelectedId((prev) => {
          if (prev && res.items.some((i) => i.id === prev)) return prev;
          return res.items[0]?.id ?? null;
        });
      } catch (err) {
        if (!silent) toast.push((err as Error).message, "error");
      } finally {
        setLoading(false);
      }
    },
    [pageSize, query, toast],
  );

  useEffect(() => {
    void fetchList(page);
  }, [fetchList, page]);

  const loadDetail = useCallback(
    async (id: number, silent = false) => {
      if (!silent) setDetailLoading(true);
      try {
        const res = await api.metadataDetail(id);
        setDetail(res);
        setFields(res.fields[kind] ?? EMPTY_FIELDS);
        setDirty(false);
      } catch (err) {
        toast.push((err as Error).message, "error");
      } finally {
        setDetailLoading(false);
      }
    },
    [kind, toast],
  );

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
    // kind 变化由下面单独处理，避免重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

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
      const res = await api.saveMetaFields(detail.item.id, kind, fields);
      toast.push(kind === "episode" ? "单集元数据已保存" : "剧集信息已保存", "success");
      setFields(res.fields);
      setDirty(false);
      await loadDetail(detail.item.id, true);
      await fetchList(page, true);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const imageOf = (scope: ImageScope, name: ImageName) =>
    detail?.images.find((img) => img.scope === scope && img.name === name) ?? null;

  const removeImage = async (scope: ImageScope, name: ImageName) => {
    if (!detail) return;
    try {
      await api.deleteImage(detail.item.id, scope, name);
      toast.push("图片已删除", "success");
      await loadDetail(detail.item.id, true);
      await fetchList(page, true);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,330px)_minmax(0,1fr)]">
      {/* 左侧：已下载视频列表 */}
      <section className="card flex min-h-0 flex-col overflow-hidden">
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
          <Button size="sm" onClick={() => void fetchList(page)} title="刷新">
            <IconRefresh className="h-3.5 w-3.5" />
          </Button>
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
              title="还没有已下载的视频"
              description="下载完成的视频会出现在这里，可编辑它的 NFO 与封面"
            />
          )}
          <ul className="divide-y divide-white/[0.05]">
            {items.map((item) => {
              const active = item.id === selectedId;
              return (
                <li key={item.id}>
                  <button
                    onClick={() => setSelectedId(item.id)}
                    className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition ${
                      active ? "bg-brand-500/[0.12]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className="relative h-[62px] w-[42px] shrink-0 overflow-hidden rounded-md border border-white/10 bg-ink-900">
                      {item.posterUrl ? (
                        <img src={item.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-slate-600">
                          <IconPhoto className="h-4 w-4" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[12.5px] font-medium ${
                          active ? "text-white" : "text-slate-200"
                        }`}
                        title={item.title}
                      >
                        {item.title}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-500">
                        {item.episode !== null && (
                          <span className="rounded bg-white/[0.06] px-1.5 py-[1px] tabular-nums text-slate-400">
                            S{String(item.season ?? 1).padStart(2, "0")}E{String(item.episode).padStart(2, "0")}
                          </span>
                        )}
                        <span className={item.nfoExists ? "text-emerald-400/80" : "text-amber-400/80"}>
                          {item.nfoExists ? "NFO" : "无 NFO"}
                        </span>
                        <span>· {item.imageCount} 图</span>
                        <span>· {formatBytes(item.file_size)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

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
      <section className="card flex min-h-0 flex-col overflow-hidden">
        {!selectedId && (
          <div className="flex flex-1 items-center justify-center py-20 text-[13px] text-slate-500">
            左侧选一条记录开始编辑
          </div>
        )}

        {selectedId && !detail && (
          <div className="flex flex-1 items-center justify-center gap-2 py-20 text-[13px] text-slate-500">
            <Spinner /> 读取元数据…
          </div>
        )}

        {detail && (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] p-4">
              <div className="min-w-0">
                <h2 className="truncate text-[15px] font-semibold text-white" title={detail.item.save_name ?? detail.item.file_name}>
                  {detail.fields[kind].title || detail.item.save_name || detail.item.file_name}
                </h2>
                <p className="mt-1 truncate text-[11.5px] text-slate-500" title={detail.paths?.video}>
                  {detail.paths?.video ?? detail.pathError ?? ""}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge className="border-white/10 bg-white/[0.04] text-slate-400">
                    {detail.item.channel_title}
                  </Badge>
                  {detail.nfo.episode?.exists ? (
                    <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                      <IconCheck className="h-3 w-3" /> 单集 NFO
                    </Badge>
                  ) : (
                    <Badge className="border-amber-500/20 bg-amber-500/10 text-amber-300">缺 NFO</Badge>
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
                <Button size="sm" onClick={() => void loadDetail(detail.item.id)} loading={detailLoading} title="重新读取">
                  <IconRefresh className="h-3.5 w-3.5" />
                </Button>
                <a className="btn-ghost !px-2.5 !py-1.5 !text-[12.5px]" href={`/api/downloads/${detail.item.id}/file`} download>
                  <IconDownload className="h-3.5 w-3.5" />
                  视频
                </a>
              </div>
            </header>

            <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-3">
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
                {(["episode", "show"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`rounded-lg px-2 py-1 text-[11.5px] transition ${
                      kind === k ? "bg-brand-500/15 text-brand-200" : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {k === "episode" ? "单集" : "剧集(tvshow)"}
                  </button>
                ))}
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
                    if (!selectedId) return;
                    await loadDetail(selectedId, true);
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
            await loadDetail(detail.item.id, true);
            await fetchList(page, true);
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

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11.5px] text-slate-400">
        <span className="text-slate-500">文件：</span>
        <span className="font-mono text-slate-300">{slot?.file ?? "（将新建）"}</span>
        {slot?.exists && <span className="text-slate-500">· {formatBytes(slot.size)}</span>}
        {locked && (
          <span className="ml-auto flex items-center gap-1 text-amber-300">
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
          {dirty ? "有未保存的修改" : `已同步 · ${formatDateTime(detail.item.finished_at)} 下载`}
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
  imageScope,
  setImageScope,
  imageOf,
  onPick,
  onRemove,
  onOpenSettings,
}: {
  detail: MetadataDetail;
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
        <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {(["series", "episode"] as const).map((scope) => (
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
        <p className="text-[11.5px] text-slate-500">
          {imageScope === "episode" ? "文件名带集数前缀，Emby 会优先用它" : "放在剧集目录，整剧共用"}
        </p>
      </div>

      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {IMAGE_SLOTS.map((slot) => {
          const img = imageOf(imageScope, slot.name);
          return (
            <div key={slot.name} className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]">
              <div className="relative h-[168px] w-full bg-ink-950/60">
                {img ? (
                  <>
                    <img
                      src={img.url}
                      alt={slot.label}
                      className="h-full w-full cursor-zoom-in object-contain"
                      onClick={() => setZoom({ url: img.url, label: slot.label })}
                    />
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] tabular-nums text-white/80">
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
                <img src={file.url} alt={file.file} className="h-16 w-16 object-cover" />
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
        {zoom && <img src={zoom.url} alt={zoom.label} className="max-h-[70vh] w-full object-contain" />}
      </Modal>
    </div>
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
  const [tab, setTab] = useState<"frame" | "upload" | "existing">(
    detail.ffmpeg.available && detail.video?.exists ? "frame" : "upload",
  );
  const [busy, setBusy] = useState(false);

  // 截图
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [at, setAt] = useState(0);
  const [fit, setFit] = useState<"cover" | "contain" | "stretch">("contain");
  const [candidates, setCandidates] = useState<FrameCandidate[]>([]);
  const [grabbing, setGrabbing] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const duration = detail.video?.probe?.duration ?? 0;

  // 上传
  const fileRef = useRef<HTMLInputElement | null>(null);

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
      const res = await api.frameCandidates(detail.item.id, 8);
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

  const otherImages = detail.images.filter((img) => !(img.scope === scope && img.name === name));

  return (
    <Modal
      open
      onClose={onClose}
      title={`更换 ${scopeLabel(scope)} · ${slot.label}`}
      description={`目标尺寸 ${slot.hint.replace(/^[^·]*·\s*/, "")}，非该比例会按「${fit === "cover" ? "裁剪铺满" : fit === "contain" ? "留黑边完整显示" : "拉伸" }」处理`}
      width="max-w-3xl"
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            取消
          </Button>
          {tab === "frame" && (
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={() =>
                void run(
                  () => api.captureFrame(detail.item.id, { at, scope, name, fit }),
                  "已从视频截取并写入封面",
                )
              }
            >
              <IconCamera className="h-3.5 w-3.5" />
              用 {at.toFixed(1)}s 这一帧
            </Button>
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

        {/* 缩放方式对所有来源（截图 / 上传 / 复用）生效，比例不符时默认留黑边 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-slate-500">缩放方式</span>
          <select
            value={fit}
            onChange={(e) => setFit(e.target.value as "cover" | "contain" | "stretch")}
            className="field !w-auto !py-1 !text-[11.5px]"
            title="比例与目标尺寸不一致时怎么处理"
          >
            <option value="contain">留黑边（完整显示）</option>
            <option value="cover">裁剪铺满</option>
            <option value="stretch">拉伸变形</option>
          </select>
          <span className="text-[11px] text-slate-600">
            {fit === "contain"
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
                <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
                  <video
                    ref={videoRef}
                    src={`/api/metadata/${detail.item.id}/video`}
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
                          <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[9.5px] tabular-nums text-white/80">
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
                if (!file) return;
                void run(() => api.uploadImage(detail.item.id, scope, name, file, fit), "图片已上传并写入封面");
                e.target.value = "";
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
                会按 {slot.hint} 缩放，比例不符时
                {fit === "contain" ? "留黑边（默认）" : fit === "cover" ? "裁剪" : "拉伸"}
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
                        void run(
                          () => api.useCoverImage(detail.item.id, { file: cover.file, scope, name, fit }),
                          "已使用消息原图",
                        )
                      }
                      className="overflow-hidden rounded-lg border border-white/10 transition hover:border-brand-400/50 disabled:opacity-50"
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
                            api.copyImage(detail.item.id, {
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
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [exists, setExists] = useState(false);
  const [file, setFile] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.readNfo(detail.item.id, kind);
      setContent(res.content);
      setOriginal(res.content);
      setExists(res.exists);
      setFile(res.file);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [detail.item.id, kind, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = content !== original;

  const save = async () => {
    setSaving(true);
    try {
      await api.saveNfoRaw(detail.item.id, kind, content);
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
