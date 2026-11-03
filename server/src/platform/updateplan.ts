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
 * 该不该现在检查一次。
 *
 * 这里**只看「有没有到点」**。曾经有过一个 `if (retryAt) return true` 的分支，
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
