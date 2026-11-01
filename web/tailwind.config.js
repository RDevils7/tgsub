/**
 * 主题说明
 * ------------------------------------------------------------------
 * 所有颜色都走 CSS 变量，变量定义在 src/index.css：
 *   - :root     → 浅色主题
 *   - .dark     → 深色主题（body 上由 useTheme 切换 html 的 class）
 *
 * 约定（两个主题下含义一致）：
 *   - slate-100 / white  = 最主要的文字
 *   - slate-400          = 次要文字
 *   - slate-500/600/700  = 弱化 / 占位 / 禁用文字
 *   - ink-950            = 页面底色，ink-900 = 输入框 / 侧栏底色
 *   - ok / warn / err / info = 状态文字色（徽章、提示）
 *
 * 深色主题里 slate 由亮到暗，浅色主题里由暗到亮——数字越小越显眼。
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        /* 主题自适应白：深色主题=纯白，浅色主题=深色文字 */
        white: "rgb(var(--white) / <alpha-value>)",
        slate: {
          50: "rgb(var(--slate-50) / <alpha-value>)",
          100: "rgb(var(--slate-100) / <alpha-value>)",
          200: "rgb(var(--slate-200) / <alpha-value>)",
          300: "rgb(var(--slate-300) / <alpha-value>)",
          400: "rgb(var(--slate-400) / <alpha-value>)",
          500: "rgb(var(--slate-500) / <alpha-value>)",
          600: "rgb(var(--slate-600) / <alpha-value>)",
          700: "rgb(var(--slate-700) / <alpha-value>)",
          800: "rgb(var(--slate-800) / <alpha-value>)",
          900: "rgb(var(--slate-900) / <alpha-value>)",
          950: "rgb(var(--slate-950) / <alpha-value>)",
        },
        ink: {
          950: "rgb(var(--ink-950) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
          850: "rgb(var(--ink-850) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
        },
        /* 卡片 / 面板底色 */
        panel: "rgb(var(--panel) / <alpha-value>)",
        brand: {
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          300: "rgb(var(--brand-300) / <alpha-value>)",
          400: "rgb(var(--brand-400) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
        },
        violet: {
          300: "rgb(var(--violet-300) / <alpha-value>)",
          400: "rgb(var(--violet-400) / <alpha-value>)",
          500: "rgb(var(--violet-500) / <alpha-value>)",
        },
        /* 状态色（文字 / 徽章） */
        ok: "rgb(var(--ok) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        err: "rgb(var(--err) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
        /* 品牌渐变上的文字，始终为白色 */
        onbrand: "rgb(var(--onbrand) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "var(--shadow-card)",
        glow: "var(--shadow-glow)",
      },
      backgroundImage: {
        "brand-gradient": "var(--brand-gradient)",
        "grid-fade": "var(--grid-fade)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.35s cubic-bezier(0.22,1,0.36,1) both",
        shimmer: "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
};
