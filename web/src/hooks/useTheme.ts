import { useCallback, useEffect, useState } from "react";

/**
 * 主题切换：亮色 / 暗色。
 *
 * - 用 html 上的 .dark 类切换（Tailwind darkMode: "class"）
 * - 选择写进 localStorage，刷新后保持
 * - 首次访问跟随系统偏好
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "tgsub-theme";

function readStored(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => readStored() ?? systemTheme());

  // 挂载时立刻应用，避免首屏闪烁
  useEffect(() => {
    apply(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* 隐私模式下写不进去，忽略 */
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggle = useCallback(() => setThemeState((prev) => (prev === "dark" ? "light" : "dark")), []);

  return { theme, toggle, setTheme };
}
