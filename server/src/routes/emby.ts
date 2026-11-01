import { Router } from "express";
import { getEmbyApiKey, getEmbyKeyHint, getSettings } from "../db";
import { asyncHandler, assert } from "../lib/http";
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
