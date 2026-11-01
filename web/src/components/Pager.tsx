import { useEffect, useState } from "react";
import { Button } from "./ui";
import { IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight } from "./icons";

/**
 * 翻页条：首页 / 上一页 / 页码跳转 / 下一页 / 末页。
 * page 从 0 开始，pageCount 至少为 1。
 */
export function Pager({
  page,
  pageCount,
  total,
  onChange,
  unit = "条",
  hint,
}: {
  page: number;
  pageCount: number;
  total: number;
  onChange: (page: number) => void;
  unit?: string;
  hint?: string;
}) {
  const [draft, setDraft] = useState(String(page + 1));

  useEffect(() => {
    setDraft(String(page + 1));
  }, [page]);

  const atFirst = page <= 0;
  const atLast = page >= pageCount - 1;

  const jump = () => {
    const n = Math.floor(Number(draft));
    if (!Number.isFinite(n) || n < 1) {
      setDraft(String(page + 1));
      return;
    }
    const target = Math.min(pageCount, n) - 1;
    if (target !== page) onChange(target);
    else setDraft(String(page + 1));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-white/[0.06] px-4 py-2.5">
      <span className="text-[11.5px] text-slate-500">
        共 {total} {unit}
        {hint && <span className="text-slate-600"> · {hint}</span>}
      </span>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" disabled={atFirst} onClick={() => onChange(0)} title="第一页">
          <IconChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" disabled={atFirst} onClick={() => onChange(page - 1)} title="上一页">
          <IconChevronLeft className="h-3.5 w-3.5" />
          上一页
        </Button>

        <span className="flex items-center gap-1 px-1 text-[11.5px] tabular-nums text-slate-500">
          第
          <input
            className="field !w-[46px] !px-1.5 !py-1 text-center text-[12px] tabular-nums"
            value={draft}
            inputMode="numeric"
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") jump();
              if (e.key === "Escape") setDraft(String(page + 1));
            }}
            onBlur={jump}
            title="输入页码后回车跳转"
          />
          / {pageCount} 页
        </span>

        <Button size="sm" disabled={atLast} onClick={() => onChange(page + 1)} title="下一页">
          下一页
          <IconChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" disabled={atLast} onClick={() => onChange(pageCount - 1)} title="最后一页">
          <IconChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** total + pageSize → 页数（至少 1 页，避免出现「第 1 / 0 页」） */
export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}
