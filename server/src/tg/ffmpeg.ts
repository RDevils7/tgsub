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
 *   3. npm 平台包 @ffmpeg-installer / @ffprobe-installer（随项目安装，开箱可用）
 *   4. 系统 PATH 里的 ffmpeg
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
        let probe: string | null = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const p = require("@ffprobe-installer/ffprobe") as { path?: string };
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

/** ffprobe 读取时长/分辨率/编码，失败返回 null（不影响编辑） */
export async function probeVideo(file: string): Promise<VideoProbe | null> {
  const info = await ffmpegInfo();
  if (!info.ffprobe) return null;
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
        r_frame_rate?: string;
        avg_frame_rate?: string;
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
    logger.warn({ err: (err as Error).message, file }, "ffprobe 读取失败");
    return null;
  }
}

export type FitMode = "cover" | "contain" | "stretch";

function scaleFilter(width: number, height: number, fit: FitMode): string {
  if (fit === "stretch") return `scale=${width}:${height}`;
  if (fit === "contain") {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

/** 取一帧存成 jpg；at 单位秒 */
export async function captureFrame(
  file: string,
  opts: { at: number; out: string; width: number; height: number; fit?: FitMode },
): Promise<void> {
  const info = await requireFfmpeg();
  const at = Math.max(0, Number(opts.at) || 0);
  await fs.promises.mkdir(path.dirname(opts.out), { recursive: true });
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
      scaleFilter(opts.width, opts.height, opts.fit ?? "cover"),
      "-q:v",
      "2",
      opts.out,
    ],
    60_000,
  );
  const st = await fs.promises.stat(opts.out).catch(() => null);
  if (!st || st.size === 0) throw new Error("截图失败：输出文件为空（该时间点可能没有画面）");
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
          scaleFilter(320, 180, "cover"),
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
