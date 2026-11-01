import { useEffect, useRef, useState } from "react";

/** 手动输入时的合理范围：太小翻页累，太大一次查询拖慢接口 */
export const PAGE_SIZE_MIN = 5;
export const PAGE_SIZE_MAX = 500;

const PRESETS = [20, 50, 100, 200];

/**
 * 分页条数：按页面 key 记在 localStorage，刷新/切页后保持上次选择。
 * 服务端 limit 上限 1000，这里最宽 500，够用又不至于一次拉爆。
 */
export function usePageSize(key: string, fallback = 30) {
  const [size, setSize] = useState<number>(() => {
    try {
      const n = Number(window.localStorage.getItem(`tgsub:pageSize:${key}`));
      if (Number.isFinite(n) && n >= PAGE_SIZE_MIN && n <= PAGE_SIZE_MAX) return Math.floor(n);
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
    return fallback;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(`tgsub:pageSize:${key}`, String(size));
    } catch {
      /* ignore */
    }
  }, [key, size]);

  return [size, setSize] as const;
}

/**
 * 「每页 N 条」选择器：预设档位 + 自定义输入。
 * 选「自定义…」后原地变成输入框，回车或失焦生效，Esc 取消。
 */
export function PageSizeControl({
  value,
  onChange,
  className = "",
}: {
  value: number;
  onChange: (size: number) => void;
  className?: string;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  useEffect(() => {
    if (custom) inputRef.current?.select();
  }, [custom]);

  const isPreset = PRESETS.includes(value);

  const commit = () => {
    const n = Math.floor(Number(draft));
    if (!Number.isFinite(n) || n < PAGE_SIZE_MIN) {
      setDraft(String(value));
      setCustom(false);
      return;
    }
    onChange(Math.min(PAGE_SIZE_MAX, n));
    setCustom(false);
  };

  if (custom) {
    return (
      <div className={`flex items-center gap-1 text-[11.5px] text-slate-500 ${className}`}>
        <span className="shrink-0">每页</span>
        <input
          ref={inputRef}
          autoFocus
          inputMode="numeric"
          className="field !w-[62px] !px-2 !py-1 text-center text-[12px] tabular-nums"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(String(value));
              setCustom(false);
            }
          }}
          onBlur={commit}
          title={`${PAGE_SIZE_MIN}–${PAGE_SIZE_MAX} 条`}
        />
        <span className="shrink-0">条</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1 text-[11.5px] text-slate-500 ${className}`}>
      <span className="shrink-0">每页</span>
      <select
        className="field !w-auto !px-2 !py-1 text-[12px] tabular-nums"
        value={isPreset ? String(value) : "custom"}
        onChange={(e) => {
          if (e.target.value === "custom") {
            setCustom(true);
            return;
          }
          onChange(Number(e.target.value));
        }}
        title="每页显示条数，可选「自定义」手动输入"
      >
        {PRESETS.map((n) => (
          <option key={n} value={n}>
            {n} 条
          </option>
        ))}
        <option value="custom">{isPreset ? "自定义…" : `${value} 条`}</option>
      </select>
    </div>
  );
}
