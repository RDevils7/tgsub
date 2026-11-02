import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PlatformId, PlatformInfo, PlatformStatus } from "../types";
import { Badge, Button, StatusDot, Toggle, useToast } from "../components/ui";
import { IconAlert, IconCheck, IconHelp, IconLink, IconRefresh } from "../components/icons";
import CollapsibleCard from "./CollapsibleCard";

/**
 * 设置页的「第三方平台」卡片。
 *
 * 自带加载与保存：Cookie 是加密字段，保存方式和其他设置不同（逐条提交、
 * 空字符串表示清除），放在这里比塞进页面的大 draft 更清楚。
 */

interface PlatformMeta {
  id: PlatformId;
  label: string;
  /** 占位示例 */
  placeholder: string;
  cookieHint: string;
  /** 悬停展开的详细步骤：每种浏览器的面板名字略有差异，按「菜单层级」写 */
  cookieSteps: string[];
  /** 至少命中其中一项才算登录态；多个元素之间是「且」 */
  required: string[][];
  /** 下这个平台必须配代理 */
  needsProxy?: boolean;
}

const PLATFORMS: PlatformMeta[] = [
  {
    id: "bilibili",
    label: "B站",
    placeholder: "SESSDATA=xxx; bili_jct=yyy; …",
    cookieHint: "浏览器登录后复制整串 Cookie，至少要有 SESSDATA（大会员画质还需要它对应账号）",
    cookieSteps: [
      "浏览器打开 bilibili.com 并登录（要下 4K 就用大会员账号）",
      "按 F12 打开开发者工具，切到 Network / 网络 面板，然后刷新页面",
      "在请求列表里点任意一条发往 bilibili.com 的请求",
      "右侧 Headers → Request Headers，复制 Cookie: 后面那一整串",
      "至少要包含 SESSDATA、bili_jct、DedeUserID；一般一个月左右过期",
      "高码率（1080P+ / 4K）必须要大会员账号的 Cookie，否则只能拿到 480P",
    ],
    required: [["SESSDATA"], ["bili_jct"]],
  },
  {
    id: "douyin",
    label: "抖音",
    placeholder: "ttwid=xxx; sessionid=yyy; …",
    cookieHint:
      "至少要 ttwid 或 sessionid（登录后才有）；msToken 是网页脚本现算的，不在 Cookie 里，没有也正常",
    cookieSteps: [
      "浏览器打开 douyin.com，用手机抖音扫码登录，随便打开一个视频页",
      "F12 → Network / 网络 → 筛框输入 douyin.com，刷新页面",
      "点任意一条 douyin.com 的请求（状态码 200 的），右侧 Headers → Request Headers",
      "复制 Cookie: 后面那一整串；关键字段是 ttwid、sessionid、sessionid_ss、odin_tt、passport_csrf_token",
      "注意：在 Console 里敲 document.cookie 拿不到 HttpOnly 的 ttwid，那样复制出来的串一定不完整 —— 必须从 Request Headers 复制，或用 Cookie-Editor 导出",
      "只支持单个视频 / 图文页；主页、合集页认不出来。有效期几天到几周，失效会报 412",
    ],
    required: [["ttwid", "sessionid", "sessionid_ss", "sid_guard", "odin_tt"]],
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    placeholder: "web_session=xxx; a1=yyy; …",
    cookieHint: "需要 web_session、a1；只支持视频笔记，图文笔记没有视频流",
    cookieSteps: [
      "浏览器打开 xiaohongshu.com 并登录（扫码即可）",
      "F12 → Network / 网络 → 刷新页面",
      "点一条发往 edith.xiaohongshu.com 的请求（没有就随便点一条 xiaohongshu.com 的）",
      "复制 Request Headers 里的 Cookie 整串，关键字段：web_session、a1、webId",
      "只支持视频笔记；图文笔记没有视频流，会提示认不出这个链接",
    ],
    required: [["web_session"], ["a1"]],
  },
  {
    id: "youtube",
    label: "YouTube",
    placeholder: "SID=xxx; SAPISID=yyy; …",
    cookieHint: "大陆网络必须先在下面配代理；会看会员/年龄限制的视频才需要 Cookie（SID、SAPISID）",
    cookieSteps: [
      "建议用无痕窗口登录一个专用小号（Cookie 等同账号凭据，别用主账号）",
      "登录后 F12 → Network / 网络 → 刷新，点任意一条 www.youtube.com 的请求",
      "复制 Cookie 整串，至少包含 SID、HSID、SSID、SAPISID、__Secure-3PSID",
      "大陆网络必须先填下面的「第三方平台代理」，否则解析阶段就会失败",
      "公开视频不用 Cookie；会员专享、年龄限制的视频才需要",
    ],
    required: [["SID", "SAPISID", "__Secure-3PAPISID", "__Secure-3PSID", "LOGIN_INFO", "SIDCC"]],
    needsProxy: true,
  },
];

