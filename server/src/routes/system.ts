import { Router } from "express";
import { db } from "../db";
import { getSchedulerState, isScanning, markScanTimestamp, scanAll, scanChannel } from "../tg/scanner";
import { downloader } from "../tg/downloader";
import { getAuthState, sdkLoaded } from "../tg/client";
import { getBotState, restartBot, startBot, stopBot } from "../tg/bot";
import { asyncHandler, assert } from "../lib/http";
import { requestShutdown } from "../lib/lifecycle";
import { APP_VERSION } from "../version";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) => {
  let dbOk = true;
  try {
    db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    uptime: Math.round(process.uptime()),
    telegram: sdkLoaded(),
    version: APP_VERSION,
  });
});

/**
 * 优雅退出：先断开 Telegram 再退出进程。
 * 重启流程建议：调本接口 → 等端口释放 → 再起新进程，
 * 这样新旧连接不会重叠，authKey 就不会被服务器作废（不用重新扫码）。
 */
systemRouter.post(
  "/shutdown",
  asyncHandler(async (req, res) => {
    const ip = (req.ip || "").replace(/^::ffff:/, "");
    const fromLoopback = ip === "127.0.0.1" || ip === "::1";
    assert(fromLoopback, 403, "仅允许本机调用");
    res.json({ ok: true });
    setTimeout(() => void requestShutdown("api"), 50);
  }),
);

systemRouter.get(
  "/scan/state",
  asyncHandler(async (_req, res) => {
    res.json({
      ...getSchedulerState(),
      queue: downloader.stats(),
      auth: await getAuthState(),
    });
  }),
);

systemRouter.post(
  "/scan",
  asyncHandler(async (req, res) => {
    assert(!isScanning(), 409, "扫描正在进行中");
    const channelId = Number(req.body?.channelId ?? 0);

    if (channelId > 0) {
      markScanTimestamp();
      const result = await scanChannel(channelId, { ignoreDisabled: true });
      res.json({ results: [result] });
      return;
    }

    const results = await scanAll("manual");
    res.json({ results });
  }),
);

/* ------------------------------------------------------------------ */
/* Telegram 机器人                                                     */
/* ------------------------------------------------------------------ */

systemRouter.get(
  "/bot",
  asyncHandler(async (_req, res) => {
    res.json({ bot: getBotState() });
  }),
);

systemRouter.post(
  "/bot/restart",
  asyncHandler(async (_req, res) => {
    // 不 await：经代理重新握手可能要几秒，让前端轮询状态即可
    void restartBot();
    res.json({ ok: true });
  }),
);

systemRouter.post(
  "/bot/stop",
  asyncHandler(async (_req, res) => {
    await stopBot();
    res.json({ ok: true, bot: getBotState() });
  }),
);

systemRouter.post(
  "/bot/start",
  asyncHandler(async (_req, res) => {
    void startBot();
    res.json({ ok: true });
  }),
);
