import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { MetadataDeletePlan } from "../types";
import { Button, Modal, Spinner, useToast } from "./ui";
import { IconAlert, IconFile, IconImage, IconTrash, IconVideo } from "./icons";
import { formatBytes } from "../utils";

/**
 * 元数据页的删除对话框：连磁盘文件一起删（视频 + NFO + 封面图）。
 *
 * 「仅从列表移除」不再是这里的事 —— 那是「隐藏」按钮的职责（登记到 media_excluded，
 * 刷新后也不再出现，可在「已隐藏」面板里恢复）。两个动作拆开后语义各管各的：
 *   删除 = 文件真的没了；
 *   隐藏 = 文件还在，只是列表不显示。
 *
 * 删除前先取一次预览（会删哪些文件、会连带清掉哪些记录），用户确认后再执行。
 */

export interface DeleteTarget {
  key: string;
  kind: "file" | "folder";
  name: string;
  path: string;
}

const KIND_ICON = {
  video: <IconVideo className="h-3 w-3" />,
  nfo: <IconFile className="h-3 w-3" />,
  image: <IconImage className="h-3 w-3" />,
  other: <IconFile className="h-3 w-3" />,
};

/** 清单最多列多少条（执行时不受这个限制） */
const MAX_LIST = 200;

export function MediaDeleteDialog({
  target,
  onClose,
  onDone,
}: {
  target: DeleteTarget | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [plan, setPlan] = useState<MetadataDeletePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!target) return;
      if (!silent) setLoading(true);
      try {
        const res = await api.previewMetadataDelete(target.key, "purge");
        setPlan(res);
      } catch (err) {
        if (!silent) toast.push((err as Error).message, "error");
        setPlan(null);
      } finally {
        setLoading(false);
      }
    },
    [target, toast],
  );

  useEffect(() => {
    if (!target) return;
    setPlan(null);
    void load();
  }, [target, load]);

  const run = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.deleteMetadata(target.key, "purge");
      if (!res.targetExists) {
        toast.push("磁盘上已经没有这个位置，已清理记录", "success");
      } else {
        toast.push(
          `已删除 ${res.removedFiles} 个文件（${formatBytes(res.removedBytes)}）` +
            (res.removedDownloads > 0 ? `，清除 ${res.removedDownloads} 条下载记录` : ""),
          "success",
        );
      }
      if (res.failed.length > 0) {
        toast.push(`${res.failed.length} 个文件删除失败，请检查权限`, "error");
      }
      onClose();
      await onDone();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={target ? `删除「${target.name}」` : "删除"}
      description={
        target?.kind === "folder"
          ? "整个剧集目录：视频、NFO 与封面图会一起删除，无法恢复"
          : "这一集：视频、NFO 与缩略图会一起删除，无法恢复"
      }
      width="max-w-2xl"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button size="sm" variant="danger" onClick={() => void run()} loading={busy} disabled={!plan}>
            <IconTrash className="h-3.5 w-3.5" />
            {plan && !plan.targetExists ? "清理记录" : "删除文件"}
          </Button>
        </>
      }
    >
      {target && (
        <div className="space-y-4">
          <p className="truncate font-mono text-[11.5px] text-slate-500" title={target.path}>
            {target.path}
          </p>

          {/* 预览 */}
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-[12.5px] text-slate-500">
              <Spinner /> 统计将删除的文件…
            </div>
          )}

          {!loading && plan && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <span className="rounded bg-white/[0.06] px-1.5 py-[1px] tabular-nums text-slate-300">
                  视频 {plan.videoCount}
                </span>
                <span className="rounded bg-white/[0.06] px-1.5 py-[1px] tabular-nums text-slate-300">
                  NFO {plan.nfoCount}
                </span>
                <span className="rounded bg-white/[0.06] px-1.5 py-[1px] tabular-nums text-slate-300">
                  图片 {plan.imageCount}
                </span>
                <span className="tabular-nums text-slate-500">共 {formatBytes(plan.totalSize)}</span>
              </div>

              {plan.warnings.length > 0 && (
                <ul className="space-y-1 rounded-xl border border-warn/20 bg-warn/[0.06] px-3 py-2.5">
                  {plan.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warn">
                      <IconAlert className="mt-[1px] h-3 w-3 shrink-0" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              )}

              {plan.items.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-white/[0.07]">
                  <p className="border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[11.5px] text-slate-400">
                    将删除的文件（{plan.items.length}）
                  </p>
                  <ul className="max-h-[240px] overflow-y-auto">
                    {plan.items.slice(0, MAX_LIST).map((item) => (
                      <li
                        key={item.path}
                        className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 last:border-b-0"
                      >
                        <span className="shrink-0 text-slate-500">{KIND_ICON[item.kind]}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-300" title={item.path}>
                          {item.name}
                        </span>
                        <span className="shrink-0 tabular-nums text-[10.5px] text-slate-500">
                          {formatBytes(item.size)}
                        </span>
                      </li>
                    ))}
                    {plan.items.length > MAX_LIST && (
                      <li className="px-3 py-1.5 text-[11px] text-slate-500">
                        还有 {plan.items.length - MAX_LIST} 个文件未列出，执行时同样会一起处理
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {plan.kept.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-white/[0.07]">
                  <p className="border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[11.5px] text-slate-400">
                    不会删除的文件
                  </p>
                  <ul className="max-h-[140px] overflow-y-auto">
                    {plan.kept.map((item) => (
                      <li
                        key={item.path}
                        className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 last:border-b-0"
                      >
                        <span className="shrink-0 text-slate-600">{KIND_ICON.other}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-400" title={item.path}>
                          {item.name}
                        </span>
                        <span className="shrink-0 tabular-nums text-[10.5px] text-slate-600">
                          {formatBytes(item.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.items.length > 0 && (
                <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warn">
                  <IconAlert className="mt-[1px] h-3 w-3 shrink-0" />
                  文件会被真正删除，无法恢复。磁盘上已经找不到的条目只会清掉记录。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
