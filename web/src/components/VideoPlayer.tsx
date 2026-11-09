import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconCamera,
  IconChevronLeft,
  IconChevronRight,
  IconFullscreen,
  IconFullscreenExit,
  IconImage,
  IconPause,
  IconPip,
  IconPlay,
  IconRepeat,
  IconTarget,
  IconVolume,
  IconVolumeMute,
} from "./icons";
import { Spinner } from "./ui";
import { formatClock, parseSeekText } from "../utils";

/**
 * 媒体库播放器。
 *
 * 为什么不直接用 `<video controls>`：直出（MP4 + Range）时原生控件挺好用，但实时流
 * （`remux` 换封装 / `transcode` 显卡转码）是 fMP4、**没有 Content-Length**，
 * 浏览器的时长是 `Infinity`、原生进度条等于废的，也没法 `currentTime = x` 跳转。
 *
 * 所以这里自绘一整套控制条：
 * - 直接播放：拖动 / 「跳到第 N 秒」都走 `video.currentTime`，瞬时生效；
 * - 实时流：**曲线跳转** —— 把目标秒数拼进 `?start=` 重开一路流（服务端 `-ss` 输入侧 seek），
 *   UI 上先用目标位置占位，等第一帧到了再刷新真实位置。这里做了 280ms 防抖，
 *   连按快进只重开一次 ffmpeg。
 *
 * 所有控件都在黑底上，文字一律写死 `#fff`：主题自适应的 `text-white` 在浅色主题下
 * 会变成深色，压在视频上就看不见了。
 */

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const VOLUME_KEY = "tgsub.media.volume";
const AUTONEXT_KEY = "tgsub.media.autonext";
/** 实时流重开一路的防抖窗口：连按 ← 五下只起一个 ffmpeg */
const RESTART_DELAY = 280;
/** 控制条自动隐藏延时 */
const IDLE_HIDE = 2800;

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  } catch {
    return 1;
  }
}

function readAutoNext(): boolean {
  try {
    return localStorage.getItem(AUTONEXT_KEY) === "1";
  } catch {
    return false;
  }
}

export interface VideoPlayerProps {
  /** 已按 playMode 拼好的播放地址（不带 start） */
  src: string;
  /** 实时流（换封装 / 转码）：没有总长度，跳转只能重开一路流 */
  seekable: boolean;
  /** ffmpeg 探测到的时长，实时流全靠它画进度条 */
  durationSec: number | null;
  /** 顶部小标签，例如「显卡转码 · HEVC」 */
  badge?: string | null;
  poster?: string | null;
  onError: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  /**
   * strm：播放到片头之后自动截一帧当封面。
   * 只截一次；调用方只在「还没有封面」时传 true。
   * 截的是浏览器里已经解码的那一帧，不产生任何额外的网盘请求。
   */
  autoPoster?: boolean;
  /** 保存封面；自动与手动共用，overwrite=true 表示用户手动覆盖 */
  onSavePoster?: (dataUrl: string, overwrite: boolean) => Promise<boolean>;
  /** strm 用 metadata：避免点开播放弹窗就预拉一大段流 */
  preload?: "auto" | "metadata";
}

