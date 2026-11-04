import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { FfmpegStatus } from "../types";
import { Badge, Button, Spinner, StatusDot } from "./ui";
import { IconAlert, IconCheck, IconRefresh } from "./icons";

/**
 * ffmpeg 的实际状态：现在到底在用哪个二进制、什么版本、从哪来的。
 *
 * 之前设置页只有一个输入框，填没填对全靠猜 —— 截帧失败时才知道路径不对。
 * 这里直接把解析结果摆出来（内置包 / 环境变量 / PATH / 手填路径都会标注来源）。
 */
export default function FfmpegStatusPanel({ configuredPath = "" }: { configuredPath?: string }) {
  const [state, setState] = useState<FfmpegStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      setState(await api.ffmpegStatus(refresh));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const info = state?.ffmpeg;
  const pending = Boolean(configuredPath.trim()) && configuredPath.trim() !== (info?.ffmpeg ?? "");

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {busy && !info ? (
            <Spinner className="h-3.5 w-3.5 text-slate-400" />
          ) : info?.available ? (
            <Badge className="border-emerald-500/25 bg-emerald-500/10 text-ok">
              <StatusDot className="bg-emerald-400" />
              可用
            </Badge>
          ) : (
            <Badge className="border-rose-500/25 bg-rose-500/10 text-err">
              <IconAlert className="h-3 w-3" />
              未找到
            </Badge>
          )}
          <p className="text-[12.5px] text-slate-300">ffmpeg 运行状态</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load(true)} disabled={busy}>
          <IconRefresh className="h-3 w-3" />
          重新检测
        </Button>
      </div>

      {info?.available ? (
        <dl className="mt-2.5 space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="shrink-0 text-[11.5px] text-slate-500">当前使用</dt>
            <dd className="break-all font-mono text-[11.5px] text-slate-300">{info.ffmpeg}</dd>
            {state?.sourceLabel && (
              <span className="rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10.5px] text-slate-500">
                {state.sourceLabel}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="shrink-0 text-[11.5px] text-slate-500">版本</dt>
            <dd className="font-mono text-[11.5px] text-slate-300">ffmpeg {info.version ?? "未知"}</dd>
            <span className="text-[11px] text-slate-600">· 媒体信息走 ffmpeg -i 解析</span>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-[11.5px] leading-relaxed text-slate-400">
          {info?.error || (busy ? "正在检测…" : "未检测到 ffmpeg，截帧与封面生成会失败。")}
        </p>
      )}

      {pending && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
          <IconAlert className="mt-0.5 h-3 w-3 shrink-0" />
          输入框里的路径还没保存，或保存后未生效：现在跑的仍是上面这个
        </p>
      )}
      {!pending && configuredPath.trim() && info?.available && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ok/80">
          <IconCheck className="h-3 w-3" />
          已按设置里的路径生效
        </p>
      )}
      {error && <p className="mt-1.5 text-[11px] leading-relaxed text-err">{error}</p>}
    </div>
  );
}
