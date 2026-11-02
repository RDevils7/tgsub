import { Router } from "express";
import { getPlatformCookieHint, getPlatformCookie, getSettings } from "../db";
import { asyncHandler } from "../lib/http";
import { logger } from "../logger";
import { PLATFORM_IDS, PLATFORM_LABEL } from "../types";
import { parsePlatformLink } from "../platform/detect";
import { enqueuePlatformLink, platformRootDir } from "../platform/jobs";
import { clearYtdlpCache, probePlatform, ytdlpInfo } from "../platform/ytdlp";
import { engineState, updateYtdlp } from "../platform/updater";

/**
 * 第三方平台（B站 / 抖音 / 小红书 / YouTube）
 *
 *   GET  /status   引擎版本、更新状态、Cookie 状态；设置页与下载页都用
 *   POST /probe    只解析，不下载（用户可能只想看看是什么视频）
 *   POST /task     解析 + 入队，返回任务 id
 *   POST /update   立刻检查 yt-dlp 新版本并下载
 *
 * Cookie 不在这里写，走 PUT /api/settings（和 session/bot token 一样加密落盘）。
 */

export const platformRouter = Router();

platformRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const settings = getSettings();
    const { info, update } = await engineState();
    res.json({
      enabled: settings.platform_enabled,
      quality: settings.platform_quality,
      dir: settings.platform_dir,
      root: platformRootDir(),
      meta: settings.platform_meta,
      proxy: settings.platform_proxy,
      ytdlp: info,
      update,
      platforms: PLATFORM_IDS.map((id) => {
        const state = getPlatformCookieHint(id);
        return {
          id,
          label: PLATFORM_LABEL[id],
          cookieSet: state.set,
          cookieHint: state.hint,
          cookieCount: state.count,
          cookieMissing: state.missing,
          cookieSavedAt: state.savedAt,
        };
      }),
    });
  }),
);

platformRouter.post(
  "/probe",
  asyncHandler(async (req, res) => {
    const url = String((req.body ?? {}).url ?? "").trim();
    const link = parsePlatformLink(url);
    if (!link) {
      res.status(400).json({ error: "这不是 B站 / 抖音 / 小红书 / YouTube 链接" });
      return;
    }
    const probe = await probePlatform(link.url, link.platform, getPlatformCookie(link.platform));
    res.json({ platform: link.platform, label: PLATFORM_LABEL[link.platform], probe });
  }),
);

platformRouter.post(
  "/task",
  asyncHandler(async (req, res) => {
    const url = String((req.body ?? {}).url ?? "").trim();
    const link = parsePlatformLink(url);
    if (!link) {
      res.status(400).json({ error: "这不是 B站 / 抖音 / 小红书 / YouTube 链接" });
      return;
    }
    const task = await enqueuePlatformLink(link);
    res.json(task);
  }),
);

/** 设置页改完 yt-dlp 路径后清缓存，避免还要等 30 秒才刷新状态 */
platformRouter.post(
  "/refresh",
  asyncHandler(async (_req, res) => {
    clearYtdlpCache();
    const info = await ytdlpInfo(true);
    logger.info({ available: info.available, version: info.version, source: info.source }, "重新探测 yt-dlp");
    res.json({ ytdlp: info, update: (await engineState()).update });
  }),
);

/** 手动检查更新：有新版本就下载并切换，没有就只回版本信息 */
platformRouter.post(
  "/update",
  asyncHandler(async (_req, res) => {
    const result = await updateYtdlp();
    const { info, update } = await engineState();
    res.json({ ...result, ytdlp: info, update });
  }),
);
