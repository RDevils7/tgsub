import { ReactNode, useCallback, useEffect, useState } from "react";
import { IconChevronDown } from "./icons";

/**
 * 可折叠的设置卡片。
 *
 * 设置页越堆越长，全部展开时要滚很久。统一用这个壳：点标题栏展开 / 收起，
 * 右侧徽章与开关照旧可点（不会连带折叠），展开状态存在 localStorage 里，
 * 下次进来还是上次的样子。
 */

const STORAGE_PREFIX = "tgsub.collapse.";

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + id);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* 隐私模式下 localStorage 会抛错，按默认值走 */
  }
  return fallback;
}

export type CardTint = "brand" | "violet" | "sky" | "cyan" | "amber" | "emerald" | "fuchsia" | "rose";

const TINT: Record<CardTint, string> = {
  brand: "border-brand-500/20 bg-brand-500/10 text-brand-300",
  violet: "border-violet-500/20 bg-violet-500/10 text-violet-300",
  sky: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  cyan: "border-cyan-500/20 bg-cyan-500/10 text-cyan-300",
  amber: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  fuchsia: "border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-300",
  rose: "border-rose-500/20 bg-rose-500/10 text-rose-300",
};

export interface CollapsibleCardProps {
  /** 记住展开状态用的键，同一个页面里唯一即可 */
  id: string;
  /** 直接给现成的标题栏内容（设置页里的老区块都是这种写法，改动最小） */
  header?: ReactNode;
  icon?: ReactNode;
  tint?: CardTint;
  title?: string;
  desc?: ReactNode;
  /** 标题右侧的内容（徽章、开关等），点击不会触发折叠 */
  extra?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function CollapsibleCard({
  id,
  header,
  icon,
  tint = "brand",
  title,
  desc,
  extra,
  defaultOpen = false,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));

  // 外部（比如点了「去设置某项」）可以派发事件强制展开某张卡
  useEffect(() => {
    const onExpand = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === id) setOpen(true);
    };
    window.addEventListener("tgsub:expand", onExpand);
    return () => window.removeEventListener("tgsub:expand", onExpand);
  }, [id]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_PREFIX + id, next ? "1" : "0");
      } catch {
        /* 存不下就算了，本次会话仍然有效 */
      }
      return next;
    });
  }, [id]);

  return (
    <section className="card overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex cursor-pointer items-start justify-between gap-3 px-5 py-4 outline-none transition-colors hover:bg-white/[0.015] focus-visible:bg-white/[0.02]"
      >
        {header ? (
          <div className="min-w-0 flex-1">{header}</div>
        ) : (
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${TINT[tint]}`}
            >
              {icon}
            </span>
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-white">{title}</h2>
              {desc && <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">{desc}</p>}
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {/* 徽章 / 开关自己处理点击，别顺手把卡片折叠了 */}
          {extra && (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              {extra}
            </div>
          )}
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-lg text-slate-500 transition-transform duration-200 ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          >
            <IconChevronDown className="h-4 w-4" />
          </span>
        </div>
      </div>

      {open && <div className="animate-fade-up px-5 pb-5">{children}</div>}
    </section>
  );
}
