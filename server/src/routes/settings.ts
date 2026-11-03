import { Router } from "express";
import {
  db,
  getEmbyKeyHint,
  getPlatformCookieHint,
  getSession,
  getSettings,
  setBotToken,
  setEmbyApiKey,
  setPlatformCookie,
  updateSettings,
} from "../db";
import { env } from "../env";
import { disconnectClient } from "../tg/client";
import { getBotState, restartBot } from "../tg/bot";
import { getBuiltinApp } from "../tg/credentials";
import { normalizeEmbyUrl } from "../tg/embyapi";
import { normalizeProxyUrl } from "../lib/netprobe";
import { withLiveProgress } from "../tg/downloader";
import { AppSettings, Download, PLATFORM_IDS } from "../types";
import { asyncHandler, assert, clampInt } from "../lib/http";
import { APP_VERSION } from "../version";
import { clearYtdlpCache } from "../platform/ytdlp";
import { engineState } from "../platform/updater";
import { DIR_KEYS, DIR_LABEL, parseDirSetting } from "../tg/mediadir";

export const settingsRouter = Router();

const MASK = "••••••••";

const PLATFORMS = PLATFORM_IDS;

/** 设置页要的第三方平台状态：Cookie 只回「有没有配 + 摘要」，yt-dlp 回版本与更新状态 */
async function platformSnapshot() {
  const cookies: Record<string, ReturnType<typeof getPlatformCookieHint>> = {};
  for (const id of PLATFORMS) cookies[id] = getPlatformCookieHint(id);
  const { info, update } = await engineState();
  return { cookies, ytdlp: info, update };
}

settingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const s = getSettings();
    const builtin = getBuiltinApp(s.builtin_app);
    const embyKey = getEmbyKeyHint();
    res.json({
      settings: {
        ...s,
        api_hash: s.api_hash ? MASK : "",
        has_session: Boolean(getSession()),
      },
      // 当前实际生效的凭证来源，用于界面展示
      credential:
        s.credential_mode === "custom"
          ? { mode: "custom", label: "自定义应用", apiId: s.api_id || null }
          : { mode: "builtin", label: builtin.label, apiId: String(builtin.apiId) },
      // Emby API Key 单独加密存放，只回掩码与「有没有配置」
      emby: { apiKeySet: embyKey.set, apiKeyHint: embyKey.hint },
      paths: { dataDir: env.dataDir, downloadDir: env.downloadDir, dbFile: env.dbFile },
      version: APP_VERSION,
      bot: getBotState(),
      platform: await platformSnapshot(),
    });
  }),
);

settingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = getSettings();
    const patch: Partial<AppSettings> = {};

    if (body.credential_mode === "builtin" || body.credential_mode === "custom") {
      patch.credential_mode = body.credential_mode;
    }
    if (body.builtin_app === "desktop" || body.builtin_app === "builtin") {
      patch.builtin_app = body.builtin_app;
    }
    if (typeof body.api_id === "string") patch.api_id = body.api_id.trim().replace(/\D/g, "");
    if (typeof body.api_hash === "string" && body.api_hash !== MASK) patch.api_hash = body.api_hash.trim();
    if (typeof body.proxy_url === "string") patch.proxy_url = normalizeProxyUrl(body.proxy_url);
    if (typeof body.file_template === "string" && body.file_template.trim()) {
      patch.file_template = body.file_template.trim();
    }
    if (body.scan_interval_minutes !== undefined) {
      patch.scan_interval_minutes = clampInt(body.scan_interval_minutes, 1, 1440, current.scan_interval_minutes);
    }
    if (body.initial_scan_messages !== undefined) {
      patch.initial_scan_messages = clampInt(body.initial_scan_messages, 1, 500, current.initial_scan_messages);
    }
    if (body.batch_size !== undefined) {
      patch.batch_size = clampInt(body.batch_size, 10, 100, current.batch_size);
    }
    if (body.concurrency !== undefined) {
      patch.concurrency = clampInt(body.concurrency, 1, 10, current.concurrency);
    }
    if (body.min_file_size !== undefined) {
      patch.min_file_size = clampInt(body.min_file_size, 0, Number.MAX_SAFE_INTEGER, current.min_file_size);
    }
    if (body.max_file_size !== undefined) {
      patch.max_file_size = clampInt(body.max_file_size, 0, Number.MAX_SAFE_INTEGER, current.max_file_size);
    }
    if (body.auto_scan !== undefined) patch.auto_scan = Boolean(body.auto_scan);
    if (body.emby_meta !== undefined) patch.emby_meta = Boolean(body.emby_meta);
    // cover_images 已废弃（1.0.3 起封面改为视频截帧），仍接受写入只为兼容旧前端
    if (body.cover_images !== undefined) {
      patch.cover_images = clampInt(body.cover_images, 0, 9, current.cover_images);
    }
    if (body.fallback_folder !== undefined) patch.fallback_folder = Boolean(body.fallback_folder);
    if (body.auto_cover_frames !== undefined) patch.auto_cover_frames = Boolean(body.auto_cover_frames);
    if (body.bot_enabled !== undefined) patch.bot_enabled = Boolean(body.bot_enabled);
    if (typeof body.ffmpeg_path === "string") patch.ffmpeg_path = body.ffmpeg_path.trim();
    if (typeof body.bot_allow_users === "string") {
      // 只保留数字 ID，顺手去重，避免用户填了 @用户名 后一直"没权限"
      patch.bot_allow_users = [
        ...new Set(
          body.bot_allow_users
            .split(/[\s,，;；]+/)
            .map((v) => v.trim().replace(/^@/, ""))
            .filter((v) => /^\d+$/.test(v)),
        ),
      ].join(",");
    }
    if (body.bot_notify !== undefined) patch.bot_notify = Boolean(body.bot_notify);
    if (body.cache_limit_mb !== undefined) {
      patch.cache_limit_mb = clampInt(body.cache_limit_mb, 0, 102400, current.cache_limit_mb);
    }
    if (body.emby_notify !== undefined) patch.emby_notify = Boolean(body.emby_notify);
    if (typeof body.emby_url === "string") patch.emby_url = normalizeEmbyUrl(body.emby_url);
    if (typeof body.emby_path_map === "string") {
      patch.emby_path_map = body.emby_path_map
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
    }

    /* 网页 / m3u8 下载的线路：代理地址 + 直连优先策略 */
    if (typeof body.m3u8_proxy === "string") patch.m3u8_proxy = normalizeProxyUrl(body.m3u8_proxy);
    if (body.m3u8_proxy_mode !== undefined) {
      const mode = String(body.m3u8_proxy_mode).trim().toLowerCase();
      patch.m3u8_proxy_mode = (["auto", "always", "off"] as const).includes(mode as "auto")
        ? (mode as "auto" | "always" | "off")
        : current.m3u8_proxy_mode;
    }

    /* 第三方平台（B站 / 小红书 / YouTube） */
    if (body.platform_enabled !== undefined) patch.platform_enabled = Boolean(body.platform_enabled);
    if (typeof body.platform_proxy === "string") patch.platform_proxy = normalizeProxyUrl(body.platform_proxy);
    if (body.platform_proxy_domestic !== undefined) {
      patch.platform_proxy_domestic = Boolean(body.platform_proxy_domestic);
    }
    if (body.ytdlp_auto_update !== undefined) patch.ytdlp_auto_update = Boolean(body.ytdlp_auto_update);
    if (body.ytdlp_check_hours !== undefined) {
      patch.ytdlp_check_hours = clampInt(body.ytdlp_check_hours, 1, 720, current.ytdlp_check_hours);
    }
    if (typeof body.ytdlp_path === "string") patch.ytdlp_path = body.ytdlp_path.trim();
    if (typeof body.platform_quality === "string") {
      const quality = body.platform_quality.trim().toLowerCase();
      patch.platform_quality = ["best", "1080", "720", "480"].includes(quality)
        ? quality
        : current.platform_quality;
    }
    // 老字段：1.3.2 起由下面 5 个分来源目录取代，仍接受写入只为兼容旧前端
    if (typeof body.platform_dir === "string") {
      const dir = body.platform_dir
        .trim()
        .replace(/[\\/]+/g, "")
        .replace(/^\.+/, "")
        .slice(0, 40);
      patch.platform_dir = dir || "第三方";
    }

    // 分来源目录：只允许下载根内的相对路径，越界或带 .. 直接 400
    for (const key of DIR_KEYS) {
      if (typeof body[key] !== "string") continue;
      const parsed = parseDirSetting(body[key], env.downloadDir);
      assert(!parsed.error, 400, `${DIR_LABEL[key]} 下载目录无效：${parsed.error}`);
      patch[key] = parsed.dir;
    }
    if (body.platform_meta !== undefined) patch.platform_meta = Boolean(body.platform_meta);

    // Cookie 和 session 同级：加密落盘。传掩码 = 不改，传空字符串 = 清除
    for (const id of PLATFORMS) {
      const value = body[`platform_cookie_${id}`];
      if (typeof value === "string" && value !== MASK) setPlatformCookie(id, value);
    }

    // Emby API Key 和 bot token 一样单独加密落盘；传空字符串 = 清除，传掩码 = 保持不变
    if (typeof body.emby_api_key === "string" && body.emby_api_key !== MASK) {
      setEmbyApiKey(body.emby_api_key);
    }

    // token 单独加密落盘，不放进 AppSettings。
    // 传了 bot_token 就按传入值覆盖（传空字符串 = 清除），传掩码 = 保持不变
    const tokenProvided = typeof body.bot_token === "string" && body.bot_token !== MASK;
    if (tokenProvided) setBotToken(String(body.bot_token));

    const before = { ...current };
    const next = updateSettings(patch);

    // 换了 yt-dlp 路径要重新探测，否则界面还显示旧的「未安装」
    if (before.ytdlp_path !== next.ytdlp_path) clearYtdlpCache();

    if (
      before.api_id !== next.api_id ||
      before.api_hash !== next.api_hash ||
      before.proxy_url !== next.proxy_url ||
      before.credential_mode !== next.credential_mode ||
      before.builtin_app !== next.builtin_app
    ) {
      await disconnectClient();
    }

    // 机器人相关改动（开关 / token / 白名单）都要重新握手，异步重建，不阻塞保存
    if (
      tokenProvided ||
      before.bot_enabled !== next.bot_enabled ||
      before.bot_allow_users !== next.bot_allow_users ||
      before.proxy_url !== next.proxy_url ||
      before.credential_mode !== next.credential_mode ||
      before.builtin_app !== next.builtin_app ||
      before.api_id !== next.api_id ||
      before.api_hash !== next.api_hash
    ) {
      void restartBot();
    }

    const builtin = getBuiltinApp(next.builtin_app);
    const embyKey = getEmbyKeyHint();
    res.json({
      settings: { ...next, api_hash: next.api_hash ? MASK : "", has_session: Boolean(getSession()) },
      credential:
        next.credential_mode === "custom"
          ? { mode: "custom", label: "自定义应用", apiId: next.api_id || null }
          : { mode: "builtin", label: builtin.label, apiId: String(builtin.apiId) },
      emby: { apiKeySet: embyKey.set, apiKeyHint: embyKey.hint },
      bot: getBotState(),
      platform: await platformSnapshot(),
    });
  }),
);

settingsRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayStart = startOfDay.getTime();

    const agg = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
           COALESCE(SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END), 0) AS downloading,
           COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
           COALESCE(SUM(CASE WHEN status = 'done' THEN file_size ELSE 0 END), 0) AS bytes
         FROM downloads`,
      )
      .get() as Record<string, number>;

    const today = db
      .prepare(
        `SELECT COUNT(*) AS downloads, COALESCE(SUM(file_size), 0) AS bytes
         FROM downloads WHERE created_at >= ?`,
      )
      .get(dayStart) as { downloads: number; bytes: number };

    const channelCount = (db.prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number }).n;
    const enabledChannels = (
      db.prepare("SELECT COUNT(*) AS n FROM channels WHERE enabled = 1").get() as { n: number }
    ).n;
    const subscriptionCount = (
      db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE enabled = 1").get() as { n: number }
    ).n;

    const recentRuns = db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 8").all();
    const recentDownloads = (
      db.prepare("SELECT * FROM downloads ORDER BY id DESC LIMIT 6").all() as Download[]
    ).map(withLiveProgress);

    res.json({
      totals: { ...agg, channels: channelCount, enabledChannels, subscriptions: subscriptionCount },
      today,
      recentRuns,
      recentDownloads,
    });
  }),
);
