/**
 * yt-dlp 自动检查更新的排期逻辑。
 *
 * 单独成文件是**故意不 import db** —— 自检脚本要直接跑这些判断，
 * 而 updater.ts 一被 import 就会连数据库。
 */

/** 默认检查间隔（小时）：15 天 */
export const DEFAULT_CHECK_HOURS = 15 * 24;

/** 首次重试间隔，之后每次翻倍，最长不超过 MAX_RETRY_DELAY_MS */
export const RETRY_DELAY_MS = 30 * 60_000;
export const MAX_RETRY_DELAY_MS = 24 * 3600_000;

/**
 * 自动检查失败后，最多再插队重试几次。
 *
 * 以前只要失败过，retryAt 就一直在（只有成功才清），于是自动检查永远走
 * 「30 分钟 → 1 小时 → 2 小时 → … → 24 小时封顶」这条退避链，
 * 用户设的 15 天被彻底架空，日志看起来就是「每小时 / 每天还在查」。
 * 现在短重试只允许两次，之后乖乖等满一个周期；被限流时一次都不重试。
 */
export const MAX_AUTO_RETRIES = 2;

export interface CheckScheduleInput {
  /** 是否开启了定时检查 */
  autoUpdate: boolean;
  /** 检查周期（小时） */
  checkHours: number;
  /** 上次成功检查的时间戳，0 / undefined 表示从没查过 */
  checkAt?: number | null;
  /** 上次失败后安排的重试时间戳，0 / undefined 表示当前没有待重试的失败 */
  retryAt?: number | null;
  now: number;
}

/**
 * 该不该现在检查一次（旧版判定，保留给自检做回归）。
 *
 * 生产排期已改走 `nextCheckAt()` + 绝对时间 `ytdlp_next_at`，不再每小时轮询。
 * 这里仍要守住一条底线：到点判一次，没到点一次都不判。
 *
 * 曾经有过一个 `if (retryAt) return true` 的分支，本意是「失败后重试不必等满整个周期」，
 * 本意是「失败后重试不必等满整个周期」，但 retryAt 只要失败过就一直存在
 * （检查成功才清空），结果 24 小时 / 15 天的设置彻底失效 —— 每小时醒一次就查一次，
 * 把 GitHub 匿名 API 的配额（60 次/小时/IP）打满，403 之后继续每小时撞墙。
 */
export function shouldRunCheck(input: CheckScheduleInput): boolean {
  if (!input.autoUpdate) return false;
  // 上次失败了：重试时间没到就别动；到了就重试一次
  const retryAt = input.retryAt || 0;
  if (retryAt) return input.now >= retryAt;
  const checkAt = input.checkAt || 0;
  if (!checkAt) return true;
  const hours = Math.max(1, input.checkHours || DEFAULT_CHECK_HOURS);
  return input.now - checkAt >= hours * 3600_000;
}

/** 失败后第 n 次重试的间隔：30 分钟起，逐次翻倍，最长 24 小时 */
export function retryDelayMs(failCount: number): number {
  const n = Math.max(1, Math.floor(failCount) || 1);
  return Math.min(RETRY_DELAY_MS * 2 ** (n - 1), MAX_RETRY_DELAY_MS);
}

/**
 * 把「天」换算成内部存的「小时」。
 *
 * 界面上按天填（yt-dlp 的发版节奏是周/月级别，按天更好输），
 * 存储仍是小时，老配置能直接读出来。
 */
export function daysToHours(days: number): number {
  const d = Math.max(1, Math.floor(Number(days) || 1));
  return d * 24;
}

/** 周期毫秒数：界面按天填，内部存小时 */
export function checkPeriodMs(checkHours: number): number {
  return Math.max(1, checkHours || DEFAULT_CHECK_HOURS) * 3600_000;
}

/**
 * 一次检查结束后，距离「下一次自动检查」还有多久。
 *
 * 硬规则：**任何情况下都不超过一个用户设定周期**。成功就是整周期；
 * 失败最多两次短重试（30 分钟、1 小时），第三次起等满周期；
 * GitHub 限流（403 / 频率上限）直接等满周期 —— 退避重试只会一直撞在限流窗口里。
 */
export function nextCheckDelayMs(opts: {
  ok: boolean;
  /** 包括本次在内的连续失败次数 */
  failCount: number;
  checkHours: number;
  /** 本次失败是不是限流 / 403 */
  rateLimited?: boolean;
}): number {
  const period = checkPeriodMs(opts.checkHours);
  if (opts.ok) return period;
  if (opts.rateLimited) return period;
  const n = Math.max(1, Math.floor(opts.failCount) || 1);
  if (n > MAX_AUTO_RETRIES) return period;
  return Math.min(retryDelayMs(n), period);
}

export interface NextCheckAtInput {
  autoUpdate: boolean;
  checkHours: number;
  /** 上次检查时间（无论成败） */
  checkAt?: number | null;
  /** 上次检查排好的下次时间；新逻辑写这个 */
  nextAt?: number | null;
  /** 兼容 1.3.1 之前遗留的「失败重试时间」 */
  retryAt?: number | null;
  now: number;
}

/**
 * 算出下次自动检查的绝对时间戳；返回 null 表示自动检查已关闭。
 *
 * 定时器直接 setTimeout 到这个时间，不再每小时醒一次轮询 ——
 * 「每 15 天查一次」就真的是 15 天里一次网络请求、一次定时器唤醒都没有。
 * 显式排期仍受周期硬上限约束，防止旧数据 / 手工改库把周期顶穿。
 */
export function nextCheckAt(input: NextCheckAtInput): number | null {
  if (!input.autoUpdate) return null;
  const period = checkPeriodMs(input.checkHours);
  const checkAt = input.checkAt || 0;
  // 本周期的绝对上限：上次检查时间 + 一个周期
  const ceiling = (checkAt || input.now) + period;
  const explicit = input.nextAt || input.retryAt || 0;
  if (explicit > 0) return Math.min(explicit, ceiling);
  if (!checkAt) return input.now;
  return Math.min(checkAt + period, ceiling);
}
