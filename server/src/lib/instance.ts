import fs from "node:fs";
import os from "node:os";
import { logger } from "../logger";

/**
 * 单实例锁。
 *
 * Telegram 的 authKey 不允许两个连接同时使用：一旦同一个 key 被两个进程并发连接，
 * 服务器会判定异常并作废这个 key——表现就是「重启后又要重新扫码」。
 * 最常见的触发方式是旧进程没退干净（Ctrl+C 后残留、npm 派生的子进程、直接关终端窗口），
 * 新进程带着同一个 session 又连了上去。
 *
 * 用「心跳 + pid」双条件判断存活：
 * - 心跳每 5 秒刷新一次，超过 20 秒没更新即视为上一个进程已死（崩溃 / 被强杀 / 容器被删）；
 * - 不用 pid 作为唯一依据，因为 Windows 的 pid 会被快速复用，误判会导致服务起不来（踩过）。
 */

interface LockPayload {
  runId: string;
  pid: number;
  host: string;
  startedAt: number;
  heartbeat: number;
}

const HEARTBEAT_MS = 5_000;
const STALE_MS = 20_000;

export function acquireInstanceLock(lockFile: string): void {
  const runId = `${process.pid}-${Date.now()}`;
  const host = os.hostname();

  try {
    const existing = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockPayload;
    const age = Date.now() - Number(existing.heartbeat || 0);
    if (existing.runId !== runId && age < STALE_MS) {
      logger.error(
        {
          holder: { pid: existing.pid, host: existing.host, heartbeatAgoMs: age },
        },
        "另一个 tgsub 实例正在运行，本次启动已中止：两个实例同时使用同一个 authKey 会让 Telegram 作废登录，需要重新扫码。若确认没有其他实例，等 20 秒后再启动",
      );
      process.exit(1);
    }
  } catch {
    /* 锁文件不存在或内容损坏：继续启动并覆盖 */
  }

  const payload: LockPayload = { runId, pid: process.pid, host, startedAt: Date.now(), heartbeat: Date.now() };

  const write = (): void => {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(payload), "utf8");
    } catch (err) {
      logger.warn({ err }, "无法写入实例锁文件，跳过单实例检查");
    }
  };
  write();

  const timer = setInterval(() => {
    payload.heartbeat = Date.now();
    write();
  }, HEARTBEAT_MS);
  timer.unref();

  process.once("exit", () => {
    clearInterval(timer);
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockPayload;
      if (current.runId === runId) fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  });
}
