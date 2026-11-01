import { logger } from "../logger";

/**
 * sharp 的可选加载器。
 *
 * sharp 带原生二进制，裁剪过的容器镜像里可能装不上；调用方拿到 null 时要能退化
 * （复制原图 / 用 ffmpeg 缩放），所以这里只做「尽量加载 + 缓存」这一件事。
 */

export interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: string;
  position?: string;
  background?: string;
}

export interface ExtractOptions {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number }>;
  resize(opts: ResizeOptions): SharpImage;
  extract(opts: ExtractOptions): SharpImage;
  jpeg(opts: { quality: number }): { toFile(target: string): Promise<unknown> };
}

export type SharpFactory = (input: string | Buffer) => SharpImage;

let cache: SharpFactory | null | undefined;

export async function loadSharp(): Promise<SharpFactory | null> {
  if (cache !== undefined) return cache;
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpFactory } & SharpFactory;
    cache = (mod.default ?? mod) as SharpFactory;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "sharp 不可用，图片将退化为原样处理");
    cache = null;
  }
  return cache;
}
