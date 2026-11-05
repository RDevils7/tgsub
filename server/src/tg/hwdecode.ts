import path from "node:path";

/**
 * 硬件解码（显卡转码）的纯逻辑层。
 *
 * 背景：浏览器（尤其 Windows 上的 Chrome）基本不认 HEVC / H.265，
 * 老办法是把这类文件判成「播不了」让用户下载。NAS 上（N100 / 群晖 / 威联通这类）
 * 往往有 Intel 核显，能把 HEVC 硬解 + 硬编成 H.264 实时串给浏览器 —— 既省 CPU 又能直接看。
 *
 * 这里只放**不碰 IO、不 spawn 进程**的判断与参数拼装，方便自检直接调用；
 * 真正跑 `ffmpeg -hwaccels` / 试转一帧的探测在 `ffmpeg.ts` 的 `hwCapability()`。
 *
 * 三种加速方式：
 * - `vaapi`：Linux 通用（Intel / AMD 核显都走这个，Intel 需要 iHD 驱动）
 * - `qsv`：Intel Quick Sync，Linux / Windows 都有，依赖驱动与 libvpl
 * - `software`：纯 CPU 的 libx264，只在显式配置 `HW_ACCEL=software` 时使用（兜底 / 测试）
 */

export type HwAccel = "vaapi" | "qsv" | "software";

export interface HwCapability {
  /** 能不能用显卡转码（`software` 也算能用，但默认不会选中它） */
  available: boolean;
  accel: HwAccel | null;
  /** vaapi / qsv 的设备节点，software 为 null */
  device: string | null;
  /** 实际使用的 H.264 编码器名 */
  encoder: string | null;
  /** 界面上显示的一句话，例如「VAAPI（/dev/dri/renderD128）」 */
  label: string;
  /** 不可用的原因（界面提示 / 排错用） */
  reason: string | null;
}

export const NO_HW: HwCapability = {
  available: false,
  accel: null,
  device: null,
  encoder: null,
  label: "无硬件解码",
  reason: null,
};

/**
 * 解析 `ffmpeg -hwaccels` 的输出。
 *
 * 样例：
 *   Hardware acceleration methods:
 *   vaapi
 *   qsv
 *   cuda
 */
export function parseHwaccels(stdout: string): string[] {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  const start = lines.findIndex((line) => line.startsWith("hardware acceleration"));
  const body = start >= 0 ? lines.slice(start + 1) : lines;
  return [...new Set(body.filter((line) => /^[a-z0-9_]+$/.test(line) && !line.includes(" ")))];
}

/**
 * 解析 `ffmpeg -encoders` 里的视频编码器名。
 *
 * 每行形如 ` V..... h264_vaapi   H.264/AVC (VAAPI)`，第一列是能力标记。
 */
