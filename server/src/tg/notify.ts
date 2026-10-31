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
