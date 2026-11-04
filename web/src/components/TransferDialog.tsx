import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { BrowseResult } from "../types";
import { Button, Modal, Spinner, useToast } from "./ui";
import { IconChevronLeft, IconFolder, IconMove, IconCopy } from "./icons";

/**
 * 移动 / 复制对话框。
 *
 * 只允许在服务端「允许操作的范围」内选目标（下载根或已登记来源），
 * 否则搬完之后元数据页就管不到这些文件了 —— 后端同样会拦。
 */

export interface TransferTarget {
  keys: string[];
  action: "move" | "copy";
  /** 选中项的名字，用来预览「会变成什么」 */
  names: string[];
}

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
    void load();
  }, [target, load]);

  const run = async () => {
    if (!target || !browse) return;
    setBusy(true);
    try {
      const res = await api.transferMetadata(target.keys, target.action, browse.path);
      const ok = res.results.filter((r) => r.ok).length;
      const failed = res.results.filter((r) => !r.ok);
      if (ok > 0) toast.push(`${target.action === "move" ? "已移动" : "已复制"} ${ok} 项`, "success");
      if (failed.length > 0) toast.push(`${failed.length} 项失败：${failed[0].error ?? "未知错误"}`, "error");
      if (res.skipped.length > 0 && ok === 0) toast.push(res.skipped[0].reason, "error");
      onClose();
      await onDone();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const move = target?.action === "move";

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={move ? `移动 ${target?.keys.length ?? 0} 项` : `复制 ${target?.keys.length ?? 0} 项`}
      description={move ? "剧集目录会整体搬走，下载记录与来源登记一起同步" : "复制一份副本到目标目录，原文件保持不动"}
      width="max-w-xl"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button size="sm" variant="primary" onClick={() => void run()} loading={busy} disabled={!browse}>
            {move ? <IconMove className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
            {move ? "移动到此处" : "复制到此处"}
          </Button>
        </>
      }
    >
      {target && (
        <div className="space-y-3">
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
              <ul className="max-h-[240px] overflow-y-auto">
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
        </div>
      )}
    </Modal>
  );
}