export function VideoPlayer({
  src,
  seekable,
  durationSec,
  badge,
  poster,
  onError,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  autoPoster = false,
  onSavePoster,
  preload = "auto",
}: VideoPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  /** 这一路流的起点（秒）。实时流重开时更新，直出永远是 0 */
  const [appliedStart, setAppliedStart] = useState(0);
  const [restartKey, setRestartKey] = useState(0);
  /** 当前播放位置（秒，绝对时间轴） */
  const [pos, setPos] = useState(0);
  /** 拖动中的目标位置，null = 没在拖 */
  const [draft, setDraft] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; sec: number } | null>(null);
  const [duration, setDuration] = useState(Math.max(0, Number(durationSec) || 0));
  const [buffered, setBuffered] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [volume, setVolume] = useState(readVolume);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [rateOpen, setRateOpen] = useState(false);
  const [autonext, setAutonext] = useState(readAutoNext);
  const [fullscreen, setFullscreen] = useState(false);
  const [jumpText, setJumpText] = useState("");
  const [savingPoster, setSavingPoster] = useState(false);

  /** 自动封面只试一次；切集时组件按 episode.path 重新挂载，自然重置 */
  const posterTried = useRef(false);

  /** 用户想不想在播 —— 重挂载视频元素后据此决定要不要自动播 */
  const playIntent = useRef(true);
  /** 跳转占位：等新流的第一帧到达前，别让旧流的 timeupdate 把位置改回去 */
  const holdPos = useRef(false);
  const seekTimer = useRef<number | null>(null);
  const pendingTarget = useRef(0);
  const hideTimer = useRef<number | null>(null);
  const clickTimer = useRef<number | null>(null);

  const maxPos = duration > 0 ? duration : 0;
  const displayPos = Math.max(0, Math.min(maxPos || Number.MAX_SAFE_INTEGER, draft ?? pos));

  /** 实时流的地址：只有真正「已应用」的起点才拼进去，防抖期间地址不变 */
  const streamSrc = useMemo(() => {
    if (!seekable || appliedStart <= 0) return src;
    return `${src}${src.includes("?") ? "&" : "?"}start=${appliedStart.toFixed(2)}`;
  }, [src, seekable, appliedStart]);

  /* --------------------------- 视频元素生命周期 --------------------------- */

  const attachVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      if (!el) return;
      el.volume = volume;
      el.muted = muted;
      el.playbackRate = rate;
    },
    [volume, muted, rate],
  );

  /** 自动 / 手动设封面共用一次保存；失败由调用方决定要不要提示 */
  const submitPoster = useCallback(
    async (dataUrl: string, overwrite: boolean) => {
      if (!onSavePoster) return;
      setSavingPoster(true);
      try {
        await onSavePoster(dataUrl, overwrite);
      } finally {
        setSavingPoster(false);
      }
    },
    [onSavePoster],
  );

  useEffect(() => {
    setDuration(Math.max(0, Number(durationSec) || 0));
  }, [durationSec]);

  /** 探测没拿到时长时，退回视频元素自己的 duration（直出 MP4 一定有） */
  const syncDuration = (el: HTMLVideoElement) => {
    const total = el.duration;
    if (Number.isFinite(total) && total > 1) setDuration((prev) => (total > prev ? total : prev));
  };

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }, [volume, muted]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTONEXT_KEY, autonext ? "1" : "0");
    } catch {
      /* 同上 */
    }
  }, [autonext]);

  /* ------------------------------ 控制条显隐 ------------------------------ */

  const bumpControls = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowControls(false);
    }, IDLE_HIDE);
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (seekTimer.current) window.clearTimeout(seekTimer.current);
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
    },
    [],
  );

  /* -------------------------------- 播放控制 -------------------------------- */

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
    bumpControls();
  }, [bumpControls]);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  const toggleFullscreen = useCallback(async () => {
    const el = stageRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // iOS Safari 不支持元素全屏，退回视频自己的全屏
      const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      video?.webkitEnterFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /**
   * 跳转到第 t 秒。
   *
   * 直出：直接改 currentTime，瞬时。
   * 实时流：更新占位位置 + 防抖后重开一路流（服务端 `-ss` 输入侧 seek，精确到帧）。
   */
  const applySeek = useCallback(
    (target: number) => {
      const el = videoRef.current;
      const limit = duration > 0 ? duration - 0.3 : Math.max(0, target);
      const t = Math.max(0, Math.min(limit, Number.isFinite(target) ? target : 0));
      setDraft(null);
      setPos(t);
      setHover(null);
      if (!seekable) {
        if (el) {
          try {
            el.currentTime = t;
          } catch {
            /* 有些容器跳不过去，忽略 */
          }
        }
        bumpControls();
        return;
      }
      holdPos.current = true;
      setSeeking(true);
      pendingTarget.current = t;
      if (seekTimer.current) window.clearTimeout(seekTimer.current);
      seekTimer.current = window.setTimeout(() => {
        seekTimer.current = null;
        setAppliedStart(pendingTarget.current);
        setRestartKey((k) => k + 1);
      }, RESTART_DELAY);
      bumpControls();
    },
    [bumpControls, duration, seekable],
  );

  /** 相对当前位置快进 / 快退 */
  const nudge = useCallback(
    (delta: number) => {
      const base = draft ?? pos;
      applySeek(base + delta);
    },
    [applySeek, draft, pos],
  );

  const submitJump = (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseSeekText(jumpText);
    if (value === null) return;
    applySeek(value);
    setJumpText("");
  };

  /* -------------------------------- 键盘快捷键 -------------------------------- */

  const latest = useRef({ applySeek, nudge, togglePlay, toggleMute, toggleFullscreen, volume, duration });
  latest.current = { applySeek, nudge, togglePlay, toggleMute, toggleFullscreen, volume, duration };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      const api = latest.current;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          // 长按空格会疯狂开关，按住期间只认第一次
          if (!e.repeat) api.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          api.nudge(e.shiftKey ? -30 : -5);
          break;
        case "ArrowRight":
          e.preventDefault();
          api.nudge(e.shiftKey ? 30 : 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume((v) => Math.min(1, Number((v + 0.1).toFixed(2))));
          setMuted(false);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume((v) => Math.max(0, Number((v - 0.1).toFixed(2))));
          break;
        case "m":
          if (!e.repeat) api.toggleMute();
          break;
        case "f":
          if (!e.repeat) void api.toggleFullscreen();
          break;
        case "Home":
          e.preventDefault();
          api.applySeek(0);
          break;
        case "End":
          if (api.duration > 0) {
            e.preventDefault();
            api.applySeek(api.duration - 1);
          }
          break;
        default:
          // 数字键 0~9：跳到整段的 0% / 10% … 90%
          if (/^[0-9]$/.test(e.key) && api.duration > 0) {
            e.preventDefault();
            api.applySeek((Number(e.key) / 10) * api.duration);
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* -------------------------------- 进度条拖动 -------------------------------- */

  const ratioAt = (clientX: number) => {
    const el = barRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  };

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!maxPos) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft(ratioAt(e.clientX) * maxPos);
  };

  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!maxPos) return;
    const ratio = ratioAt(e.clientX);
    const el = barRef.current;
    const rect = el?.getBoundingClientRect();
    setHover({ x: rect ? Math.max(0, Math.min(rect.width, e.clientX - rect.left)) : 0, sec: ratio * maxPos });
    if (draft !== null) setDraft(ratio * maxPos);
  };

  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draft === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    applySeek(draft);
  };

  /* --------------------------------- 渲染 --------------------------------- */

  const pct = maxPos > 0 ? (displayPos / maxPos) * 100 : 0;
  const bufferedPct = maxPos > 0 ? Math.min(100, ((buffered - (seekable ? appliedStart : 0)) / maxPos) * 100) : 0;
  const progressStyle = { width: `${Math.max(0, Math.min(100, pct))}%` };
  const barDisabled = maxPos <= 0;

  return (
    <div
      ref={stageRef}
      className="player-stage group relative overflow-hidden rounded-2xl bg-black ring-1 ring-white/[0.06]"
      onPointerMove={bumpControls}
      onPointerLeave={() => {
        if (videoRef.current && !videoRef.current.paused) setShowControls(false);
        setHover(null);
      }}
    >
      <video
        ref={attachVideo}
        key={`${streamSrc}#${restartKey}`}
        src={streamSrc}
        poster={poster ?? undefined}
        autoPlay={playIntent.current}
        playsInline
        preload={preload}
        className="aspect-video w-full bg-black"
        onClick={() => {
          // 单击播放/暂停，双击全屏：延迟 220ms 判断，避免双击被判成两次单击
          if (clickTimer.current) {
            window.clearTimeout(clickTimer.current);
            clickTimer.current = null;
            void toggleFullscreen();
            return;
          }
          clickTimer.current = window.setTimeout(() => {
            clickTimer.current = null;
            togglePlay();
          }, 220);
        }}
        onPlay={() => {
          playIntent.current = true;
          setPlaying(true);
          bumpControls();
        }}
        onPause={() => {
          playIntent.current = false;
          setPlaying(false);
          setBuffering(false);
          setShowControls(true);
        }}
        onLoadedMetadata={(e) => syncDuration(e.currentTarget)}
        onLoadedData={() => {
          holdPos.current = false;
          setSeeking(false);
          setBuffering(false);
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onTimeUpdate={(e) => {
          if (holdPos.current) return;
          const el = e.currentTarget;
          setPos((seekable ? appliedStart : 0) + el.currentTime);
          /**
           * strm 的自动封面：等画面真的解码出来、播放过了片头再截。
           * 截的是 <video> 里已有的那一帧（canvas），零额外请求；
           * 抓不到画面就不置位，下次 timeupdate 再试。
           */
          if (autoPoster && !posterTried.current && !savingPoster) {
            const total = el.duration;
            const at = Number.isFinite(total) && total > 1
              ? Math.min(Math.max(total * 0.12, 3), 30)
              : 8;
            if (el.currentTime >= at) {
              const dataUrl = captureJpeg(el);
              if (dataUrl) {
                posterTried.current = true;
                void submitPoster(dataUrl, false);
              }
            }
          }
        }}
        onProgress={(e) => {
          const el = e.currentTarget;
          if (!el.buffered.length) return;
          const end = el.buffered.end(el.buffered.length - 1);
          setBuffered((seekable ? appliedStart : 0) + end);
        }}
        onEnded={() => {
          setPlaying(false);
          setShowControls(true);
          if (autonext && hasNext) onNext();
        }}
        onError={onError}
      />

      {/* 顶部：模式标签 */}
      {badge && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-1.5 bg-gradient-to-b from-black/70 to-transparent px-3 py-2.5 transition-opacity ${
            showControls ? "opacity-100" : "opacity-0"
          }`}
        >
          <span className="rounded-md bg-black/45 px-1.5 py-0.5 text-[11px] font-medium text-[#fff]/90 ring-1 ring-white/15">
            {badge}
          </span>
        </div>
      )}

      {/* 缓冲 / 重新起流 */}
      {(seeking || (buffering && playing)) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex items-center gap-2 rounded-full bg-black/60 px-3.5 py-2 text-[12.5px] text-[#fff] backdrop-blur-sm">
            <Spinner className="h-3.5 w-3.5" />
            {seeking ? `正在跳到 ${formatClock(displayPos)}${seekable ? "（重新起流）" : ""}` : "缓冲中…"}
          </span>
        </div>
      )}

      {/* 暂停时的大播放键 */}
      {!playing && !seeking && !buffering && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="播放"
          className="absolute inset-0 grid place-items-center"
        >
          <span className="grid h-16 w-16 place-items-center rounded-full bg-black/45 text-[#fff] ring-1 ring-white/25 backdrop-blur-sm transition hover:scale-105 hover:bg-black/60">
            <IconPlay className="ml-0.5 h-7 w-7" />
          </span>
        </button>
      )}

      {/* 控制条 */}
      <div
        className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2.5 pb-2 pt-8 transition-opacity duration-200 ${
          showControls ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* 进度条 */}
        <div
          ref={barRef}
          role="slider"
          tabIndex={0}
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.floor(maxPos)}
          aria-valuenow={Math.floor(displayPos)}
          aria-valuetext={formatClock(displayPos)}
          title={barDisabled ? "还没探测到时长，拖不了" : seekable ? "拖动后服务端会从这一秒重新起流" : "拖动直接跳到这一秒"}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerLeave={() => setHover(null)}
          className={`relative mb-1 flex h-5 select-none items-center touch-none ${
            barDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          }`}
        >
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[#fff]/20">
            <div className="absolute inset-y-0 left-0 bg-[#fff]/25" style={{ width: `${bufferedPct}%` }} />
            <div className="absolute inset-y-0 left-0 bg-brand-400" style={progressStyle} />
          </div>
          <span
            className={`absolute h-3 w-3 -translate-x-1/2 rounded-full bg-[#fff] shadow transition-opacity ${
              draft !== null || hover ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
            style={{ left: `${Math.max(0, Math.min(100, pct))}%` }}
          />
          {hover && !barDisabled && (
            <span
              className="pointer-events-none absolute bottom-6 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/85 px-1.5 py-0.5 text-[11px] tabular-nums text-[#fff] ring-1 ring-white/20"
              style={{ left: hover.x }}
            >
              {formatClock(hover.sec)}
            </span>
          )}
        </div>

        {/* 按钮行 */}
        <div className="flex items-center gap-1 text-[#fff]">
          <CtrlButton label={playing ? "暂停（空格）" : "播放（空格）"} onClick={togglePlay} big>
            {playing ? <IconPause className="h-4 w-4" /> : <IconPlay className="ml-0.5 h-4 w-4" />}
          </CtrlButton>
          <CtrlButton label="后退 10 秒（← 5 秒 / Shift+← 30 秒）" onClick={() => nudge(-10)}>
            <span className="flex items-center gap-0.5">
              <IconChevronLeft className="h-3.5 w-3.5" />
              <span className="text-[10.5px] font-semibold tabular-nums">10</span>
            </span>
          </CtrlButton>
          <CtrlButton label="前进 10 秒（→ 5 秒 / Shift+→ 30 秒）" onClick={() => nudge(10)}>
            <span className="flex items-center gap-0.5">
              <span className="text-[10.5px] font-semibold tabular-nums">10</span>
              <IconChevronRight className="h-3.5 w-3.5" />
            </span>
          </CtrlButton>

          <span className="ml-1 shrink-0 text-[11.5px] tabular-nums text-[#fff]/85">
            {formatClock(displayPos)}
            <span className="text-[#fff]/45"> / {maxPos > 0 ? formatClock(maxPos) : "--:--"}</span>
          </span>

          {/* 跳到第 N 秒：HEVC 转码一路靠它精确定位 */}
          <form onSubmit={submitJump} className="ml-1.5 flex items-center gap-1">
            <input
              value={jumpText}
              onChange={(e) => setJumpText(e.target.value)}
              placeholder="跳到 00:00"
              aria-label="跳到第几秒"
              title="输入秒数或时间（83 / 1:23 / 01:02:03），回车或点右边按钮跳转"
              className="h-7 w-[86px] rounded-lg border border-[#fff]/20 bg-black/45 px-2 text-[11.5px] tabular-nums text-[#fff] outline-none transition placeholder:text-[#fff]/35 focus:border-brand-400 focus:bg-black/60"
            />
            <button
              type="submit"
              aria-label="跳转"
              title="跳到这一秒"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[#fff]/80 transition hover:bg-white/15 hover:text-[#fff]"
            >
              <IconTarget className="h-3.5 w-3.5" />
            </button>
          </form>

          <div className="ml-auto flex items-center gap-1">
            <div className="hidden items-center gap-1 md:flex">
              <CtrlButton label={muted ? "取消静音（m）" : "静音（m）"} onClick={toggleMute}>
                {muted || volume === 0 ? <IconVolumeMute className="h-4 w-4" /> : <IconVolume className="h-4 w-4" />}
              </CtrlButton>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setVolume(next);
                  setMuted(next === 0);
                }}
                aria-label="音量"
                title={`音量 ${Math.round((muted ? 0 : volume) * 100)}%`}
                className="h-1 w-16 cursor-pointer appearance-none rounded-full bg-[#fff]/25 accent-white"
              />
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setRateOpen((v) => !v)}
                title="播放速度"
                aria-label="播放速度"
                className={`h-8 rounded-lg px-2 text-[11.5px] font-semibold tabular-nums transition hover:bg-white/15 ${
                  rateOpen ? "bg-white/15 text-[#fff]" : "text-[#fff]/85"
                }`}
              >
                {rate}×
              </button>
              {rateOpen && (
                <div className="absolute bottom-10 right-0 w-[132px] rounded-xl border border-white/10 bg-ink-900/95 p-1.5 shadow-card backdrop-blur">
                  <p className="px-2 pb-1 pt-0.5 text-[10.5px] text-slate-400">播放速度</p>
                  {RATES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setRate(value);
                        setRateOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[12px] transition hover:bg-white/[0.07] ${
                        rate === value ? "text-brand-300" : "text-slate-300"
                      }`}
                    >
                      {value}×
                      {rate === value && <span className="text-[10px]">当前</span>}
                    </button>
                  ))}
                  <div className="mt-1 border-t border-white/[0.06] pt-1">
                    <button
                      type="button"
                      onClick={() => setAutonext((v) => !v)}
                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/[0.07]"
                      title="播完这一集自动下一集"
                    >
                      <span className="flex items-center gap-1.5">
                        <IconRepeat className="h-3.5 w-3.5" />
                        连播
                      </span>
                      <span className={autonext ? "text-brand-300" : "text-slate-500"}>{autonext ? "开" : "关"}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <CtrlButton label="截图（当前帧）" onClick={() => void snapshot(videoRef.current, seekable ? appliedStart : 0)}>
              <IconCamera className="h-4 w-4" />
            </CtrlButton>

            {onSavePoster && (
              <CtrlButton
                label="把当前画面设为封面（覆盖自动截取的）"
                disabled={savingPoster}
                onClick={() => {
                  const dataUrl = captureJpeg(videoRef.current);
                  if (dataUrl) void submitPoster(dataUrl, true);
                }}
              >
                <IconImage className="h-4 w-4" />
              </CtrlButton>
            )}

            {"pictureInPictureEnabled" in document && document.pictureInPictureEnabled && (
              <CtrlButton
                label="画中画"
                onClick={() => {
                  const el = videoRef.current;
                  if (!el) return;
                  if (document.pictureInPictureElement) {
                    void document.exitPictureInPicture().catch(() => undefined);
                    return;
                  }
                  const request = el.requestPictureInPicture?.();
                  if (request) void request.catch(() => undefined);
                }}
              >
                <IconPip className="h-4 w-4" />
              </CtrlButton>
            )}

            <CtrlButton label="上一集（[）" onClick={onPrev} disabled={!hasPrev}>
              <IconChevronLeft className="h-4 w-4" />
            </CtrlButton>
            <CtrlButton label="下一集（]）" onClick={onNext} disabled={!hasNext}>
              <IconChevronRight className="h-4 w-4" />
            </CtrlButton>
            <CtrlButton label={fullscreen ? "退出全屏（f）" : "全屏（f）"} onClick={() => void toggleFullscreen()}>
              {fullscreen ? <IconFullscreenExit className="h-4 w-4" /> : <IconFullscreen className="h-4 w-4" />}
            </CtrlButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function CtrlButton({
  label,
  onClick,
  disabled,
  big,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  big?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`grid shrink-0 place-items-center rounded-lg text-[#fff]/85 transition hover:bg-white/15 hover:text-[#fff] disabled:cursor-not-allowed disabled:opacity-30 ${
        big ? "h-9 w-9 bg-white/15" : "h-8 w-8"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 把当前帧转成 JPEG dataURL，用于「设为封面」。
 * 缩到 480 宽：海报墙用不了原尺寸，请求体也不会撑爆 express.json 的 1MB 限制。
 * strm 走服务端转发后是同源，canvas 不会被跨域污染；
 * 万一浏览器仍不让读画面，静默返回 null 即可，不影响播放。
 */
function captureJpeg(video: HTMLVideoElement | null, maxWidth = 480): string | null {
  if (!video || !video.videoWidth || video.readyState < 2) return null;
  try {
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return null;
  }
}

/** 截当前帧存成 PNG；跨域视频会被 canvas 拒绝，静默失败即可 */
async function snapshot(video: HTMLVideoElement | null, offset: number): Promise<void> {
  if (!video || !video.videoWidth) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = url;
    link.download = `snapshot-${formatClock(offset + video.currentTime).replace(/:/g, "-")}.png`;
    link.click();
  } catch {
    /* 浏览器不允许直接读画面 */
  }
}
