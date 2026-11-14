/**
 * HTTP Range 解析。
 *
 * 开放式 Range（`bytes=start-`）单次最多回 RANGE_CHUNK 字节，而不是把整段文件
 * 一次性吐出去。原因：Telegram 下来的 MP4 大量是「mdat 在前、moov 在文件尾」的
 * 非 faststart 文件，浏览器必须先取到尾部 moov 才能解出第一帧。若一次 206 就覆盖
 * 整个文件，部分浏览器 / 反代会顺着把整个文件读完才拿到索引，表现就是「海报在、
 * 画面不出、一直缓冲中」；分段响应会逼浏览器显式请求下一段 Range，尾部 moov 立刻
 * 可取，连接也能及时释放给海报墙的其它请求。
 *
 * 不带 Range 的请求（「下载」按钮）仍然返回完整文件，不受这里影响。
 */
export const RANGE_CHUNK = 4 * 1024 * 1024;

export interface ByteRange {
  start: number;
  end: number;
}

/** 返回 null 表示这个头用不了（按整段发 / 416） */
export function parseRange(header: string, size: number, chunk = RANGE_CHUNK): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    // bytes=-500 表示最后 500 字节，浏览器取尾部 moov 常用这种写法
    const tail = Number(rawEnd);
    if (!Number.isFinite(tail) || tail <= 0) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(rawStart);
    // 客户端明确给了 end 就照办；只给了 start 就截断到一段，别把整份文件挂在这一条连接上
    end = rawEnd ? Number(rawEnd) : Math.min(size - 1, start + Math.max(1, chunk) - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start < 0) return { start: size, end: size - 1 };
  return { start, end: Math.min(end, size - 1) };
}
