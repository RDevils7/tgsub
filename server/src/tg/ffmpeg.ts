import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../db";
import { logger } from "../logger";

/**
 * FFmpeg / ffprobe 定位与调用。
 *
 * 解析顺序：
 *   1. 界面设置里的 ffmpeg_path（显式指定优先，找不到 ffprobe 就按同目录猜）
 *   2. 环境变量 FFMPEG_PATH / FFPROBE_PATH
 *   3. npm 平台包 @ffmpeg-installer（随项目安装，开箱可用）
 *   4. 系统 PATH 里的 ffmpeg
 *
 * ffprobe 是**可选**的：镜像里不再内置 @ffprobe-installer 二进制
 * （它单独就占 75MB，是镜像体积的大头）。当 ffprobe 不可用时，
 * probeVideo 会改用 `ffmpeg -i` 的 stderr 输出解析出同样的信息。
 *
 * 视频截图失败不会影响下载主流程：拿不到二进制时接口会返回明确的原因，
 * 界面提示用户安装或填路径。
 */

export interface FfmpegInfo {
  available: boolean;
  ffmpeg: string | null;
  ffprobe: string | null;
  source: "settings" | "env" | "bundled" | "path" | null;
  version: string | null;
  error: string | null;
}

let cached: FfmpegInfo | null = null;
let cachedKey = "";

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function siblingProbe(bin: string): string | null {
  const dir = path.dirname(bin);
  const base = path.basename(bin).toLowerCase();
  const ext = path.extname(bin);
  const candidate = base.startsWith("ffmpeg")
    ? path.join(dir, base.replace(/^ffmpeg/, "ffprobe") + (ext || ""))
    : "";
  return candidate && isFile(candidate) ? candidate : null;
}

