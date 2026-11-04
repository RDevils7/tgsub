/**
 * 下载队列的「下一个跑谁」—— 纯逻辑，不碰 db / env / 定时器。
 *
 * 抽出来的原因有两个：
 *  1. 旧写法是 `(kind === "art") === hasArtWaiting()`，含义是「只要队列里还躺着
 *     一条封面图任务，正片就一律不启动」。这条规则太脆：封面图任务本身若跑不起来
 *     （老库里失效的 `.art-` 行、`run()` 因状态不符直接返回等），正片会被一直挡着。
 *     现在改成「先找封面，找不到能跑的就直接下正片」。
 *  2. 纯函数才能被 scripts/selftest.ts 直接覆盖，不用起服务、不用连 Telegram。
 *
 * 两条车道（互相独立）：
 *  - Telegram 车道：串行（gramjs 同连接跨 DC 会互相打断），封面图与正片分阶段
 *  - 外部车道：B站 / 小红书 / YouTube / m3u8，各自独立子进程，可并发
 */

export type JobKind = "art" | "video" | "other";

export interface JobRef {
  id: number;
  /** 第三方 / m3u8 任务：走外部车道 */
  external: boolean;
  /** art = 封面用的临时图，video = 正片，其余归 other */
  kind: JobKind;
  /** 用户手动点了「插队」：跳过封面 / 正片的分阶段限制 */
  priority: boolean;
}

export interface PickOptions {
  /** 排队顺序即优先顺序 */
  queue: JobRef[];
  active: JobRef[];
  tgSlots: number;
  platformSlots: number;
}

export type PickReason = "priority" | "platform" | "cover" | "video" | "tg";

export interface PickResult {
  job: JobRef;
  reason: PickReason;
}

/**
 * 选下一个任务；没有可跑的返回 null（调度器据此结束这一轮）。
 *
 * 规则顺序：
 *  1. 插队任务最优先，按它自己的类别占用对应车道
 *  2. 外部车道有空位就先跑外部任务（与 Telegram 完全并行）
 *  3. Telegram 车道：封面图下载期间不放正片，正片下载期间不插封面图；
 *     空闲时优先封面图，但「没有封面图可跑」时必须能直接下正片 —— 不许干等
 */
export function pickNext(opts: PickOptions): PickResult | null {
  const { queue, active, tgSlots, platformSlots } = opts;
  const activeIds = new Set(active.map((job) => job.id));
  const idle = (job: JobRef): boolean => !activeIds.has(job.id);

  const activeExternal = active.filter((job) => job.external).length;
  const activeTg = active.length - activeExternal;
  const freePlatform = platformSlots - activeExternal;
  const freeTg = tgSlots - activeTg;

  // 1) 插队：按类别占车道，避开分阶段限制
  const prio = queue.find(
    (job) => idle(job) && job.priority && (job.external ? freePlatform > 0 : freeTg > 0),
  );
  if (prio) return { job: prio, reason: "priority" };

  // 2) 外部车道：独立并发
  if (freePlatform > 0) {
    const external = queue.find((job) => idle(job) && job.external);
    if (external) return { job: external, reason: "platform" };
  }

  // 3) Telegram 车道
  if (freeTg <= 0) return null;
  const tgActive = active.filter((job) => !job.external);
  const phase: "art" | "video" | "idle" = tgActive.some((job) => job.kind === "art")
    ? "art"
    : tgActive.some((job) => job.kind === "video")
      ? "video"
      : "idle";

  // 封面图正在下：这一轮不上正片，否则同一条连接会把它打断成 0 字节
  if (phase === "art") return null;

  const waiting = queue.filter((job) => idle(job) && !job.external);

  // 正片正在下：只接受非封面图
  if (phase === "video") {
    const next = waiting.find((job) => job.kind !== "art");
    return next ? { job: next, reason: "video" } : null;
  }

  // 空闲：先封面，再正片。注意这里不能写成「有封面就只准封面」——
  // 找不到可跑的封面图时必须能落到正片上，否则就是那个卡死的 bug。
  const cover = waiting.find((job) => job.kind === "art");
  if (cover) return { job: cover, reason: "cover" };
  const any = waiting[0];
  return any ? { job: any, reason: "tg" } : null;
}
