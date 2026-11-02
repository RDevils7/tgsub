import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PlatformId, PlatformInfo, PlatformStatus } from "../types";
import { Badge, Button, StatusDot, Toggle, useToast } from "../components/ui";
import { IconAlert, IconCheck, IconLink, IconRefresh } from "../components/icons";

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
    required: [["SESSDATA"], ["bili_jct"]],
  },
  {
    id: "douyin",
    label: "抖音",
    placeholder: "ttwid=xxx; msToken=yyy; …",
    cookieHint: "需要 ttwid、msToken 等；不填往往只能拿到带水印的低清版本，且容易被风控",
    required: [["ttwid", "msToken", "odin_tt"]],
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    placeholder: "web_session=xxx; a1=yyy; …",
    cookieHint: "需要 web_session、a1；只支持视频笔记，图文笔记没有视频流",
    required: [["web_session"], ["a1"]],
  },
  {
    id: "youtube",
    label: "YouTube",
    placeholder: "SID=xxx; SAPISID=yyy; …",
    cookieHint: "大陆网络必须先在下面配代理；会看会员/年龄限制的视频才需要 Cookie（SID、SAPISID）",
    required: [["SID", "SAPISID", "__Secure-3PAPISID", "LOGIN_INFO"]],
    needsProxy: true,
  },
];

const QUALITIES = [
  { value: "best", label: "最高（原画）" },
  { value: "1080", label: "1080P" },
  { value: "720", label: "720P" },
  { value: "480", label: "480P" },
];

/** 拆 Cookie 串，和后天解析规则保持一致（前端只用来即时提示） */
function parseCookie(raw: string): { count: number; keys: string[]; missing: string[] } {
  const keys: string[] = [];
  let count = 0;
  for (const chunk of String(raw ?? "").split(/[;\n]/)) {
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

export default function PlatformPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [quality, setQuality] = useState("1080");
  const [dir, setDir] = useState("第三方");
  const [meta, setMeta] = useState(true);
  const [proxy, setProxy] = useState("");
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
    setQuality(res.quality || "1080");
    setDir(res.dir || "第三方");
    setMeta(res.meta);
    setProxy(res.proxy ?? "");
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
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-300">
            <IconLink className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-[14px] font-semibold text-white">第三方平台</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              B站 / 抖音 / 小红书 / YouTube 链接下载，引擎是 yt-dlp；在「手动下载」页粘贴链接即可
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      {/* 引擎状态 */}
      <div className="mt-4 rounded-xl border border-white/[0.06] bg-black/20 p-3.5">
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
            <span className="text-[11.5px] text-slate-300">写 nfo 与截帧封面</span>
          </label>
        </div>
      </div>

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
          B站 / 抖音 / 小红书 在墙内直连最快，留空即可；<span className="text-slate-400">YouTube 与检查更新必须走代理</span>。
          与上面「网络与代理」里的 Telegram 代理互相独立。
        </p>
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
    </section>
  );
}