/** 同步解析一次路径候选，实际可用性由 run() 验证 */
function resolveCandidates(): Array<{ ffmpeg: string; ffprobe: string | null; source: FfmpegInfo["source"] }> {
  const out: Array<{ ffmpeg: string; ffprobe: string | null; source: FfmpegInfo["source"] }> = [];

  let setting = "";
  try {
    setting = String(getSettings().ffmpeg_path || "").trim();
  } catch {
    setting = "";
  }
  if (setting && isFile(setting)) {
    out.push({ ffmpeg: setting, ffprobe: siblingProbe(setting), source: "settings" });
  }
  const envPath = String(process.env.FFMPEG_PATH || "").trim();
  if (envPath && isFile(envPath)) {
    out.push({
      ffmpeg: envPath,
      ffprobe: String(process.env.FFPROBE_PATH || "").trim() || siblingProbe(envPath),
      source: "env",
    });
  }
  for (const mod of ["@ffmpeg-installer/ffmpeg"]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const resolved = require(mod) as { path?: string };
      if (resolved?.path && isFile(resolved.path)) {
        // ffprobe 是可选的：镜像里不再内置 @ffprobe-installer 二进制。
        // 用户若自行装了同名包，或与 ffmpeg 同目录存在，就用它的；
        // 否则留空，由 probeVideo 回退到 `ffmpeg -i` 解析。
        let probe: string | null = null;
        try {
          // 用变量传模块名，避免打包期把这个可选依赖变成硬依赖
          const optMod = "@ffprobe-installer/ffprobe";
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const p = require(optMod) as { path?: string };
          if (p?.path && isFile(p.path)) probe = p.path;
        } catch {
          probe = siblingProbe(resolved.path);
        }
        out.push({ ffmpeg: resolved.path, ffprobe: probe, source: "bundled" });
      }
    } catch {
      /* 没装就是没装，继续下一种 */
    }
  }
  out.push({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", source: "path" });
  return out;
}

function run(bin: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || "").trim().split("\n").slice(-3).join(" ");
        reject(new Error(detail || err.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/**
 * 执行命令并同时收回 stdout / stderr，不因退出码非 0 而失败。
 *
 * `ffmpeg -i file` 在没有输出目标时**必定以退出码 1 结束**，
 * 但它要的信息全在 stderr 里，所以这里不能按普通成功/失败处理。
 */
function runCapture(
  bin: string,
  args: string[],
  timeout = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 探测 ffmpeg 是否可用（结果缓存；设置变更时 key 变化会自动重探） */
export async function ffmpegInfo(force = false): Promise<FfmpegInfo> {
  let setting = "";
  try {
    setting = String(getSettings().ffmpeg_path || "").trim();
  } catch {
    setting = "";
  }
  const key = `${setting}|${process.env.FFMPEG_PATH || ""}`;
  if (cached && cachedKey === key && !force && cached.available) return cached;

  const candidates = resolveCandidates();
  let lastError: string | null = null;
  for (const cand of candidates) {
    try {
      const banner = await run(cand.ffmpeg, ["-version"], 8000);
      const version = /ffmpeg version (\S+)/i.exec(banner)?.[1] ?? null;
      let ffprobe = cand.ffprobe;
      if (ffprobe) {
        try {
          await run(ffprobe, ["-version"], 8000);
        } catch {
          ffprobe = null;
        }
      }
      cached = { available: true, ffmpeg: cand.ffmpeg, ffprobe, source: cand.source, version, error: null };
      cachedKey = key;
      return cached;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  cached = {
    available: false,
    ffmpeg: null,
    ffprobe: null,
    source: null,
    version: null,
    error: lastError || "未找到 ffmpeg",
  };
  cachedKey = key;
  return cached;
}

async function requireFfmpeg(): Promise<FfmpegInfo> {
  const info = await ffmpegInfo();
  if (!info.available || !info.ffmpeg) {
    throw new Error(
      "未找到 ffmpeg，无法截图。请在设置里填写 ffmpeg 可执行文件路径，或安装后重试。",
    );
  }
  return info;
}

export interface VideoProbe {
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  fps: number | null;
  container: string | null;
  sizeBytes: number | null;
}

/**
 * 解析 `ffmpeg -i` 打印到 stderr 的媒体信息。
 *
 * 样例输出：
 *   Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
 *     Duration: 00:01:23.45, start: 0.000000, bitrate: 1065 kb/s
 *     Stream #0:0[0x1](und): Video: h264 (High), yuv420p(tv, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1000 kb/s, 25 fps, 25 tbr, 12800 tbn
 *     Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s
 *
 * 镜像里不再内置 ffprobe 二进制（单独就占 75MB），没有它时走这条路，
 * 解析出来的字段与 ffprobe 保持一致。
 *
 * 导出供自检直接验证解析逻辑（不依赖真实二进制）。
 */
export function parseFfmpegProbe(stderr: string): VideoProbe | null {
  if (!stderr.trim()) return null;

  const container = /Input #\d+,\s*([A-Za-z0-9_,]+)\s*,/.exec(stderr)?.[1] ?? null;

  // Duration: 00:01:23.45
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  let duration: number | null = null;
  if (dur) {
    duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  }

  // 总码率：Duration 行末尾的 bitrate
  // ffmpeg 报的是 kb/s，ffprobe 报的是 bit/s —— 这里统一成 bit/s，
  // 与 ffprobe 路径保持同一量纲，避免界面上一会儿显示 396 一会儿显示 398201。
  const bitrate = /Duration:[^\n]*?bitrate:\s*(\d+)\s*kb\/s/.exec(stderr)?.[1];

  // 视频流：编码 / 分辨率 / 帧率
  const vLine = /Stream #\d+:\d+[^\n]*Video:[^\n]*/.exec(stderr)?.[0] ?? "";
  const videoCodec = /Video:\s*([A-Za-z0-9_]+)/.exec(vLine)?.[1] ?? null;
  const res = /,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(vLine);
  const width = res ? Number(res[1]) : null;
  const height = res ? Number(res[2]) : null;
  const fpsRaw = /([\d.]+)\s*fps/.exec(vLine)?.[1];

  // 音频流：编码
  const aLine = /Stream #\d+:\d+[^\n]*Audio:[^\n]*/.exec(stderr)?.[0] ?? "";
  const audioCodec = /Audio:\s*([A-Za-z0-9_]+)/.exec(aLine)?.[1] ?? null;

  if (!duration && !width && !videoCodec && !audioCodec) return null;

  return {
    duration,
    width,
    height,
    videoCodec,
    audioCodec,
    bitrate: bitrate ? Number(bitrate) * 1000 : null,
    fps: fpsRaw ? Math.round(Number(fpsRaw) * 100) / 100 : null,
    container,
    sizeBytes: null,
  };
}

/**
 * 读取时长/分辨率/编码，失败返回 null（不影响编辑）。
 *
 * 优先走 ffprobe（用户自备或在设置里指定了路径），
 * 没有 ffprobe 时回退到 `ffmpeg -i` 解析，两条路字段一致。
 */
export async function probeVideo(file: string): Promise<VideoProbe | null> {
  const info = await ffmpegInfo();

  if (info.ffprobe) {
    try {
      const raw = await run(
        info.ffprobe,
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
        20_000,
      );
      const data = JSON.parse(raw) as {
        format?: { duration?: string; bit_rate?: string; size?: string; format_name?: string };
        streams?: Array<{
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          avg_frame_rate?: string;
          r_frame_rate?: string;
        }>;
      };
      const video = (data.streams ?? []).find((s) => s.codec_type === "video");
      const audio = (data.streams ?? []).find((s) => s.codec_type === "audio");
      const fpsRaw = video?.avg_frame_rate || video?.r_frame_rate || "";
      const [num, den] = fpsRaw.split("/").map(Number);
      const fps = num && den ? Math.round((num / den) * 100) / 100 : null;
      return {
        duration: data.format?.duration ? Number(data.format.duration) : null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        videoCodec: video?.codec_name ?? null,
        audioCodec: audio?.codec_name ?? null,
        bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
        fps,
        container: data.format?.format_name ?? null,
        sizeBytes: data.format?.size ? Number(data.format.size) : null,
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message, file }, "ffprobe 读取失败，改用 ffmpeg 解析");
      // 不直接返回 null，继续尝试 ffmpeg 回退
    }
  }

  if (!info.ffmpeg) return null;
  try {
    const { stderr } = await runCapture(info.ffmpeg, ["-hide_banner", "-i", file], 20_000);
    const parsed = parseFfmpegProbe(stderr);
    if (!parsed) return null;
    const size = await fs.promises.stat(file).then((s) => s.size).catch(() => null);
    return { ...parsed, sizeBytes: size };
  } catch (err) {
    logger.warn({ err: (err as Error).message, file }, "ffmpeg 媒体信息解析失败");
    return null;
  }
}

export type FitMode = "cover" | "contain" | "stretch" | "blur";

/**
 * 默认模糊填充：画面完整显示，空出来的边用同一帧的放大模糊版填满。
 * 以前默认 contain（留黑边），黑边在 Emby 里很扎眼；cover 又会把画面裁掉一截。
 */
export const DEFAULT_FIT: FitMode = "blur";

/** 归一化裁剪框（0~1，相对整帧左上角），来自界面上的手动框选 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** 把界面传来的裁剪框收敛到合法范围（越界、反向、NaN 都兜住） */
export function normalizeCrop(input: unknown): CropRect | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const x = clamp01(Number(raw.x));
  const y = clamp01(Number(raw.y));
  let width = clamp01(Number(raw.width));
  let height = clamp01(Number(raw.height));
  if (width <= 0.001 || height <= 0.001) return null;
  width = Math.min(width, 1 - x);
  height = Math.min(height, 1 - y);
  if (width <= 0.001 || height <= 0.001) return null;
  return { x, y, width, height };
}

function scaleFilter(width: number, height: number, fit: FitMode, crop?: CropRect | null): string {
  if (crop) {
    // 框选比例本来就等于目标比例，裁完直接缩放到规格尺寸即可
    const w = crop.width.toFixed(6);
    const h = crop.height.toFixed(6);
    const x = crop.x.toFixed(6);
    const y = crop.y.toFixed(6);
    return `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=${width}:${height},setsar=1`;
  }
  if (fit === "stretch") return `scale=${width}:${height}`;
  if (fit === "contain") {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }
  if (fit === "blur") {
    // 底：放大铺满 + 模糊 + 压暗；面：完整画面；叠在一起就是「模糊边的完整画面」
    const radius = Math.min(40, Math.max(6, Math.round(Math.min(width, height) / 28)));
    return [
      "split=2[bg][fg]",
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}` +
        `,boxblur=luma_radius=${radius}:luma_power=2,eq=brightness=-0.12:saturation=0.9[bgb]`,
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs]`,
      "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1",
    ].join(";");
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

/** 取一帧存成 jpg；at 单位秒，crop 为归一化框选范围 */
export async function captureFrame(
  file: string,
  opts: {
    at: number;
    out: string;
    width: number;
    height: number;
    fit?: FitMode;
    crop?: CropRect | null;
  },
): Promise<void> {
  const info = await requireFfmpeg();
  const at = Math.max(0, Number(opts.at) || 0);
  const fit = opts.fit ?? DEFAULT_FIT;
  await fs.promises.mkdir(path.dirname(opts.out), { recursive: true });

  const attempt = async (mode: FitMode) =>
    run(
      info.ffmpeg as string,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        at.toFixed(3),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        scaleFilter(opts.width, opts.height, mode, opts.crop),
        "-q:v",
        "2",
        opts.out,
      ],
      60_000,
    );

  try {
    await attempt(fit);
  } catch (err) {
    // 模糊填充依赖 boxblur / eq / overlay 这套滤镜链，老一点的 ffmpeg 精简版可能没编进去。
    // 这种情况退成留黑边（至少图能出来），不要因为封面好看与否让截图整件事失败。
    if (fit !== "blur") throw err;
    logger.warn({ err: (err as Error).message }, "模糊填充截图失败，退回留黑边");
    await attempt("contain");
  }

  const st = await fs.promises.stat(opts.out).catch(() => null);
  if (!st || st.size === 0) throw new Error("截图失败：输出文件为空（该时间点可能没有画面）");
}

/**
 * 取一帧原始画面（保留原比例，只限制最大宽度），用于界面上的框选预览。
 * 交给 sharp 再做裁剪/缩放，比在 ffmpeg 里一次算完更灵活。
 */
export async function captureStill(file: string, at: number, out: string, maxWidth = 1280): Promise<void> {
  const info = await requireFfmpeg();
  const seconds = Math.max(0, Number(at) || 0);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await run(
    info.ffmpeg as string,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      seconds.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${maxWidth},iw)':-2`,
      "-q:v",
      "3",
      out,
    ],
    60_000,
  );
  const st = await fs.promises.stat(out).catch(() => null);
  if (!st || st.size === 0) throw new Error("截图失败：该时间点没有画面");
}

/** 均匀抽 count 张候选帧，返回生成的绝对路径与对应时间点 */
export async function captureCandidates(
  file: string,
  duration: number | null,
  count: number,
  outDir: string,
): Promise<Array<{ file: string; at: number }>> {
  const info = await requireFfmpeg();
  const total = duration && duration > 1 ? duration : 60;
  await fs.promises.rm(outDir, { recursive: true, force: true });
  await fs.promises.mkdir(outDir, { recursive: true });
  const n = Math.max(1, Math.min(16, count));
  const out: Array<{ file: string; at: number }> = [];
  // 跳过片头片尾：取 5% ~ 90% 的均匀间隔
  const start = total * 0.05;
  const end = total * 0.9;
  const step = n > 1 ? (end - start) / (n - 1) : 0;
  for (let i = 0; i < n; i += 1) {
    const at = Math.max(0, start + step * i);
    const target = path.join(outDir, `f-${i + 1}.jpg`);
    try {
      await run(
        info.ffmpeg as string,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          at.toFixed(3),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          // 候选帧保留原始比例（缩到 320 宽），页面上按原比例显示，方便判断哪一帧能当封面
          "scale='min(320,iw)':-2",
          "-q:v",
          "4",
          target,
        ],
        45_000,
      );
      out.push({ file: target, at: Math.round(at * 10) / 10 });
    } catch (err) {
      logger.warn({ err: (err as Error).message, at }, "候选帧抽取失败，跳过");
    }
  }
  return out;
}
