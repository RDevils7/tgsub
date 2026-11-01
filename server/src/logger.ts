import pino from "pino";
import { env } from "./env";
import { createLogStream } from "./lib/logstore";

/**
 * 日志输出三路：
 * - stdout：容器日志（docker logs / compose logs 直接看）
 * - 文件：data/logs/app.log，重启后日志还在
 * - 内存缓冲：日志页面的查询走这里，不用反复读盘
 */
export const logger = pino(
  {
    level: env.logLevel,
    base: { app: "tgsub" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: createLogStream() },
  ]),
);