export function parseEncoders(stdout: string): string[] {
  const out: string[] = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = /^\s*V[A-Z.]{5}\s+(\S+)/.exec(line);
    if (match) out.push(match[1].toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * 从「可用的 hwaccel + 可用的编码器」里挑一个。
 *
 * Linux 优先 vaapi：Intel / AMD 核显通吃，iHD 驱动对 N100（Gen12）的 HEVC 10bit 解码支持很好。
 * qsv 作为备选（有些精简镜像只编了 qsv）。Windows 上 vaapi 不可用，只看 qsv。
 *
 * 注意：这里只判断「编进去了」，设备能不能真开由调用方再试一帧确认。
 */
export function pickAccel(
  hwaccels: string[],
  encoders: string[],
  platform: string = process.platform,
): { accel: HwAccel; encoder: string } | null {
  const has = (name: string) => hwaccels.includes(name);
  const enc = (name: string) => encoders.includes(name);

  if (platform !== "win32" && platform !== "darwin") {
    if (has("vaapi") && enc("h264_vaapi")) return { accel: "vaapi", encoder: "h264_vaapi" };
  }
  if (has("qsv") && enc("h264_qsv")) return { accel: "qsv", encoder: "h264_qsv" };
  return null;
}

/** vaapi 的设备节点候选（renderD128 优先，多卡时取第一个能用的） */
export function vaapiDeviceCandidates(): string[] {
  return ["/dev/dri/renderD128", "/dev/dri/renderD129", "/dev/dri/renderD130"];
}

/** 转码目标高度：不超过 1080，且不大于源高度（不放大），向下取偶数 */
export function transcodeHeight(sourceHeight: number | null | undefined): number {
  const src = Number(sourceHeight) || 0;
  const capped = src > 0 ? Math.min(1080, src) : 1080;
  return Math.max(2, Math.floor(capped / 2) * 2);
}

/** 目标码率（kbps）：按高度给，1080p 6M 足够看清字幕和暗部 */
export function transcodeBitrateKbps(height: number): number {
  if (height >= 1000) return 6000;
  if (height >= 700) return 3500;
  if (height >= 400) return 1800;
  return 1000;
}

export interface TranscodeArgsOptions {
  input: string;
  accel: HwAccel;
  device?: string | null;
  /** 源视频高度（用于决定缩放与码率） */
  sourceHeight?: number | null;
  /** 从第几秒开始（拖动进度条时用，输入侧 seek） */
  startSec?: number;
  /** 音频码率 kbps，默认 160 */
  audioKbps?: number;
}

/**
 * 拼 ffmpeg 的实时转码参数：输出 fragmented MP4 到 stdout。
 *
 * 关键取舍：**只把解码交给显卡，滤镜留在 CPU 上**。
 * 如果强制 `-hwaccel_output_format vaapi`，一旦遇到 vaapi 解不了的编码（ProRes 之类）
 * ffmpeg 会退回软件解码，帧变成系统内存格式，后面的 `*_vaapi` 滤镜直接报错；
 * 不强制输出格式则「能硬解就硬解、不能就自动软解」，失败面小很多。
 */
export function buildTranscodeArgs(opts: TranscodeArgsOptions): string[] {
  const height = transcodeHeight(opts.sourceHeight);
  const bitrate = transcodeBitrateKbps(height);
  const start = Math.max(0, Number(opts.startSec) || 0);
  const audioKbps = Math.max(64, Math.min(320, Number(opts.audioKbps) || 160));
  const scale = `scale=-2:${height},setsar=1`;

  const head: string[] = ["-hide_banner", "-loglevel", "error"];
  if (start > 0) head.push("-ss", start.toFixed(3));

  const accelIn: string[] = [];
  const video: string[] = [];
  if (opts.accel === "vaapi") {
    const device = opts.device || "/dev/dri/renderD128";
    // 解码用 -hwaccel vaapi + -hwaccel_device；滤镜里的 hwupload 用 -vaapi_device，两个都要给
    accelIn.push("-hwaccel", "vaapi", "-hwaccel_device", device, "-vaapi_device", device);
    video.push(
      "-vf",
      `${scale},format=nv12,hwupload`,
      "-c:v",
      "h264_vaapi",
      "-b:v",
      `${bitrate}k`,
      "-maxrate",
      `${Math.round(bitrate * 1.35)}k`,
      "-bufsize",
      `${Math.round(bitrate * 2)}k`,
    );
  } else if (opts.accel === "qsv") {
    const device = opts.device;
    accelIn.push("-hwaccel", "qsv");
    if (device) accelIn.push("-hwaccel_device", device);
    video.push(
      "-vf",
      `${scale},format=nv12`,
      "-c:v",
      "h264_qsv",
      "-b:v",
      `${bitrate}k`,
      "-maxrate",
      `${Math.round(bitrate * 1.35)}k`,
      "-bufsize",
      `${Math.round(bitrate * 2)}k`,
    );
  } else {
    video.push("-vf", `${scale},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22");
  }

  return [
    ...head,
    ...accelIn,
    "-i",
    path.normalize(opts.input),
    // 只带首条视频 + 首条音频：数据轨、章节、多音轨浏览器用不到
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    ...video,
    "-c:a",
    "aac",
    "-b:a",
    `${audioKbps}k`,
    // 5.1 / 7.1 下混成双声道：浏览器兼容性最好，体积也小
    "-ac",
    "2",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ];
}