const QUALITIES = [
  { value: "best", label: "最高（原画）" },
  { value: "1080", label: "1080P" },
  { value: "720", label: "720P" },
  { value: "480", label: "480P" },
];

/**
 * Cookie 统一格式，规则与服务端 `server/src/platform/cookie.ts` 的
 * `normalizeCookie` 完全一致（两边没有共享模块，改一处必须改两处）：
 * 普通串 / `Cookie:` 前缀 / JSON 导出 / Netscape cookies.txt。
 */
function normalizeCookie(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const asPairs = (pairs: Array<{ name: string; value: string }>) =>
    pairs.map((p) => `${p.name}=${p.value}`).join("; ");

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as unknown;
      const pairs: Array<{ name: string; value: string }> = [];
      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item || typeof item !== "object") continue;
          const rec = item as Record<string, unknown>;
          if (typeof rec.name === "string" && typeof rec.value === "string" && rec.name && rec.value) {
            pairs.push({ name: rec.name, value: rec.value });
          }
        }
      } else if (data && typeof data === "object") {
        for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
          if (typeof value === "string" && name && value) pairs.push({ name, value });
        }
      }
      if (pairs.length) return asPairs(pairs);
    } catch {
      /* 不是 JSON，按普通串处理 */
    }
  }

  if (/^#\s*(Netscape|HttpOnly_)/i.test(text) || text.split(/\r?\n/).some((l) => l.split("\t").length >= 7)) {
    const pairs: Array<{ name: string; value: string }> = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/^#HttpOnly_/i, "").trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const name = parts[5].trim();
      const value = parts[6].trim();
      if (name) pairs.push({ name, value });
    }
    if (pairs.length) return asPairs(pairs);
  }

  return text.replace(/^cookie\s*:\s*/i, "");
}

/** 拆 Cookie 串（兼容三种粘贴格式），前端只用来即时提示 */
function parseCookie(raw: string): { count: number; keys: string[]; missing: string[] } {
  const keys: string[] = [];
  let count = 0;
  for (const chunk of normalizeCookie(raw).split(/[;\n]/)) {
    const item = chunk.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!name || !value) continue;
    count += 1;
    if (!keys.some((k) => k.toLowerCase() === name.toLowerCase())) keys.push(name);
  }
  return { count, keys, missing: [] };
}

/** 传入要检查的必需项，补出缺失列表 */
function cookieSummary(raw: string, required: string[][]) {
  const base = parseCookie(raw);
  const lower = new Set(base.keys.map((k) => k.toLowerCase()));
  const missing: string[] = [];
  for (const group of required) {
    if (!group.some((name) => lower.has(name.toLowerCase()))) missing.push(group[0]);
  }
  return { ...base, missing };
}

/** 刚刚 / 12 分钟前 / 3 小时前 / 5 天前 */
function ageLabel(ts: number | null | undefined, now = Date.now()): string | null {
  if (!ts || !Number.isFinite(ts)) return null;
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return `${Math.floor(diff / (30 * day))} 个月前`;
}

