import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { ScanState, Stats } from "./types";
import { ToastProvider, Button, Badge, StatusDot, useToast } from "./components/ui";
import {
  IconBroadcast,
  IconDashboard,
  IconDownload,
  IconImage,
  IconInbox,
  IconLink,
  IconLogs,
  IconMenu,
  IconMoon,
  IconPlay,
  IconSettings,
  IconSun,
  IconTag,
  IconTv,
  IconX,
} from "./components/icons";
import Dashboard from "./pages/Dashboard";
import Channels from "./pages/Channels";
import Subscriptions from "./pages/Subscriptions";
import Downloads from "./pages/Downloads";
import Manual from "./pages/Manual";
import Monitor from "./pages/Monitor";
import Metadata from "./pages/Metadata";
import Emby from "./pages/Emby";
import Logs from "./pages/Logs";
import SettingsPage from "./pages/Settings";
import { formatCountdown } from "./utils";
import { useTheme } from "./hooks/useTheme";

type PageKey =
  | "dashboard"
  | "channels"
  | "subscriptions"
  | "monitor"
  | "manual"
  | "downloads"
  | "metadata"
  | "emby"
  | "logs"
  | "settings";

const NAV: Array<{ key: PageKey; label: string; icon: React.ReactNode }> = [
  { key: "dashboard", label: "概览", icon: <IconDashboard className="h-[17px] w-[17px]" /> },
  { key: "channels", label: "频道", icon: <IconBroadcast className="h-[17px] w-[17px]" /> },
  { key: "subscriptions", label: "订阅关键词", icon: <IconTag className="h-[17px] w-[17px]" /> },
  { key: "monitor", label: "监控历史", icon: <IconInbox className="h-[17px] w-[17px]" /> },
  { key: "manual", label: "手动下载", icon: <IconLink className="h-[17px] w-[17px]" /> },
  { key: "downloads", label: "下载记录", icon: <IconDownload className="h-[17px] w-[17px]" /> },
  { key: "metadata", label: "元数据", icon: <IconImage className="h-[17px] w-[17px]" /> },
  { key: "emby", label: "Emby 入库", icon: <IconTv className="h-[17px] w-[17px]" /> },
  { key: "logs", label: "日志", icon: <IconLogs className="h-[17px] w-[17px]" /> },
  { key: "settings", label: "设置", icon: <IconSettings className="h-[17px] w-[17px]" /> },
];

const TITLES: Record<PageKey, { title: string; desc: string }> = {
  dashboard: { title: "概览", desc: "监控状态、下载队列与最新活动" },
  channels: { title: "频道", desc: "管理需要定时扫描的 Telegram 频道" },
  subscriptions: { title: "订阅关键词", desc: "命中关键词后自动下载整条消息的文件" },
  monitor: { title: "监控历史", desc: "每条被扫描到的消息及其命中结果，可追溯到原消息" },
  manual: { title: "手动下载", desc: "粘贴 Telegram 消息链接或 B站 / 小红书 / YouTube 链接，直接下载" },
  downloads: { title: "下载记录", desc: "查看、重试与导出已抓取的文件" },
  metadata: { title: "元数据", desc: "编辑已下载视频的 NFO 与封面，可从视频截图" },
  emby: { title: "Emby 入库", desc: "媒体信息生成、封面规格与入库通知" },
  logs: { title: "日志", desc: "服务运行日志，排障时最先该看的地方" },
  settings: { title: "设置", desc: "账号登录、网络代理、扫描与下载参数" },
};

