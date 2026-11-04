import { Router } from "express";
import { getEmbyApiKey, getEmbyKeyHint, getSettings } from "../db";
import { asyncHandler, assert, clampInt } from "../lib/http";
import { env } from "../env";
import {
  getEmbyConfig,
  getEmbyNotifyState,
  normalizeEmbyUrl,
  notifyEmbyNow,
  parsePathMap,
  probeEmby,
  refreshEmbyLibrary,
} from "../tg/embyapi";
import {
  fetchItemImage,
  getEmbyServerConfig,
  getItem,
  getPlaybackSource,
  listLibraries,
  pipeVideoStream,
  queryItems,
} from "../tg/embyview";

export const embyRouter = Router();

/** 概览：是否启用、配置是否完整、最近通知记录 */
embyRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const s = getSettings();
    const key = getEmbyKeyHint();
    const url = normalizeEmbyUrl(s.emby_url);
    res.json({
      enabled: Boolean(s.emby_notify),
      configured: Boolean(s.emby_notify && url && key.set),
      url,
      pathMap: parsePathMap(s.emby_path_map).map((r) => `${r.from}=${r.to}`),
      apiKeySet: key.set,
      apiKeyHint: key.hint,
      downloadDir: env.downloadDir,
      ...getEmbyNotifyState(),
    });
  }),
);

/**
 * 测试连接。
 * 允许带上界面上还没保存的地址 / API Key —— 用户改完地址点「测试」就该立刻有结果，
 * 不必先保存再改回来。
 */
embyRouter.post(
  "/test",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown; apiKey?: unknown };
    const saved = getSettings();
    const rawUrl = typeof body.url === "string" && body.url.trim() ? body.url : saved.emby_url;
    const baseUrl = normalizeEmbyUrl(rawUrl);
    assert(baseUrl, 400, "请先填写 Emby 地址，例如 http://192.168.1.10:8096");

    const typedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    // 掩码 / 空都表示「用已保存的」，避免把 •••••••• 当密钥发出去
    const apiKey = typedKey && !/^•+$/.test(typedKey) ? typedKey : getEmbyApiKey();
    assert(apiKey, 400, "请先填写 Emby API Key");

    const result = await probeEmby({ baseUrl, apiKey });
    res.json({ ...result, url: baseUrl });
  }),
);

/** 让 Emby 立刻全库扫描：补上历史文件，或通知失败后兜底 */
embyRouter.post(
  "/refresh",
  asyncHandler(async (_req, res) => {
    assert(getEmbyConfig(), 400, "Emby 入库通知未启用或未配置完整");
    res.json(await refreshEmbyLibrary());
  }),
);

/** 手动补推某个路径（目录或文件），用于老数据或调试 */
embyRouter.post(
  "/notify",
  asyncHandler(async (req, res) => {
    assert(getEmbyConfig(), 400, "Emby 入库通知未启用或未配置完整");
    const input = String(req.body?.path ?? "").trim();
    assert(input, 400, "请提供要提交的路径");
    // 相对路径按下载目录解析，方便直接填「美人局」这样的剧集目录名
    const target = input.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(input)
      ? input
      : `${env.downloadDir.replace(/[\\/]+$/, "")}/${input.replace(/^[\\/]+/, "")}`;
    const record = await notifyEmbyNow([target], "Modified");
    res.json({ ok: record.ok, record });
  }),
);

/* ------------------------------------------------------------------ */
/* 媒体库浏览                                                          */
/*                                                                     */
/* 与上面几个接口的区别：只要填了地址 + API Key 就能用，不要求先打开   */
/* 「入库通知」开关 —— 很多人只想用 tgsub 当 Emby 的前端看看片。        */
/* ------------------------------------------------------------------ */

function requireServerConfig() {
  const config = getEmbyServerConfig();
  assert(config, 400, "请先在「设置 → Emby 媒体库」里填写 Emby 地址与 API Key");
  return config;
}

/**
 * 媒体库列表。
 * 没配置 / 连不上时返回 ok:false + error，而不是抛 4xx ——
 * 页面据此显示引导卡片，比一个红色报错好用。
 */
embyRouter.get(
  "/library",
  asyncHandler(async (_req, res) => {
    const config = getEmbyServerConfig();
    if (!config) {
      res.json({
        ok: false,
        configured: false,
        libraries: [],
        error: "还没配置 Emby 地址与 API Key，可到「设置 → Emby 媒体库」填写",
      });
      return;
    }
    try {
      const libraries = await listLibraries(config);
      res.json({ ok: true, configured: true, libraries, url: config.baseUrl });
    } catch (err) {
      res.json({ ok: false, configured: true, libraries: [], url: config.baseUrl, error: (err as Error).message });
    }
  }),
);

/** 条目列表：媒体库 / 某个剧集的分集 / 搜索结果，共用这一个 */
embyRouter.get(
  "/items",
  asyncHandler(async (req, res) => {
    const config = requireServerConfig();
    const start = clampInt(req.query.start, 0, 1_000_000, 0);
    const limit = clampInt(req.query.limit, 1, 120, 60);
    const read = (key: string) => (typeof req.query[key] === "string" ? String(req.query[key]) : "");
    const result = await queryItems(config, {
      libraryId: read("libraryId").trim(),
      parentId: read("parentId").trim(),
      search: read("search"),
      types: read("types").trim(),
      sortBy: read("sortBy").trim(),
      sortOrder: read("sortOrder") === "Descending" ? "Descending" : "Ascending",
      start,
      limit,
    });
    res.json({ ok: true, ...result, limit });
  }),
);

/** 单条详情 */
embyRouter.get(
  "/items/:id",
  asyncHandler(async (req, res) => {
    const config = requireServerConfig();
    const item = await getItem(config, String(req.params.id));
    assert(item, 404, "Emby 上找不到这个条目，可能刚被删除");
    res.json({ ok: true, item });
  }),
);

/** 播放信息：给前端一个本站可直接播放的地址 */
embyRouter.get(
  "/play/:id",
  asyncHandler(async (req, res) => {
    const config = requireServerConfig();
    res.json({ ok: true, ...(await getPlaybackSource(config, String(req.params.id))) });
  }),
);

/** 视频流代理：透传 Range，浏览器里的 <video> 才能拖进度条 */
embyRouter.get(
  "/stream/:id",
  asyncHandler(async (req, res) => {
    const config = requireServerConfig();
    const source = typeof req.query.source === "string" ? req.query.source : null;
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    await pipeVideoStream(config, String(req.params.id), source, range, res);
  }),
);

/** 海报代理：<img> 带不了自定义头，只能由服务端补 Token */
embyRouter.get(
  "/image/:id",
  asyncHandler(async (req, res) => {
    const config = requireServerConfig();
    const type = typeof req.query.type === "string" ? req.query.type : "Primary";
    const tag = typeof req.query.tag === "string" && req.query.tag ? req.query.tag : null;
    const maxWidth = clampInt(req.query.maxWidth, 80, 1200, 360);
    const image = await fetchItemImage(config, String(req.params.id), { type, tag, maxWidth });
    if (!image) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", image.contentType);
    // 海报基本不变，缓存一天，滚动列表不会反复打 Emby
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(image.body);
  }),
);
