import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { PlatformId, PlatformStatus } from "../types";
import { Badge, Button, StatusDot, Toggle, useToast } from "../components/ui";
import { IconAlert, IconCheck, IconLink, IconRefresh } from "../components/icons";

/**
 * 设置页的「第三方平台」卡片。
 *
 * 自带加载与保存：Cookie 是加密字段，保存方式和其他设置不同（逐条提交、
 * 空字符串表示清除），放在这里比塞进页面的大 draft 更清楚。
 */

const PLATFORMS: Array<{ id: PlatformId; label: string; cookieHint: string }> = [
  {
    id: "bilibili",
    label: "B站",
    cookieHint: "浏览器登录后复制整串 Cookie，至少要有 SESSDATA（大会员画质还需要它对应账号）",
  },
  {
    id: "douyin",
    label: "抖音",
    cookieHint: "需要 ttwid、msToken 等；不填往往只能拿到带水印的低清版本，且容易被风控",
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    cookieHint: "需要 web_session、a1；只支持视频笔记，图文笔记没有视频流",
  },
];

const QUALITIES = [
  { value: "best", label: "最高（原画）" },
  { value: "1080", label: "1080P" },
  { value: "720", label: "720P" },
  { value: "480", label: "480P" },
];

export default function PlatformPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [quality, setQuality] = useState("1080");
  const [dir, setDir] = useState("第三方");
  const [meta, setMeta] = useState(true);
  const [ytdlpPath, setYtdlpPath] = useState("");
  const [cookies, setCookies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    const res = await api.platformStatus();
    setStatus(res);
    setEnabled(res.enabled);
    setQuality(res.quality || "1080");
    setDir(res.dir || "第三方");
    setMeta(res.meta);
    return res;
  }, []);

  useEffect(() => {
    void load().catch((err) => toast.push((err as Error).message, "error"));
  }, [load, toast]);

  const saveConfig = async () => {
    setBusy("config");
    try {
      await api.saveSettings({
        platform_enabled: enabled,
        platform_quality: quality,
        platform_dir: dir,
        platform_meta: meta,
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
      setStatus((prev) => (prev ? { ...prev, ytdlp: res.ytdlp } : prev));
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

  const engine = status?.ytdlp;
  const cookieState = (id: PlatformId) => status?.platforms.find((p) => p.id === id);

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
              B站 / 抖音 / 小红书 链接下载，引擎是 yt-dlp；在「手动下载」页粘贴链接即可
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
          <div className="flex items-center gap-2">
            <StatusDot className={engine?.available ? "bg-emerald-400" : "bg-rose-400"} />
            <span className="text-[12.5px] text-slate-200">yt-dlp</span>
            <span className="font-mono text-[11.5px] text-slate-400">
              {engine?.available ? engine.version ?? "已安装" : "不可用"}
            </span>
            {engine?.source && (
              <span className="text-[11px] text-slate-500">
                {engine.source === "bundled" ? "镜像内置" : engine.source === "custom" ? "手动指定" : "PATH"}
              </span>
            )}
          </div>
          <Button size="sm" onClick={() => void probeEngine()} loading={probing}>
            <IconRefresh className="h-3.5 w-3.5" />
            重新检测
          </Button>
        </div>
        {engine?.available ? (
          <p className="mt-1.5 break-all font-mono text-[10.5px] text-slate-500">{engine.path}</p>
        ) : (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn/90">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {engine?.error ?? "未找到 yt-dlp"}
            <span className="text-slate-500">· 1.0.5 起的镜像已内置，本地开发可填系统里的路径</span>
          </p>
        )}
        <input
          className="field mt-2 font-mono text-[11.5px]"
          placeholder="自定义 yt-dlp 路径（留空自动查找）"
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
            return (
              <div key={item.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-slate-200">{item.label}</span>
                    <Badge
                      className={
                        saved
                          ? "border-emerald-500/20 bg-emerald-500/10 text-ok"
                          : "border-white/10 bg-white/[0.04] text-slate-500"
                      }
                    >
                      {saved ? `已保存 · ${state?.cookieHint ?? ""}` : "未配置"}
                    </Badge>
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
                      disabled={!(cookies[item.id] ?? "").trim()}
                    >
                      保存
                    </Button>
                  </div>
                </div>
                <input
                  className="field mt-2 font-mono text-[11px]"
                  placeholder={saved ? "粘贴新的 Cookie 可覆盖" : "SESSDATA=xxx; bili_jct=yyy; …"}
                  value={cookies[item.id] ?? ""}
                  onChange={(e) => setCookies((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  spellCheck={false}
                />
                <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">{item.cookieHint}</p>
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
