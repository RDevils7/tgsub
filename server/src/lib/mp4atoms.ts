/**
 * MP4 顶层 atom（box）布局判定。
 *
 * Telegram 下来的 MP4 大量是「ftyp + mdat(几百 MB) + moov(文件尾)」的
 * **非 faststart** 结构。浏览器 `<video>` 必须先拿到 moov 才能解出第一帧，
 * 而非 faststart 需要额外一条跳到文件尾的 Range 请求。某些链路上这条请求
 * 会一直挂着（NAS 端口映射 / 代理缓冲大响应 / 浏览器对 206 的处理差异），
 * 表现就是「海报在、画面不出、永远缓冲中，连 error 事件都不触发」。
 *
 * 这类文件交给 ffmpeg 换封装成 fragmented MP4（empty_moov）：浏览器从头
 * 就能边收边解，完全不需要 Range、也不需要尾部 seek。
 * 本模块只负责判断「要不要走那条兼容通道」，不产生任何写操作。
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 只读文件头这么多字节。非 faststart 在头 40 字节内就能判定（ftyp/free/mdat），
 * faststart 的 moov 通常紧跟 ftyp 且远小于 1MB。
 */
export const ATOM_SCAN_BYTES = 1024 * 1024;

/** 能被 ffmpeg `-c copy` 换封装救回来的 MP4 系容器 */
export const REMUXABLE_EXT = new Set([".mp4", ".m4v", ".mov"]);

export interface BoxInfo {
  type: string;
  size: number;
  offset: number;
}

/** 解析 Buffer 里的顶层 box 序列；遇到截断 / 非法 size 就停下 */
export function topLevelBoxes(head: Buffer): BoxInfo[] {
  const boxes: BoxInfo[] = [];
  let off = 0;
  while (off + 8 <= head.length) {
    const size32 = head.readUInt32BE(off);
    const type = head.toString("latin1", off + 4, off + 8);
    let size = size32;
    let header = 8;
    if (size32 === 1) {
      if (off + 16 > head.length) break;
      const big = head.readBigUInt64BE(off + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      header = 16;
    } else if (size32 === 0) {
      // 「延伸到文件末尾」：后面不可能再有顶层 box，停止解析
      break;
    }
    if (size < header) break;
    boxes.push({ type, size, offset: off });
    off += size;
  }
  return boxes;
}

/**
 * 判断 moov 是否排在 mdat 前面。
 *
 * - `true`：moov 在前（faststart），Range 直出安全
 * - `false`：mdat 在前、moov 在尾部（非 faststart），建议走换封装
 * - `null`：头部信息不足 / 不是标准 MP4，不强行改判，交给 Range 直出与前端兜底
 */
export function faststartFromHead(head: Buffer): boolean | null {
  const boxes = topLevelBoxes(head);
  if (boxes.length === 0) return null;
  // 第一个 box 必须是 ftyp（或少数文件用的 free/styp），否则不是我们敢改判的 MP4
  if (!["ftyp", "styp", "free", "skip", "wide"].includes(boxes[0].type)) return null;
  for (const box of boxes) {
    if (box.type === "moov") return true;
    if (box.type === "mdat") return false;
  }
  // 扫到的都是 ftyp/free 之类、还没见到 moov 或 mdat：信息不足
  return null;
}

/** 缓存键带上 size + mtime：文件被替换或重新下载后自动失效 */
const cache = new Map<string, { key: string; value: boolean }>();
const CACHE_MAX = 500;

/**
 * 返回 true 表示「这是非 faststart 的 MP4 系文件，播放应改走换封装」。
 * 只读文件头，任何异常都保守返回 false（保持原来的 Range 直出行为）。
 */
export async function needsRemuxForFaststart(file: string): Promise<boolean> {
  if (!REMUXABLE_EXT.has(path.extname(file).toLowerCase())) return false;
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const key = `${st.size}:${Math.round(st.mtimeMs)}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.value;

  let value = false;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(ATOM_SCAN_BYTES);
    const { bytesRead } = await handle.read(buf, 0, ATOM_SCAN_BYTES, 0);
    value = faststartFromHead(buf.subarray(0, bytesRead)) === false;
  } catch {
    value = false;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  if (cache.size >= CACHE_MAX) {
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size < CACHE_MAX / 2) break;
    }
  }
  cache.set(file, { key, value });
  return value;
}
