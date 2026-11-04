import { useState } from "react";
import { api } from "../api";
import type { DeleteMode } from "../types";
import type { DeleteTarget } from "./MediaDeleteDialog";
import { Button, Modal, useToast } from "./ui";
import { IconAlert, IconFile, IconTrash } from "./icons";

/**
 * 批量删除。
 *
 * 逐条调用单条删除接口，让每一条都走同一套「预览/清理/隐藏登记」逻辑 ——
 * 批量接口另写一遍的话，路径校验和来源回溯很容易与单条版本走偏。
 */

export function BatchDeleteDialog({
  items,
  onClose,
  onDone,
}: {
  items: DeleteTarget[] | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<DeleteMode>("purge");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const run = async () => {
    if (!items || items.length === 0) return;
    setBusy(true);
    setProgress(0);
    let ok = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await api.deleteMetadata(item.key, mode);
        ok += 1;
      } catch {
        failed += 1;
      }
      setProgress((n) => n + 1);
    }
    setBusy(false);
    if (ok > 0) {
      toast.push(
        mode === "purge" ? `已删除 ${ok} 项` : `已从列表移除 ${ok} 项`,
        "success",
      );
    }
    if (failed > 0) toast.push(`${failed} 项删除失败，请检查权限或稍后重试`, "error");
    onClose();
    await onDone();
  };

  const purge = mode === "purge";

  return (
    <Modal
      open={Boolean(items)}
      onClose={onClose}
      title={`删除 ${items?.length ?? 0} 项`}
      description="勾选的剧集目录与单集会一起处理"
      width="max-w-xl"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button size="sm" variant="danger" onClick={() => void run()} loading={busy}>
            <IconTrash className="h-3.5 w-3.5" />
            {purge ? "删除文件" : "从列表移除"}
            {busy && items ? `（${progress}/${items.length}）` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            onClick={() => setMode("purge")}
            className={`rounded-xl border p-3 text-left transition ${
              purge
                ? "border-rose-500/40 bg-rose-500/[0.08]"
                : "border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]"
            }`}
          >
            <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-white">
              <IconTrash className="h-3.5 w-3.5 text-rose-300" />
              删除磁盘文件
            </span>
            <span className="mt-1 block text-[11.5px] leading-relaxed text-slate-500">
              视频、NFO 与封面图一起删除，无法恢复。
            </span>
          </button>
          <button
            onClick={() => setMode("unlink")}
            className={`rounded-xl border p-3 text-left transition ${
              !purge
                ? "border-brand-500/40 bg-brand-500/[0.08]"
                : "border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]"
            }`}
          >
            <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-white">
              <IconFile className="h-3.5 w-3.5 text-brand-300" />
              仅从列表移除
            </span>
            <span className="mt-1 block text-[11.5px] leading-relaxed text-slate-500">
              磁盘文件保留，只是不再显示和管理。
            </span>
          </button>
        </div>

        <ul className="max-h-[240px] space-y-1 overflow-y-auto rounded-xl border border-white/[0.07] p-2">
          {items?.map((item) => (
            <li key={item.key} className="flex items-center gap-2">
              <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-[1px] text-[10px] text-slate-400">
                {item.kind === "folder" ? "目录" : "视频"}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300" title={item.path}>
                {item.name}
              </span>
            </li>
          ))}
        </ul>

        {purge && (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warn">
            <IconAlert className="mt-[1px] h-3 w-3 shrink-0" />
            文件会被真正删除，无法恢复。磁盘上已经找不到的条目只会清掉记录。
          </p>
        )}
      </div>
    </Modal>
  );
}
