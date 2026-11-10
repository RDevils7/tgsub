import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { formatDateTime } from "../utils";
import type { AppSettings, EmbyProbeResult, EmbyStatus, SettingsResponse } from "../types";
import { Badge, Button, Field, Spinner, StatusDot, Toggle, useToast } from "./ui";
import { IconCheck, IconEye, IconEyeOff, IconRefresh, IconSpark, IconTv } from "./icons";
import CollapsibleCard from "./CollapsibleCard";

/**
 * Emby 入库通知（嵌在设置页里）。
 *
 * 下载完成后把新文件的路径提交给 Emby 的 `POST /Library/Media/Updated`，
 * 让它对这一条做增量扫描 —— 不用等定时任务，也不用去后台点「扫描媒体库」。
 *
 * 这块自己管自己的草稿与保存：它只碰 emby_notify / emby_url / emby_path_map
 * 三个字段，和设置页其它卡片的保存互不影响。
 */
/** 给外层卡片汇总状态用（设置页里三块共用一张卡、只留一个状态徽章） */
export interface EmbyNotifyState {
  enabled: boolean;
  configured: boolean;
  label: string;
}

export interface EmbyNotifyPanelProps {
  /** 不画自己的标题栏与折叠箭头，只输出内容，由外层那张卡统一兜住 */
  embedded?: boolean;
  /** 入库通知开关 / 配置状态变化时回吐给外层 */
  onState?: (state: EmbyNotifyState) => void;
}

