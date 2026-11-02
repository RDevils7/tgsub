import { getSetting } from "../db";
import { logger } from "../logger";

/**
 * 主动推送通道。
 *
 * 单独放一个模块是为了避免循环依赖：
 * 机器人需要调用扫描器（执行 /scan），扫描器又想在有新下载时推消息，
 * 两边互相 import 会把 commonjs 的模块初始化顺序搞乱。
 * 这里只保留一个「发送函数」的注册位，谁启用了机器人谁把函数塞进来。
 */
type Sender = (text: string) => Promise<void>;

let sender: Sender | null = null;

export function setNotifySender(fn: Sender | null): void {
  sender = fn;
}

/** 主动推送是否可用（机器人已连接 且 用户没关掉推送） */
export function canNotify(): boolean {
  return Boolean(sender) && getSetting("bot_notify") !== "false";
}

export async function notify(text: string): Promise<void> {
  if (!sender) return;
  if (getSetting("bot_notify") === "false") return;
  try {
    await sender(text);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "机器人推送失败");
  }
}

/* ------------------------------------------------------------------ */
/* 卡片推送（下载完成通知用）                                          */
/* ------------------------------------------------------------------ */

/**
 * 富卡片：发给机器人的「下载完成」通知用。
 *
 * - `text` 是上方文字块（标题 / 频道 / 文件预览等，支持 HTML）
 * - `link` 是 t.me 消息链接：开启 linkPreview 后 Telegram 会渲染出
 *   频道帖子的预览卡片（仿截图那种「频道名 + 缩略图 + 摘要」卡片）
 * - `photoPath` 暂未使用：带了链接预览就不会再显示附图，二者互斥，
 *   优先用链接预览还原截图里的卡片样式
 */
export interface NotifyCard {
  text: string;
  link?: string;
}

type CardSender = (card: NotifyCard) => Promise<void>;

let cardSender: CardSender | null = null;

export function setNotifyCard(fn: CardSender | null): void {
  cardSender = fn;
}

/** 卡片推送是否可用（机器人已连接 且 用户没关掉推送） */
export function canNotifyCard(): boolean {
  return Boolean(cardSender) && getSetting("bot_notify") !== "false";
}

export async function notifyCard(card: NotifyCard): Promise<void> {
  if (!cardSender) return;
  if (getSetting("bot_notify") === "false") return;
  try {
    await cardSender(card);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "机器人卡片推送失败");
  }
}
