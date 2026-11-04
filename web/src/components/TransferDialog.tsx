import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BrowseResult, RenamePlanPreview } from "../types";
import { Button, Modal, Spinner, useToast } from "./ui";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconCopy,
  IconFolder,
  IconMove,
} from "./icons";

/**
 * 移动 / 复制对话框。
 *
 * 只允许在服务端「允许操作的范围」内选目标（下载根或已登记来源），
 * 否则搬完之后元数据页就管不到这些文件了 —— 后端同样会拦。
 *
 * 移动**视频**时多一个「更新为当前剧集信息」：
 * 把搬进去的视频按目标剧集的剧名与集号重排命名，搬之前弹排序让人确认顺序，
 * 确认后视频、NFO、缩略图一起换成新名字（复用「合并」那套执行链）。
 */

export interface TransferTarget {
  keys: string[];
  action: "move" | "copy";
  /** 选中项的名字，用来预览「会变成什么」 */
  names: string[];
  /** 选中项的类别；全是 file 时才能申请「更新为当前剧集信息」 */
  kinds?: Array<"file" | "folder">;
}

const pad2 = (n: number): string => String(Math.max(0, Math.floor(n))).padStart(2, "0");
/** 从路径里取文件名（前端没有 node:path） */
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;
/** 取扩展名（带点），没有则空串 */
const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i) : "";
};

