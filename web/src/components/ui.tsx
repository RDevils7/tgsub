import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IconAlert, IconCheck, IconInbox, IconX } from "./icons";

/* ----------------------------- Toast ----------------------------- */

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-[100] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex animate-fade-up items-start gap-3 rounded-xl border border-white/10 bg-ink-800/95 px-3.5 py-3 shadow-card backdrop-blur-xl"
          >
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                t.kind === "success"
                  ? "bg-emerald-500/15 text-ok"
                  : t.kind === "error"
                    ? "bg-rose-500/15 text-err"
                    : "bg-brand-500/15 text-brand-300"
              }`}
            >
              {t.kind === "success" ? (
                <IconCheck className="h-3 w-3" />
              ) : t.kind === "error" ? (
                <IconAlert className="h-3 w-3" />
              ) : (
                <IconCheck className="h-3 w-3" />
              )}
            </span>
            <p className="text-[13px] leading-relaxed text-slate-200">{t.message}</p>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ----------------------------- Button ----------------------------- */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  loading?: boolean;
  size?: "sm" | "md";
};

export function Button({ variant = "ghost", loading, size = "md", className = "", children, ...rest }: ButtonProps) {
  const base =
    variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-ghost";
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`${base} ${size === "sm" ? "px-2.5 py-1.5 text-[12.5px]" : ""} ${className}`}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ----------------------------- Toggle ----------------------------- */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40 ${
        checked ? "bg-brand-gradient" : "bg-white/10"
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full bg-[#fff] shadow transition-all duration-200 ${
          checked ? "left-[19px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

/* ----------------------------- Badge ----------------------------- */

export function Badge({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusDot({ className = "bg-slate-400" }: { className?: string }) {
  return <span className={`h-1.5 w-1.5 rounded-full ${className}`} />;
}

/* ----------------------------- Modal ----------------------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  // 挂到 body：页面容器带 animate-fade-up（transform 常驻），会让 fixed 以容器为基准，弹窗被裁切
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        className={`relative flex max-h-[calc(100vh-2rem)] w-full ${width} animate-fade-up flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-850/95 shadow-card`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
          <div>
            <h3 className="text-[15px] font-semibold text-white">{title}</h3>
            {description && <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
            aria-label="关闭"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.06] bg-ink-850/95 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ----------------------------- Empty ----------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03] text-slate-500">
        {icon ?? <IconInbox className="h-5 w-5" />}
      </div>
      <div>
        <p className="text-[14px] font-medium text-slate-200">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/* ----------------------------- Field ----------------------------- */

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] leading-relaxed text-slate-500">{hint}</span>}
    </label>
  );
}

export function ProgressBar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06] ${className}`}>
      <div
        className="h-full rounded-full bg-brand-gradient transition-all duration-500"
        style={{ width: `${value <= 0 ? 0 : Math.min(100, Math.max(2, value))}%` }}
      />
    </div>
  );
}
