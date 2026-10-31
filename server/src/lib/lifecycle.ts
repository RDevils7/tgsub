/**
 * 极简生命周期钩子。
 *
 * 需要它的原因：Windows 上 taskkill / 关闭终端不会触发 SIGTERM 处理函数，
 * 进程被硬杀时 Telegram 连接不会优雅断开。旧连接残留 + 新进程立刻用同一个 authKey 连上去，
 * 服务器会回 AUTH_KEY_DUPLICATED 并作废这个 key —— 表现就是「重启一次就要重新扫码」。
 * 所以提供一个本机可调的优雅退出入口，重启时先调它，等端口释放再起新进程。
 */

type ShutdownHandler = (reason: string) => Promise<void>;

let handler: ShutdownHandler | null = null;

export function onShutdown(fn: ShutdownHandler): void {
  handler = fn;
}

export async function requestShutdown(reason: string): Promise<void> {
  if (!handler) {
    process.exit(0);
  }
  await handler(reason);
}