export function TransferDialog({
  target,
  onClose,
  onDone,
}: {
  target: TransferTarget | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // 「更新为当前剧集信息」相关状态
  const [conform, setConform] = useState(false);
  const [seriesTitle, setSeriesTitle] = useState("");
  const [plan, setPlan] = useState<RenamePlanPreview | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  /** 记住已经为哪个目录取过剧集名，避免重复请求把用户改过的名字冲掉 */
  const titledPathRef = useRef("");

  const load = useCallback(
    async (dir?: string) => {
      setLoading(true);
      try {
        setBrowse(await api.metadataBrowse(dir));
      } catch (err) {
        toast.push((err as Error).message, "error");
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (!target) {
      setBrowse(null);
      return;
    }
    // 每次打开都从干净状态开始
    setConform(false);
    setSeriesTitle("");
    setPlan(null);
    setPlanError(null);
    titledPathRef.current = "";
    void load();
  }, [target, load]);

  const move = target?.action === "move";
  const allFiles = Boolean(
    target?.kinds &&
      target.kinds.length === target.keys.length &&
      target.kinds.every((kind) => kind === "file"),
  );
  const canConform = move && allFiles;

  // 打开「更新为当前剧集信息」后，取目标目录的剧集名（tvshow.nfo / 目录名）作为默认
  useEffect(() => {
    if (!conform || !browse) return undefined;
    if (titledPathRef.current === browse.path) return undefined;
    let alive = true;
    api
      .metadataSeriesInfo(browse.path)
      .then((info) => {
        if (!alive) return;
        titledPathRef.current = browse.path;
        setSeriesTitle(info.title);
      })
      .catch(() => {
        if (!alive) return;
        titledPathRef.current = browse.path;
        setSeriesTitle(baseName(browse.path));
      });
    return () => {
      alive = false;
    };
  }, [conform, browse]);

  // 剧名 / 目标目录变了就重算计划（按集号自动排，顺序可再手动调）
  const keySig = target?.keys.join("|") ?? "";
  const dirPath = browse?.path ?? "";
  useEffect(() => {
    if (!conform || !target || !dirPath) return undefined;
    const title = seriesTitle.trim();
    if (!title) {
      setPlan(null);
      return undefined;
    }
    let alive = true;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api
        .previewMerge(target.keys, title, dirPath)
        .then((res) => {
          if (!alive) return;
          setPlan(res.plan);
          setPlanError(null);
        })
        .catch((err: Error) => {
          if (!alive) return;
          setPlan(null);
          setPlanError(err.message);
        })
        .finally(() => {
          if (alive) setPreviewing(false);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [conform, seriesTitle, dirPath, keySig]);

  /** 上移 / 下移一集：先乐观改界面，再让服务端按新顺序复核冲突与警告 */
  const reorder = async (idx: number, delta: number) => {
    if (!target || !plan || !dirPath) return;
    const j = idx + delta;
    if (j < 0 || j >= plan.items.length) return;
    const items = [...plan.items];
    [items[idx], items[j]] = [items[j], items[idx]];
    const title = plan.title || seriesTitle.trim();
    // 新集号 = 新位置，文件名按同一套规则重算（仅用于显示）
    const optimistic: RenamePlanPreview = {
      ...plan,
      items: items.map((item, i) => ({
        ...item,
        newEpisode: i + 1,
        to: `${plan.targetDir}/${title}S${pad2(plan.season)}E${pad2(i + 1)}${extOf(item.to)}`,
      })),
    };
    setPlan(optimistic);
    setPreviewing(true);
    try {
      const res = await api.previewMerge(target.keys, title, dirPath, items.map((item) => item.from));
      setPlan(res.plan);
      setPlanError(null);
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const run = async () => {
    if (!target) return;
    setBusy(true);
    try {
      if (conform) {
        if (!plan || !dirPath || !seriesTitle.trim()) return;
        const res = await api.mergeSeries(
          target.keys,
          seriesTitle.trim(),
          dirPath,
          plan.items.map((item) => item.from),
        );
        toast.push(
          `已按「${res.title}」整理 ${res.result.moved} 个视频，同步 ${res.nfoUpdated} 份 NFO`,
          "success",
        );
        if (res.result.failed.length > 0) {
          toast.push(`${res.result.failed.length} 个文件失败：${res.result.failed[0].error}`, "error");
        }
      } else {
        if (!browse) return;
        const res = await api.transferMetadata(target.keys, target.action, browse.path);
        const ok = res.results.filter((r) => r.ok).length;
        const failed = res.results.filter((r) => !r.ok);
        if (ok > 0) toast.push(`${target.action === "move" ? "已移动" : "已复制"} ${ok} 项`, "success");
        if (failed.length > 0) toast.push(`${failed.length} 项失败：${failed[0].error ?? "未知错误"}`, "error");
        if (res.skipped.length > 0 && ok === 0) toast.push(res.skipped[0].reason, "error");
      }
      onClose();
      await onDone();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const modalTitle = conform
    ? `更新为「${seriesTitle || "当前剧集"}」`
    : move
      ? `移动 ${target?.keys.length ?? 0} 项`
      : `复制 ${target?.keys.length ?? 0} 项`;
  const modalDesc = conform
    ? "把搬进去的视频按目标剧集的剧名与集号重排命名；确认顺序后，视频与 NFO / 缩略图一起换成新名字"
    : move
      ? "剧集目录会整体搬走，下载记录与来源登记一起同步"
      : "复制一份副本到目标目录，原文件保持不动";

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={modalTitle}
      description={modalDesc}
      width={conform ? "max-w-2xl" : "max-w-xl"}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          {conform ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void run()}
              loading={busy}
              disabled={!plan || previewing || plan.conflicts.length > 0 || !seriesTitle.trim()}
              title="确认顺序后，移动并把相关文件一起改名为剧集命名"
            >
              <IconCheck className="h-3.5 w-3.5" />
              移动并按剧集命名
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void run()} loading={busy} disabled={!browse}>
              {move ? <IconMove className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
              {move ? "移动到此处" : "复制到此处"}
            </Button>
          )}
        </>
      }
    >
      {target && (
        <div className="space-y-3">
          {!conform && (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <p className="text-[11px] text-slate-500">将在目标目录下生成</p>
              <ul className="mt-1 space-y-0.5">
                {target.names.slice(0, 6).map((name) => (
                  <li key={name} className="truncate font-mono text-[11.5px] text-slate-300">
                    {browse ? `${browse.path}/${name}` : name}
                  </li>
                ))}
                {target.names.length > 6 && (
                  <li className="text-[11px] text-slate-500">等 {target.names.length} 项…</li>
                )}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void load(browse?.parent ?? undefined)}
              disabled={!browse?.parent || loading}
              title="上一级"
            >
              <IconChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-400" title={browse?.path}>
              {browse?.path ?? "读取中…"}
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-white/[0.07]">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-slate-500">
                <Spinner /> 读取目录…
              </div>
            )}
            {!loading && browse && browse.dirs.length === 0 && (
              <p className="px-3 py-4 text-[11.5px] text-slate-500">这个目录下没有子目录，可以就选在这里</p>
            )}
            {!loading && browse && browse.dirs.length > 0 && (
              <ul className={conform ? "max-h-[160px] overflow-y-auto" : "max-h-[240px] overflow-y-auto"}>
                {browse.dirs.map((dir) => (
                  <li key={dir.path}>
                    <button
                      onClick={() => void load(dir.path)}
                      className="flex w-full items-center gap-2 border-b border-white/[0.04] px-3 py-2 text-left transition last:border-b-0 hover:bg-white/[0.04]"
                    >
                      <IconFolder className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300">{dir.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {canConform && (
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <input
                type="checkbox"
                checked={conform}
                onChange={(e) => setConform(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-[rgb(var(--brand-500))]"
              />
              <span className="min-w-0">
                <span className="block text-[12px] text-slate-200">更新为当前剧集信息</span>
                <span className="block text-[11px] leading-relaxed text-slate-500">
                  把搬进来的视频按目标剧集的剧名与集号重排命名，NFO / 缩略图一起改；下一步可确认顺序。
                </span>
              </span>
            </label>
          )}

          {conform && (
            <div className="space-y-2.5">
              <div>
                <label className="label">剧集名称</label>
                <input
                  className="field"
                  value={seriesTitle}
                  onChange={(e) => setSeriesTitle(e.target.value)}
                  placeholder="取自目标目录的剧集名，可改"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  默认取目标目录的 tvshow.nfo 或目录名；改完会按「剧名S01E01…」重排。
                </p>
              </div>

              {previewing && (
                <div className="flex items-center gap-2 py-4 text-[12px] text-slate-500">
                  <Spinner /> 正在算新的文件名…
                </div>
              )}
              {!previewing && planError && (
                <p className="flex items-start gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/[0.08] px-3 py-2 text-[11.5px] leading-relaxed text-rose-300">
                  <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {planError}
                </p>
              )}

              {plan && (
                <>
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

                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-slate-500">
                      顺序决定 E01…EN，确认无误再执行
                    </p>
                    <p className="text-[11px] tabular-nums text-slate-500">{plan.items.length} 个文件</p>
                  </div>

                  <div className="max-h-[38vh] overflow-y-auto rounded-xl border border-white/[0.07]">
                    <table className="w-full border-collapse text-[11.5px]">
                      <thead className="sticky top-0 z-10 bg-ink-850">
                        <tr className="text-left text-slate-500">
                          <th className="w-9 px-2 py-1.5 font-normal">#</th>
                          <th className="px-2 py-1.5 font-normal">原文件</th>
                          <th className="w-6 px-0 py-1.5 font-normal" />
                          <th className="px-2 py-1.5 font-normal">新文件</th>
                          <th className="w-14 px-2 py-1.5 text-right font-normal">顺序</th>
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
                              <td className="px-2 py-1.5">
                                <div className="flex items-center justify-end gap-0.5">
                                  <button
                                    onClick={() => void reorder(idx, -1)}
                                    disabled={idx === 0 || previewing}
                                    className="rounded border border-white/[0.07] p-0.5 text-slate-400 transition hover:text-slate-200 disabled:opacity-25"
                                    title="上移一位（集号变小）"
                                  >
                                    <IconChevronDown className="h-3 w-3 rotate-180" />
                                  </button>
                                  <button
                                    onClick={() => void reorder(idx, 1)}
                                    disabled={idx === plan.items.length - 1 || previewing}
                                    className="rounded border border-white/[0.07] p-0.5 text-slate-400 transition hover:text-slate-200 disabled:opacity-25"
                                    title="下移一位（集号变大）"
                                  >
                                    <IconChevronDown className="h-3 w-3" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-500">
                    同名的 <span className="font-mono">.nfo</span> 与缩略图会跟着改名，剧集级封面与 tvshow.nfo 一并保住；
                    改完会通知 Emby 重新识别这个目录。
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