function readHash(): PageKey {
  const key = window.location.hash.replace(/^#\/?/, "");
  return (NAV.some((n) => n.key === key) ? key : "dashboard") as PageKey;
}

function Shell() {
  const [page, setPage] = useState<PageKey>(readHash);
  const [navOpen, setNavOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scanState, setScanState] = useState<ScanState | null>(null);
  const [scanning, setScanning] = useState(false);
  const toast = useToast();
  const { theme, toggle } = useTheme();

  const navigate = useCallback((next: PageKey) => {
    window.location.hash = `/${next}`;
    setPage(next);
    setNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onHash = () => setPage(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.stats(), api.scanState()]);
      setStats(s);
      setScanState(st);
    } catch {
      /* 静默失败，下一轮重试 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await api.scanNow();
      const totalMatched = res.results.reduce((acc, r) => acc + Number((r as { matched?: number }).matched ?? 0), 0);
      toast.push(
        res.results.length === 0 ? "没有启用的频道可扫描" : `扫描完成，命中 ${totalMatched} 条消息`,
        "success",
      );
      await refresh();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setScanning(false);
    }
  };

  const meta = TITLES[page];
  const activeDownloads = (stats?.totals.downloading ?? 0) + (stats?.totals.queued ?? 0);

  return (
    <div className="min-h-screen text-slate-200">
      {/* 侧边栏 */}
      <aside
        className={`fixed left-0 top-0 z-40 flex h-full w-[236px] flex-col border-r border-white/[0.06] bg-ink-900/80 backdrop-blur-2xl transition-transform duration-300 lg:translate-x-0 ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-5 py-5">
          <img
            src="/logo.png"
            alt="tgsub"
            className="h-9 w-9 rounded-xl object-cover shadow-glow ring-1 ring-white/10"
          />
          <div className="leading-tight">
            <p className="text-[14px] font-semibold tracking-tight text-white">tgsub</p>
            <p className="text-[10.5px] tracking-wide text-slate-500">频道订阅下载器</p>
          </div>
          <button
            onClick={() => setNavOpen(false)}
            className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-white/5 lg:hidden"
            aria-label="关闭菜单"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>

        <nav className="mt-1 flex-1 space-y-1 px-3">
          {NAV.map((item) => {
            const active = page === item.key;
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.key)}
                className={`group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] transition-all duration-200 ${
                  active
                    ? "bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    : "text-slate-400 hover:bg-white/[0.03] hover:text-slate-200"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-r-full bg-brand-gradient" />
                )}
                <span className={active ? "text-brand-300" : "text-slate-500 group-hover:text-slate-300"}>
                  {item.icon}
                </span>
                {item.label}
                {item.key === "downloads" && activeDownloads > 0 && (
                  <span className="ml-auto rounded-md bg-brand-500/15 px-1.5 py-0.5 font-mono text-[10.5px] text-brand-300">
                    {activeDownloads}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="m-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <StatusDot
              className={
                scanState?.auth.authorized
                  ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]"
                  : "bg-amber-400"
              }
            />
            <span className="text-[11.5px] text-slate-400">
              {scanState?.auth.authorized
                ? scanState.auth.me?.username
                  ? `@${scanState.auth.me.username}`
                  : "账号已连接"
                : "账号未登录"}
            </span>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-600">
            {scanState?.auth.authorized
              ? `自动扫描 · 每 ${scanState.intervalMinutes} 分钟`
              : "前往设置完成 Telegram 登录"}
          </p>
        </div>
      </aside>

      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* 主区域 */}
      <main className="lg:pl-[236px]">
        <header className="sticky top-0 z-20 border-b border-white/[0.05] bg-ink-950/75 backdrop-blur-xl">
          <div className="flex items-center gap-3 px-4 py-3.5 sm:px-6">
            <button
              onClick={() => setNavOpen(true)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white lg:hidden"
              aria-label="打开菜单"
            >
              <IconMenu className="h-5 w-5" />
            </button>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-white">{meta.title}</h1>
              <p className="mt-0.5 truncate text-[11.5px] text-slate-500">{meta.desc}</p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={toggle}
                title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
                aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
              >
                {theme === "dark" ? <IconSun className="h-3.5 w-3.5" /> : <IconMoon className="h-3.5 w-3.5" />}
                {theme === "dark" ? "亮色" : "暗色"}
              </Button>
              <Badge className="hidden border-white/[0.07] bg-white/[0.03] text-slate-400 sm:inline-flex">
                <StatusDot className={scanState?.scanning ? "bg-brand-400 animate-pulse" : "bg-emerald-400"} />
                {scanState?.scanning
                  ? "扫描中"
                  : !scanState?.auth.authorized
                    ? "待登录"
                    : scanState?.autoScan
                      ? formatCountdown(scanState.nextRunAt ?? null)
                      : "自动扫描已关闭"}
              </Badge>
              <Button variant="primary" size="sm" onClick={() => void runScan()} loading={scanning || scanState?.scanning}>
                {!(scanning || scanState?.scanning) && <IconPlay className="h-3 w-3" />}
                立即扫描
              </Button>
            </div>
          </div>
        </header>

        <div key={page} className="animate-fade-up px-4 py-5 sm:px-6 sm:py-6">
          {page === "dashboard" && (
            <Dashboard stats={stats} scanState={scanState} onScan={runScan} scanning={scanning} onNavigate={navigate} />
          )}
          {page === "channels" && <Channels />}
          {page === "subscriptions" && <Subscriptions />}
          {page === "monitor" && <Monitor />}
          {page === "manual" && <Manual />}
          {page === "downloads" && <Downloads />}
          {page === "metadata" && <Metadata />}
          {page === "emby" && <Emby />}
          {page === "logs" && <Logs />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
