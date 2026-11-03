import { Router } from "express";
import { getPlatformCookieHint, getPlatformCookie, getSettings } from "../db";
import { asyncHandler } from "../lib/http";
import { logger } from "../logger";
import { PLATFORM_IDS, PLATFORM_LABEL } from "../types";
import { parsePlatformLink, splitPlatformLinks, PlatformLink } from "../platform/detect";
import { enqueuePlatformLink, platformRootDir, resolveChoice } from "../platform/jobs";
import { clearYtdlpCache, probePlatform, ytdlpInfo } from "../platform/ytdlp";
import { engineState, updateYtdlp } from "../platform/updater";
import { recordManual } from "../manual/history";
import { clamp, manualStatus, platformNote } from "../manual/note";
import { platformDirKey } from "../tg/mediadir";

/**
 * 第三方平台（B站 / 小红书 / YouTube）
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
      // 每个平台自己的落盘目录（相对下载根）与绝对路径，界面上直接展示
      dirs: Object.fromEntries(
        PLATFORM_IDS.map((id) => [id, settings[platformDirKey(id) ?? "dir_bilibili"]]),
      ) as Record<string, string>,
      roots: Object.fromEntries(PLATFORM_IDS.map((id) => [id, platformRootDir(id)])) as Record<
        string,
        string
      >,
      meta: settings.platform_meta,
      proxy: settings.platform_proxy,
      proxyDomestic: settings.platform_proxy_domestic,
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
    // 允许直接把 App 的分享口令整段丢进来（界面上是拆好后逐条发的，这里兼容 curl / 脚本）
    const link = parsePlatformLink(url) ?? splitPlatformLinks(url)[0] ?? null;
    if (!link) {
      res.status(400).json({ error: "这不是 B站 / 小红书 / YouTube 链接" });
      return;
    }
    const probe = await probePlatform(link.url, link.platform, getPlatformCookie(link.platform));
    res.json({ platform: link.platform, label: PLATFORM_LABEL[link.platform], probe });
  }),
);

platformRouter.post(
  "/task",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { url?: string; token?: string; mode?: string };
    const mode = body.mode === "all" ? "all" : body.mode === "one" ? "one" : undefined;

    // 二次提交有两条路：界面带原链接 + mode；机器人按钮带 token + mode
    let link: PlatformLink | null = null;
    if (body.token) {
      const saved = resolveChoice(String(body.token));
      if (!saved) {
        res.status(410).json({ error: "这次选择已过期，请重新粘贴链接" });
        return;
      }
      link = { platform: saved.platform, url: saved.url, id: null, key: saved.url };
    } else {
      const url = String(body.url ?? "").trim();
      link = parsePlatformLink(url) ?? splitPlatformLinks(url)[0] ?? null;
    }
    if (!link) {
      res.status(400).json({ error: "这不是 B站 / 小红书 / YouTube 链接" });
      return;
    }

    const outcome = await enqueuePlatformLink(link, mode).catch((err: unknown) => {
      recordManual({
        link: link!.url,
        kind: "platform",
        platform: link!.platform,
        status: "error",
        error: clamp((err as Error).message),
      });
      throw err;
    });
    if (outcome.type === "playlist") {
      // 还没真的下，等用户选完再记一条；用户点取消时由界面补记 status=cancel
      res.json({ needsChoice: true, choice: outcome.choice });
      return;
    }
    const queued = outcome.tasks.filter((task) => !task.existing).length;
    const existing = outcome.tasks.filter((task) => task.existing).length;
    recordManual({
      link: link.url,
      kind: "platform",
      platform: link.platform,
      status: manualStatus({ queued, existing }),
      title: outcome.tasks[0]?.title ?? null,
      note: platformNote(outcome.tasks, outcome.playlist),
      queued,
      existing,
      saveDir: outcome.tasks[0]?.saveDir ?? null,
    });
    res.json({
      needsChoice: false,
      platform: link.platform,
      label: PLATFORM_LABEL[link.platform],
      url: link.url,
      playlist: outcome.playlist,
      queued,
      existing,
      tasks: outcome.tasks,
    });
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
