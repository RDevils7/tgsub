/**
 * 受控并发的 map：一次最多 `parallel` 个任务同时在跑，结果顺序与输入一致。
 *
 * 用来替掉媒体库里那些 `for (...) await fn()` 的串行循环：
 * 一季几十集、一层几十部剧，每集都要 stat + 读 NFO + 探测视频，
 * 串行等于把磁盘往返一个个排队；全量 Promise.all 又会在 NAS 上瞬间起几十个
 * ffmpeg 把机器打爆。固定若干条「工人」是两头都合适的做法。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  parallel: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (!items.length) return out;
  const lanes = Math.max(1, Math.min(Math.floor(parallel) || 1, items.length));
  let cursor = 0;
  const workers = Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}
