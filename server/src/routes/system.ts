import { Router } from "express";
import { db, clearIgnoredIssues, getBotToken, getSettings, ignoreIssue, restoreIgnoredIssue } from "../db";
import { getSchedulerState, isScanning, markScanTimestamp, scanAll, scanChannel } from "../tg/scanner";
import { downloader } from "../tg/downloader";
import { getAuthState, sdkLoaded } from "../tg/client";
import { getBotState, restartBot, startBot, stopBot } from "../tg/bot";
import { asyncHandler, assert } from "../lib/http";
import { requestShutdown } from "../lib/lifecycle";
import { ffmpegInfo } from "../tg/ffmpeg";
import {
  PROBE_SITES,
  PROXY_SCHEMES,
  explainProxyProblem,
  parseProxy,
  probeSites,
  telegramGetMe,
  telegramProxyUnsupported,
} from "../lib/netprobe";
import { APP_VERSION } from "../version";
import { findOverviewIssue, getOverview, invalidateOverview } from "../system/overview";
import { logger } from "../logger";

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
 * 概览页聚合状态：运行时 / 存储 / 工具链 / 服务，一次拿全。
 * 默认复用 30 秒缓存，?refresh=1 会重新探测 ffmpeg、yt-dlp、Chromium 的版本。
 */
systemRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    res.json(await getOverview(req.query.refresh === "1"));
  }),
);

/**
 * 忽略一条概览提醒。存的是「探针 id + 状态指纹」，不是整段文案：
 * 状态变了（例如 Cookie 补齐）会生成新 id，提醒会自动回来。
 * 文案快照一起落库，问题消失后仍能在「已忽略」里找到并恢复。
 */
systemRouter.post(
  "/overview/issues/ignore",
  asyncHandler(async (req, res) => {
    const id = String(req.body?.id ?? "").trim();
    assert(id && id.length <= 160, 400, "缺少提醒标识");
    const found = await findOverviewIssue(id);
    const fallbackLabel = String(req.body?.label ?? "").trim().slice(0, 120);
    const fallbackText = String(req.body?.text ?? "").trim().slice(0, 400);
    const label = found?.label || fallbackLabel || "已忽略的提醒";
    const text = found?.text || fallbackText || label;
    ignoreIssue(id, label, text);
    invalidateOverview();
    logger.info({ id, label }, "已忽略概览提醒");
    res.json({ ok: true, id });
  }),
);

/** 取消忽略：下次刷新这条提醒会重新出现在顶部 */
systemRouter.post(
  "/overview/issues/restore",
  asyncHandler(async (req, res) => {
    const id = String(req.body?.id ?? "").trim();
    assert(id, 400, "缺少提醒标识");
    const ok = restoreIgnoredIssue(id);
    invalidateOverview();
    res.json({ ok, id });
  }),
);

/** 一键把「已忽略」全部恢复 */
systemRouter.post(
  "/overview/issues/restore-all",
  asyncHandler(async (_req, res) => {
    const count = clearIgnoredIssues();
    invalidateOverview();
    res.json({ ok: true, count });
  }),
);

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

/**
 * Bot Token 连通性测试。
 *
 * 走的是普通 HTTPS 的 getMe，和机器人进程自己的 MTProto 连接是两条路：
 * - getMe 通、机器人连不上 → Token 没问题，是 MTProto（或代理只放了 443）的事
 * - getMe 也不通 → token 无效，或者代理根本没通
 */
systemRouter.post(
  "/bot/test",
  asyncHandler(async (req, res) => {
    const provided = typeof req.body?.token === "string" ? String(req.body.token).trim() : "";
    const token = provided || getBotToken();
    const proxyRaw = String(req.body?.proxyUrl ?? getSettings().proxy_url ?? "").trim();
    const proxy = parseProxy(proxyRaw);
    if (proxyRaw && !proxy) {
      res.status(400).json({ ok: false, error: explainProxyProblem(proxyRaw), identity: null });
      return;
    }
    const identity = await telegramGetMe(token, proxy);
    logger.info(
      { ok: identity.ok, username: identity.username, via: proxy ? proxy.scheme : "direct" },
      identity.ok ? "Bot Token 校验通过" : "Bot Token 校验失败",
    );
    res.json({ ok: identity.ok, identity, viaProxy: Boolean(proxy) });
  }),
);

/* ------------------------------------------------------------------ */
/* 网络与工具                                                          */
/* ------------------------------------------------------------------ */

/** 当前代理设置与服务端支持的协议，界面用来渲染协议下拉与状态行 */
systemRouter.get(
  "/network",
  asyncHandler(async (_req, res) => {
    const raw = String(getSettings().proxy_url ?? "").trim();
    const proxy = parseProxy(raw);
    res.json({
      proxyUrl: raw,
      proxy: proxy
        ? { scheme: proxy.scheme, host: proxy.host, port: proxy.port, hasAuth: Boolean(proxy.username) }
        : null,
      problem: explainProxyProblem(raw),
      /** Telegram 的 MTProto 只能走 SOCKS，HTTP(S) 代理时界面要提示 */
      telegramUnsupported: telegramProxyUnsupported(raw),
      schemes: PROXY_SCHEMES,
      sites: PROBE_SITES.map((s) => ({ id: s.id, label: s.label, note: s.note, url: s.url })),
    });
  }),
);

systemRouter.post(
  "/network/test",
  asyncHandler(async (req, res) => {
    const raw = String(req.body?.proxyUrl ?? getSettings().proxy_url ?? "").trim();
    const proxy = parseProxy(raw);
    if (raw && !proxy) {
      res.status(400).json({ error: explainProxyProblem(raw) || "代理地址格式不正确" });
      return;
    }
    const timeoutMs = Math.min(20_000, Math.max(3000, Number(req.body?.timeoutMs) || 8000));
    const started = Date.now();
    const results = await probeSites(proxy, timeoutMs);
    logger.info(
      {
        via: proxy ? `${proxy.scheme}://${proxy.host}:${proxy.port}` : "direct",
        ok: results.filter((r) => r.ok).length,
        total: results.length,
      },
      "联网测试完成",
    );
    res.json({
      at: Date.now(),
      elapsedMs: Date.now() - started,
      viaProxy: Boolean(proxy),
      proxy: proxy ? { scheme: proxy.scheme, host: proxy.host, port: proxy.port } : null,
      results,
    });
  }),
);

/** ffmpeg 的实际路径与版本（界面要显示「现在用的是哪个」） */
systemRouter.get(
  "/ffmpeg",
  asyncHandler(async (req, res) => {
    const info = await ffmpegInfo(req.query.refresh === "1");
    const sourceLabel: Record<string, string> = {
      settings: "设置里指定的路径",
      env: "环境变量 FFMPEG_PATH",
      bundled: "内置 npm 包",
      path: "系统 PATH",
    };
    res.json({
      ffmpeg: info,
      sourceLabel: info.source ? sourceLabel[info.source] ?? info.source : null,
      configuredPath: getSettings().ffmpeg_path,
    });
  }),
);
