/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070a10",
          900: "#0a0f17",
          850: "#0d131d",
          800: "#111926",
          700: "#17202f",
          600: "#1e293b",
        },
        brand: {
          300: "#7dd6fb",
          400: "#4cc4f5",
          500: "#2aabee",
          600: "#1e93cf",
        },
        violet: {
          400: "#9b8cff",
          500: "#7c5cff",
        },
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
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 12px 32px -12px rgba(0,0,0,0.6)",
        glow: "0 0 0 1px rgba(42,171,238,0.28), 0 10px 40px -8px rgba(42,171,238,0.35)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #2aabee 0%, #7c5cff 100%)",
        "grid-fade":
          "radial-gradient(1200px 600px at 15% -10%, rgba(42,171,238,0.16), transparent 60%), radial-gradient(900px 500px at 95% 0%, rgba(124,92,255,0.14), transparent 55%)",
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
