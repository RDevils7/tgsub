import { Router } from "express";
import { cacheStats, clearCache, humanBytes, trimCache } from "../cache";
import { asyncHandler } from "../lib/http";
import { logger } from "../logger";

export const cacheRouter = Router();

cacheRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.json(await cacheStats());
  }),
);

/** 按当前上限立刻清理一次（忽略「最近 10 分钟不动」的保护） */
cacheRouter.post(
  "/trim",
  asyncHandler(async (_req, res) => {
    const result = await trimCache({ reason: "manual", force: true });
    const stats = await cacheStats();
    if (!result.limitMb) {
      res.json({ ...result, stats, message: "未设置上限，不自动清理" });
      return;
    }
    if (!result.triggered) {
      res.json({
        ...result,
        stats,
        message: `缓存 ${humanBytes(stats.total.bytes)}，未超过 ${result.limitMb} MB 上限`,
      });
      return;
    }
    res.json({
      ...result,
      stats,
      message: `已删除 ${result.removedFiles} 个文件，释放 ${humanBytes(result.freed)}`,
    });
  }),
);

/** 一键清空 covers 与 frames（不动数据库、下载文件与日志） */
cacheRouter.post(
  "/clear",
  asyncHandler(async (_req, res) => {
    logger.info({ action: "cache.clear" }, "用户手动清空缓存");
    const result = await clearCache();
    res.json({
      ...result,
      stats: await cacheStats(),
      message: result.removedFiles
        ? `已删除 ${result.removedFiles} 个文件，释放 ${humanBytes(result.freed)}`
        : "缓存本来就是空的",
    });
  }),
);