export default function EmbyNotifyPanel({ embedded = false, onState }: EmbyNotifyPanelProps = {}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<EmbyStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<EmbyProbeResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notifyPath, setNotifyPath] = useState("");
  const [notifying, setNotifying] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [settingsRes, statusRes] = await Promise.all([api.settings(), api.embyStatus()]);
      setData(settingsRes);
      setStatus(statusRes);
      setDraft(settingsRes.settings);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // 通知结果只存在服务端内存里，隔几秒拉一次就能看到实时流水
  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.embyStatus().then(setStatus).catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, []);

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload: Partial<AppSettings> & { emby_api_key?: string } = {
        emby_notify: draft.emby_notify,
        emby_url: draft.emby_url,
        emby_path_map: draft.emby_path_map,
      };
      if (apiKey.trim()) payload.emby_api_key = apiKey.trim();
      const res = await api.saveSettings(payload);
      setData((prev) => (prev ? { ...prev, settings: res.settings, emby: res.emby ?? prev.emby } : prev));
      setDraft(res.settings);
      setApiKey("");
      toast.push("Emby 入库设置已保存", "success");
      setStatus(await api.embyStatus().catch(() => status));
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    try {
      const res = await api.saveSettings({ emby_api_key: "" });
      setData((prev) => (prev ? { ...prev, emby: res.emby ?? prev.emby } : prev));
      setApiKey("");
      toast.push("已清除 Emby API Key", "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!draft) return;
    setTesting(true);
    setProbe(null);
    try {
      const res = await api.embyTest({ url: draft.emby_url, apiKey: apiKey.trim() || undefined });
      setProbe(res);
      toast.push(
        res.ok ? `连接成功：${res.serverName ?? "Emby"}${res.version ? ` v${res.version}` : ""}` : res.error || "连接失败",
        res.ok ? "success" : "error",
      );
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setTesting(false);
    }
  };

  const refreshLibrary = async () => {
    setRefreshing(true);
    try {
      const res = await api.embyRefresh();
      toast.push(res.ok ? "已让 Emby 开始全库扫描" : res.error || "触发失败", res.ok ? "success" : "error");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setRefreshing(false);
    }
  };

  const pushPath = async () => {
    if (!notifyPath.trim()) {
      toast.push("请填写要补推的路径", "error");
      return;
    }
    setNotifying(true);
    try {
      const res = await api.embyNotify(notifyPath.trim());
      toast.push(res.ok ? "已提交给 Emby" : res.record.error || "提交失败", res.ok ? "success" : "error");
      if (res.ok) setNotifyPath("");
      setStatus(await api.embyStatus().catch(() => status));
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setNotifying(false);
    }
  };

  const exampleMap = useMemo(() => {
    const dir = status?.downloadDir || "/downloads";
    return `${dir}=/volume1/media/tgsub`;
  }, [status?.downloadDir]);

  // 外层只有一个状态徽章，这里把入库通知的状态回吐出去汇总。
  // 数据没到之前别回吐「未启用」，否则卡片收起时外层的兜底状态会被误覆盖。
  useEffect(() => {
    if (!data || !draft) return;
    onState?.({
      enabled: !!draft.emby_notify,
      configured: !!status?.configured,
      label: !draft.emby_notify ? "未启用" : status?.configured ? "已启用" : "配置不完整",
    });
  }, [data, draft, status?.configured, onState]);

  if (!data || !draft) {
    return (
      <div className="flex h-32 items-center justify-center text-slate-500">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  const badge = !draft.emby_notify
    ? { tone: "border-white/10 bg-white/[0.03] text-slate-400", dot: "bg-slate-500", label: "未启用" }
    : !status?.configured
      ? { tone: "border-amber-500/20 bg-amber-500/10 text-warn", dot: "bg-amber-400", label: "配置不完整" }
      : { tone: "border-emerald-500/20 bg-emerald-500/10 text-ok", dot: "bg-emerald-400", label: "已启用" };

  const successCount = status?.history.filter((h) => h.ok).length ?? 0;

  const body = (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">服务地址</p>
          <p className="mt-1 break-all font-mono text-[12px] text-slate-300">{status?.url || "未填写"}</p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">最近一次入库</p>
          <p className="mt-1 text-[12px] text-slate-300">
            {status?.lastNotifiedAt ? formatDateTime(status.lastNotifiedAt) : "还没有成功提交过"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            本次运行成功 {successCount} 次
            {status?.pending ? ` · 待提交 ${status.pending} 项` : ""}
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">路径映射</p>
          <p className="mt-1 break-all font-mono text-[11.5px] leading-relaxed text-slate-300">
            {status?.pathMap.length ? status.pathMap.join("\n") : "未配置（按原路径提交）"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" onClick={() => void test()} loading={testing}>
          <IconSpark className="h-3 w-3" />
          测试连接
        </Button>
        <Button size="sm" onClick={() => void refreshLibrary()} loading={refreshing} disabled={!status?.configured}>
          <IconRefresh className="h-3 w-3" />
          让 Emby 全库扫描
        </Button>
      </div>

      {probe && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[11.5px] leading-relaxed ${
            probe.ok
              ? "border-emerald-500/25 bg-emerald-500/[0.06] text-ok"
              : "border-rose-500/25 bg-rose-500/[0.06] text-err"
          }`}
        >
          {probe.ok ? <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
          <div>
            {probe.ok
              ? `连接成功：${probe.serverName ?? "Emby"}${probe.version ? ` · v${probe.version}` : ""}（${probe.url ?? status?.url}）`
              : probe.error}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
        <div className="pr-4">
          <p className="text-[13px] text-slate-200">下载完成后通知 Emby 入库</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            关闭后不再自动提交，Emby 只能靠自己的定时扫描发现新集；和 Emby 自身的库配置互不影响
          </p>
        </div>
        <Toggle checked={draft.emby_notify} onChange={(next) => patch("emby_notify", next)} />
      </div>

      <div className="mt-3 space-y-3">
        <Field label="Emby 地址" hint="例如 http://192.168.1.10:8096；不写协议按 http 处理，末尾的 /web 会自动去掉">
          <input
            className="field font-mono text-[12.5px]"
            placeholder="http://192.168.1.10:8096"
            value={draft.emby_url}
            onChange={(e) => patch("emby_url", e.target.value)}
          />
        </Field>

        <Field
          label="Emby API Key"
          hint={
            data.emby?.apiKeySet
              ? `已保存 ${data.emby.apiKeyHint}，留空表示不修改`
              : "Emby 后台 → 设置 → API 密钥 → 新建，权限选管理员"
          }
        >
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              className="field pr-10 font-mono text-[12.5px]"
              placeholder={data.emby?.apiKeySet ? "留空保持不变" : "粘贴 Emby API Key"}
              value={apiKey}
              autoComplete="new-password"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition hover:text-slate-300"
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
            >
              {showKey ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        <Field
          label="路径映射"
          hint="每行一条「本机路径=Emby 看到的路径」。容器里下载到 /downloads，而 Emby 挂在 /volume1/media/tgsub 时必须填，否则 Emby 会静默忽略"
        >
          <textarea
            className="field min-h-[76px] font-mono text-[12px] leading-relaxed"
            placeholder={exampleMap}
            value={draft.emby_path_map}
            onChange={(e) => patch("emby_path_map", e.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500">
            <button
              type="button"
              onClick={() => patch("emby_path_map", exampleMap)}
              className="rounded-md border border-white/[0.08] px-2 py-1 text-[11.5px] text-slate-400 transition hover:text-slate-200"
            >
              填入示例
            </button>
            <span>
              本机下载目录：<code className="text-slate-400">{status?.downloadDir}</code>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.emby?.apiKeySet && (
              <Button variant="ghost" size="sm" onClick={() => void clearKey()} loading={saving}>
                清除密钥
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => void save()} loading={saving}>
              保存入库设置
            </Button>
          </div>
        </div>
      </div>

      <details className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
        <summary className="cursor-pointer select-none text-[12.5px] text-slate-300">
          最近入库记录
          <span className="ml-2 text-[11px] text-slate-500">
            {status?.history.length ? `最近 ${Math.min(status.history.length, 12)} 条` : "还没有记录"}
          </span>
        </summary>

        {status?.history.length ? (
          <ul className="mt-2 divide-y divide-white/[0.05] overflow-hidden rounded-lg border border-white/[0.06]">
            {status.history.slice(0, 12).map((item) => (
              <li key={`${item.at}-${item.paths[0] ?? ""}`} className="bg-white/[0.02] px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusDot className={item.ok ? "bg-emerald-400" : "bg-rose-400"} />
                  <span className="text-[12px] text-slate-300">{formatDateTime(item.at)}</span>
                  <span className="text-[11.5px] text-slate-500">
                    {item.paths.length} 项 · {item.auto ? "自动" : "手动"}
                    {item.status ? ` · HTTP ${item.status}` : ""}
                  </span>
                  <span className={`ml-auto text-[11.5px] ${item.ok ? "text-ok" : "text-err"}`}>
                    {item.ok ? "已提交" : item.error}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-slate-500">
                  {item.paths.slice(0, 3).join("  ·  ")}
                  {item.paths.length > 3 ? ` …（另有 ${item.paths.length - 3} 项）` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">
            还没有记录。下载完一集之后回来看看，成功的提交会出现在这里；服务重启后清空。
          </p>
        )}

        <div className="mt-3">
          <p className="text-[12px] text-slate-300">补推路径</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            早期下载的剧集不会自动补推，填剧集目录名（例如 <code className="text-slate-400">美人局</code>）或绝对路径手动提交一次
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              className="field flex-1 font-mono text-[12.5px]"
              placeholder="美人局"
              value={notifyPath}
              onChange={(e) => setNotifyPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !notifying) void pushPath();
              }}
            />
            <Button size="sm" onClick={() => void pushPath()} loading={notifying} disabled={!status?.configured}>
              提交入库
            </Button>
          </div>
        </div>
      </details>
    </>
  );

  // 嵌入模式：只输出内容，标题栏 / 折叠箭头 / 状态徽章都由外层那张卡统一负责
  if (embedded) return body;

  // 单独使用时仍是一张完整卡片（保留旧行为，方便别处复用）
  return (
    <CollapsibleCard
      id="emby-notify"
      tint="emerald"
      icon={<IconTv className="h-4 w-4" />}
      title="入库通知"
      desc="每集下载完成后把路径提交给 Emby 的 /Library/Media/Updated 接口，Emby 立刻增量扫描，不用等定时任务也不用手动点扫描"
      defaultOpen
      extra={
        <Badge className={badge.tone}>
          <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
          {badge.label}
        </Badge>
      }
    >
      {body}
    </CollapsibleCard>
  );
}