const SOURCE_LABEL: Record<string, string> = {
  custom: "手动指定",
  local: "自动更新版",
  bundled: "镜像内置",
  path: "系统 PATH",
};

/**
 * 平台名旁边的「?」：鼠标悬停 / 键盘聚焦时展开 Cookie 获取步骤。
 *
 * 用纯 CSS 的 group-hover，不引入弹层组件 —— 这段内容只是说明，
 * 不需要点开、也不需要挡住下面的输入框（pointer-events-none）。
 */
function CookieHelp({ item }: { item: PlatformMeta }) {
  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        aria-label={`${item.label} Cookie 获取方法`}
        className="flex h-4 w-4 items-center justify-center rounded-full text-slate-500 transition hover:text-slate-200 focus:outline-none focus-visible:text-slate-200"
      >
        <IconHelp className="h-3.5 w-3.5" />
      </button>
      <div
        role="tooltip"
        className="pointer-events-none absolute left-0 top-5 z-40 w-[326px] max-w-[calc(100vw-3.5rem)] rounded-xl border border-white/10 bg-[#11131f] p-3 text-left opacity-0 shadow-2xl transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <p className="mb-1.5 text-[11.5px] font-medium text-slate-200">
          {item.label} · Cookie 获取步骤
        </p>
        <ol className="space-y-1">
          {item.cookieSteps.map((step, index) => (
            <li key={step} className="flex gap-1.5 text-[10.5px] leading-relaxed text-slate-400">
              <span className="shrink-0 text-slate-500">{index + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 border-t border-white/[0.06] pt-1.5 text-[10px] leading-relaxed text-slate-500">
          也可以用「Get cookies.txt」类扩展导出，但这里只需要 Cookie 串本身，不用导出的文件。
        </p>
      </div>
    </div>
  );
}

export default function PlatformPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [quality, setQuality] = useState("best");
  const [dir, setDir] = useState("第三方");
  const [meta, setMeta] = useState(true);
  const [proxy, setProxy] = useState("");
  const [proxyDomestic, setProxyDomestic] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [checkHours, setCheckHours] = useState(24);
  const [ytdlpPath, setYtdlpPath] = useState("");
  const [cookies, setCookies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const pollRef = useRef<number | null>(null);

  /** 只刷状态，不动用户正在编辑的草稿 */
  const refreshStatus = useCallback(async () => {
    const res = await api.platformStatus();
    setStatus(res);
    return res;
  }, []);

  const load = useCallback(async () => {
    const res = await refreshStatus();
    setEnabled(res.enabled);
    setQuality(res.quality || "best");
    setDir(res.dir || "第三方");
    setMeta(res.meta);
    setProxy(res.proxy ?? "");
    setProxyDomestic(Boolean(res.proxyDomestic));
    setAutoUpdate(res.update?.autoUpdate ?? true);
    setCheckHours(res.update?.checkHours ?? 24);
    return res;
  }, [refreshStatus]);

  useEffect(() => {
    void load().catch((err) => toast.push((err as Error).message, "error"));
  }, [load, toast]);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    [],
  );

  const saveConfig = async () => {
    setBusy("config");
    try {
      await api.saveSettings({
        platform_enabled: enabled,
        platform_quality: quality,
        platform_dir: dir,
        platform_meta: meta,
        platform_proxy: proxy.trim(),
        platform_proxy_domestic: proxyDomestic,
        ytdlp_auto_update: autoUpdate,
        ytdlp_check_hours: checkHours,
        ytdlp_path: ytdlpPath.trim(),
      } as never);
      await load();
      toast.push("第三方平台设置已保存", "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const saveCookie = async (id: PlatformId, clear = false) => {
    const value = clear ? "" : (cookies[id] ?? "").trim();
    if (!clear && !value) {
      toast.push("先粘贴 Cookie 再保存", "error");
      return;
    }
    setBusy(`cookie-${id}`);
    try {
      await api.saveSettings({ [`platform_cookie_${id}`]: value } as never);
      setCookies((prev) => ({ ...prev, [id]: "" }));
      await load();
      toast.push(clear ? "已清除该平台 Cookie" : "Cookie 已保存", "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const probeEngine = async () => {
    setProbing(true);
    try {
      const res = await api.platformRefresh();
      await refreshStatus();
      toast.push(
        res.ytdlp.available ? `yt-dlp ${res.ytdlp.version} 可用` : res.ytdlp.error || "未找到 yt-dlp",
        res.ytdlp.available ? "success" : "error",
      );
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setProbing(false);
    }
  };

  /** 检查更新：同时轮询状态，把下载进度显示在按钮上 */
  const checkUpdate = async () => {
    setUpdating(true);
    pollRef.current = window.setInterval(() => {
      void refreshStatus().catch(() => undefined);
    }, 2500);
    try {
      const res = await api.platformUpdate();
      await refreshStatus();
      if (!res.ok) {
        toast.push(res.error || "检查更新失败", "error");
      } else if (res.updated) {
        toast.push(`yt-dlp 已更新到 ${res.to}`, "success");
      } else {
        toast.push(`已是最新版本 ${res.to ?? res.from ?? ""}`.trim(), "info");
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      setUpdating(false);
    }
  };

  const engine = status?.ytdlp;
  const update = status?.update;
  const cookieState = (id: PlatformId): PlatformInfo | undefined =>
    status?.platforms.find((p) => p.id === id);

  const progressPct =
    update && update.busy && update.progress >= 0 ? Math.round(update.progress * 100) : null;

  return (
    <CollapsibleCard
      id="platform"
      tint="fuchsia"
      icon={<IconLink className="h-4 w-4" />}
      title="第三方平台"
      desc="B站 / 抖音 / 小红书 / YouTube 链接下载，引擎是 yt-dlp；在「手动下载」页粘贴链接即可"
      extra={
        <>
          <Badge
            className={
              enabled
                ? "border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-200"
                : "border-white/10 bg-white/[0.04] text-slate-400"
            }
          >
            {enabled ? "已启用" : "未启用"}
          </Badge>
          <Toggle checked={enabled} onChange={setEnabled} label="启用第三方平台下载" />
        </>
      }
    >
      {/* 引擎状态 */}
      <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot className={engine?.available ? "bg-emerald-400" : "bg-rose-400"} />
            <span className="text-[12.5px] text-slate-200">yt-dlp</span>
            <span className="font-mono text-[11.5px] text-slate-300">
              {engine?.available ? engine.version ?? "已安装" : "不可用"}
            </span>
            {engine?.source && (
              <Badge className="border-white/10 bg-white/[0.04] text-slate-400">
                {SOURCE_LABEL[engine.source] ?? engine.source}
              </Badge>
            )}
            {update?.updateAvailable && (
              <Badge className="border-amber-500/25 bg-amber-500/10 text-warn">
                新版 {update.latest}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={() => void probeEngine()} loading={probing}>
              <IconRefresh className="h-3.5 w-3.5" />
              重新检测
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void checkUpdate()}
              loading={updating || Boolean(update?.busy)}
            >
              {progressPct !== null ? `下载中 ${progressPct}%` : "检查更新"}
            </Button>
          </div>
        </div>

        {engine?.available ? (
          <p className="mt-1.5 break-all font-mono text-[10.5px] text-slate-500">{engine.path}</p>
        ) : (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn/90">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {engine?.error ?? "未找到 yt-dlp"}
            <span className="text-slate-500">· 点「检查更新」可自动下载一份到 data/bin</span>
          </p>
        )}

        {/* 版本检查信息 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span>
            最新版本{" "}
            <span className="font-mono text-slate-300">
              {update?.latest ?? "未检查"}
              {update?.updateAvailable ? " · 可更新" : update?.latest ? " · 已是最新" : ""}
            </span>
          </span>
          <span>
            上次检查{" "}
            {update?.checkedAt ? (
              <span className="text-slate-400">{ageLabel(update.checkedAt)}</span>
            ) : (
              <span className="text-slate-500">从未</span>
            )}
          </span>
          {update?.updatedAt && <span>上次更新 {ageLabel(update.updatedAt)}</span>}
        </div>

        {update?.lastError && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-err/80">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {update.lastError}
          </p>
        )}

        {/* 自动更新 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[0.06] pt-2.5">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-fuchsia-500"
              checked={autoUpdate}
              onChange={(e) => setAutoUpdate(e.target.checked)}
            />
            <span className="text-[11.5px] text-slate-300">定时检查并自动更新</span>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500">每</span>
            <input
              type="number"
              min={1}
              max={720}
              className="field !w-16 py-1 text-center text-[11.5px]"
              value={checkHours}
              onChange={(e) => setCheckHours(Math.max(1, Number(e.target.value) || 24))}
            />
            <span className="text-[11px] text-slate-500">小时</span>
          </label>
          <span className="text-[10.5px] text-slate-600">下载到 data/bin，容器重建也保留</span>
        </div>

        <input
          className="field mt-2 font-mono text-[11.5px]"
          placeholder="自定义 yt-dlp 路径（留空自动查找：data/bin → 镜像内置 → PATH）"
          value={ytdlpPath}
          onChange={(e) => setYtdlpPath(e.target.value)}
          spellCheck={false}
        />
      </div>

      {/* 下载选项 */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[11px] text-slate-500">清晰度上限</span>
          <select className="field" value={quality} onChange={(e) => setQuality(e.target.value)}>
            {QUALITIES.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-slate-500">存放子目录</span>
          <input
            className="field"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="第三方"
            spellCheck={false}
          />
        </label>
        <div className="flex items-end">
          <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-fuchsia-500"
              checked={meta}
              onChange={(e) => setMeta(e.target.checked)}
            />
            <span className="text-[11.5px] text-slate-300">写 nfo 与封面</span>
          </label>
        </div>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-500">
        清晰度默认「最高（原画）」：按平台实际能给的码率取最好的一档，B站大会员 / 小红书登录态才会出现 1080P 以上；
        想省空间再挑固定档位。
      </p>
      <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">
        封面优先用平台官方封面（清晰、构图也对），下载不到才回退视频截帧；简介、UP主、发布日期、分区、播放量会一起写进 nfo。
      </p>

      {/* yt-dlp 专用代理 */}
      <div className="mt-3">
        <span className="mb-1 block text-[11px] text-slate-500">第三方平台代理（只给 yt-dlp 用）</span>
        <input
          className="field font-mono text-[11.5px]"
          placeholder="http://192.168.1.2:7890 或 socks5://192.168.1.2:7890（留空直连）"
          value={proxy}
          onChange={(e) => setProxy(e.target.value)}
          spellCheck={false}
        />
        <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">
          <span className="text-slate-400">只有 YouTube 与「检查更新」走这条代理</span>；B站 / 抖音 / 小红书 默认直连
          —— B站 CDN 会把海外代理 IP 判成 <span className="font-mono text-slate-400">HTTP 567</span>。
          与「网络与代理」里的 Telegram 代理互相独立。
        </p>
        <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
          <input
            type="checkbox"
            className="mt-[2px] h-3.5 w-3.5 accent-brand-500"
            checked={proxyDomestic}
            onChange={(e) => setProxyDomestic(e.target.checked)}
          />
          <span className="text-[11px] leading-relaxed text-slate-400">
            国内平台也走代理
            <span className="ml-1 text-slate-600">（服务器在海外才需要；打开后 B站 容易报 567）</span>
          </span>
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] leading-relaxed text-slate-500">
          目录结构：<span className="font-mono text-slate-400">{dir || "第三方"}/平台/作者/标题 [ID]</span>
        </p>
        <Button size="sm" variant="primary" onClick={() => void saveConfig()} loading={busy === "config"}>
          <IconCheck className="h-3.5 w-3.5" />
          保存
        </Button>
      </div>

      {/* Cookie */}
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <p className="mb-2 text-[11.5px] text-slate-400">
          登录 Cookie（加密保存，只对对应平台生效；不填也能下公开视频，但清晰度和成功率都会差很多）
        </p>
        <div className="space-y-2.5">
          {PLATFORMS.map((item) => {
            const state = cookieState(item.id);
            const saved = Boolean(state?.cookieSet);
            const draft = cookies[item.id] ?? "";
            // 正在编辑就提示即将保存的内容，否则显示已保存的摘要
            const live = draft.trim() ? cookieSummary(draft, item.required) : null;
            const missing = live ? live.missing : state?.cookieMissing ?? [];
            const count = live ? live.count : state?.cookieCount ?? 0;
            const hasMissing = saved || live ? missing.length > 0 : false;
            const savedAge = ageLabel(state?.cookieSavedAt);

            return (
              <div key={item.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-medium text-slate-200">{item.label}</span>
                    <CookieHelp item={item} />
                    <Badge
                      className={
                        saved
                          ? hasMissing
                            ? "border-amber-500/25 bg-amber-500/10 text-warn"
                            : "border-emerald-500/20 bg-emerald-500/10 text-ok"
                          : "border-white/10 bg-white/[0.04] text-slate-500"
                      }
                    >
                      {saved ? (hasMissing ? "已保存 · 缺关键项" : "已保存") : "未配置"}
                    </Badge>
                    {item.needsProxy && (
                      <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-300">需要代理</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {saved && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void saveCookie(item.id, true)}
                        loading={busy === `cookie-${item.id}`}
                      >
                        清除
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => void saveCookie(item.id)}
                      loading={busy === `cookie-${item.id}`}
                      disabled={!draft.trim()}
                    >
                      保存
                    </Button>
                  </div>
                </div>

                <input
                  className="field mt-2 font-mono text-[11px]"
                  placeholder={saved ? "粘贴新的 Cookie 可覆盖" : item.placeholder}
                  value={draft}
                  onChange={(e) => setCookies((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  spellCheck={false}
                />

                {/* 状态行：输入中显示识别结果，已保存显示摘要与时间 */}
                {live ? (
                  live.count === 0 ? (
                    <p className="mt-1 text-[10.5px] leading-relaxed text-err/90">
                      没认出任何键值对：要粘 <span className="font-mono">name=value</span> 形式的整串
                      （从 Request Headers 的 Cookie: 后面复制），只粘值或只粘字段名都无效
                    </p>
                  ) : (
                    <p
                      className={
                        hasMissing
                          ? "mt-1 text-[10.5px] leading-relaxed text-warn/90"
                          : "mt-1 text-[10.5px] leading-relaxed text-ok/90"
                      }
                    >
                      识别到 {live.count} 项
                      {live.keys.length > 0 && <span className="text-slate-500"> · {live.keys.slice(0, 4).join(" / ")}{live.keys.length > 4 ? " …" : ""}</span>}
                      {hasMissing && <span> · 缺少 {missing.join(" / ")}，可能不算登录态</span>}
                    </p>
                  )
                ) : saved ? (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">
                    {state?.cookieHint ?? `${count} 项`}
                    {savedAge && <span className="text-slate-600"> · 保存于 {savedAge}</span>}
                    {hasMissing && <span className="text-warn/80"> · 缺少 {missing.join(" / ")}</span>}
                  </p>
                ) : (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">{item.cookieHint}</p>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-slate-500">
          Cookie 会过期（各平台不同，通常几周到几个月）。日志里出现「要求登录」「412」时，
          重新复制一次即可，已下载的文件不受影响。
        </p>
      </div>
    </CollapsibleCard>
  );
}
