import { Router } from "express";
import { db, getEmbyKeyHint, getSession, getSettings, setBotToken, setEmbyApiKey, updateSettings } from "../db";
import { env } from "../env";
import { disconnectClient } from "../tg/client";
import { getBotState, restartBot } from "../tg/bot";
import { getBuiltinApp } from "../tg/credentials";
import { normalizeEmbyUrl } from "../tg/embyapi";
import { normalizeProxyUrl } from "../lib/netprobe";
import { withLiveProgress } from "../tg/downloader";
import { AppSettings, Download } from "../types";
import { asyncHandler, clampInt } from "../lib/http";
import { APP_VERSION } from "../version";

export const settingsRouter = Router();

const MASK = "••••••••";

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
