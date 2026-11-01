import { Router } from "express";
import QRCode from "qrcode";
import {
  cancelQrLogin,
  getAuthState,
  getQrState,
  importSession,
  logout,
  requestLoginCode,
  resetSessionForRelogin,
  retrySession,
  startQrLogin,
  submitLoginCode,
  submitPassword,
  submitQrPassword,
  type QrState,
} from "../tg/client";
import { asyncHandler, assert } from "../lib/http";

export const authRouter = Router();

/** 二维码图片缓存：URL 每 30 秒轮换，保留最近几张避免重复渲染 */
const qrImageCache = new Map<string, string>();

async function withImage(state: QrState) {
  if (!state.url) return { ...state, qrDataUrl: null as string | null };
  let dataUrl = qrImageCache.get(state.url);
  if (!dataUrl) {
    dataUrl = await QRCode.toDataURL(state.url, {
      margin: 1,
      width: 300,
      errorCorrectionLevel: "M",
      color: { dark: "#0b1220", light: "#ffffff" },
    });
    qrImageCache.set(state.url, dataUrl);
    if (qrImageCache.size > 4) {
      const oldest = qrImageCache.keys().next().value;
      if (oldest) qrImageCache.delete(oldest);
    }
  }
  return { ...state, qrDataUrl: dataUrl };
}

authRouter.get(
  "/state",
  asyncHandler(async (_req, res) => {
    res.json(await getAuthState());
  }),
);

/**
 * 重试连接：session 被判失效后，如果其实只是「重启时新旧连接撞车」，
 * 点一下就能恢复，不必重新扫码。
 */
authRouter.post(
  "/retry",
  asyncHandler(async (_req, res) => {
    try {
      const auth = await retrySession();
      res.json({ ok: auth.authorized, auth });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message, auth: await getAuthState({ fresh: true }) });
    }
  }),
);

/**
 * 彻底重置登录状态：清掉本地 session、备份与失效标记。
 *
 * 服务器端已把 authKey 作废时（AUTH_KEY_UNREGISTERED / SESSION_REVOKED 等），
 * 重试连接没有意义，必须重新登录。而重新登录前又需要先清干净本地那份旧凭据，
 * 否则新旧凭据会互相打架。这个接口就是给「彻底重置并重新登录」按钮用的。
 */
authRouter.post(
  "/reset",
  asyncHandler(async (_req, res) => {
    await resetSessionForRelogin();
    res.json({ ok: true, auth: await getAuthState({ fresh: true }) });
  }),
);

/* ---------------- 扫码登录 ---------------- */

authRouter.post(
  "/qr/start",
  asyncHandler(async (_req, res) => {
    const state = await startQrLogin();
    res.json(await withImage(state));
  }),
);

authRouter.get(
  "/qr/state",
  asyncHandler(async (_req, res) => {
    const state = getQrState();
    const payload = await withImage(state);
    const auth = state.status === "success" ? await getAuthState() : undefined;
    res.json({ ...payload, auth });
  }),
);

authRouter.post(
  "/qr/password",
  asyncHandler(async (req, res) => {
    const password = String(req.body?.password ?? "");
    assert(password, 400, "请输入两步验证密码");
    const state = submitQrPassword(password);
    res.json({ ok: true, ...(await withImage(state)) });
  }),
);

authRouter.post(
  "/qr/cancel",
  asyncHandler(async (_req, res) => {
    cancelQrLogin();
    res.json({ ok: true });
  }),
);

/* ---------------- 手机号 + 验证码 ---------------- */

authRouter.post(
  "/send-code",
  asyncHandler(async (req, res) => {
    const phone = String(req.body?.phone ?? "");
    assert(phone, 400, "请填写手机号（含国际区号，如 +8613800000000）");
    const result = await requestLoginCode(phone);
    res.json({ ok: true, phoneCodeHash: result.phoneCodeHash });
  }),
);

authRouter.post(
  "/sign-in",
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code ?? "").trim();
    assert(/^\d{3,8}$/.test(code), 400, "验证码格式不正确");
    const result = await submitLoginCode(code);
    res.json({ ok: true, ...result, auth: await getAuthState() });
  }),
);

authRouter.post(
  "/password",
  asyncHandler(async (req, res) => {
    const password = String(req.body?.password ?? "");
    assert(password, 400, "请输入两步验证密码");
    await submitPassword(password);
    res.json({ ok: true, auth: await getAuthState() });
  }),
);

authRouter.post(
  "/session",
  asyncHandler(async (req, res) => {
    const session = String(req.body?.session ?? "").trim();
    assert(session.length > 20, 400, "session 内容不正确");
    await importSession(session);
    res.json({ ok: true, auth: await getAuthState() });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (_req, res) => {
    await logout();
    res.json({ ok: true });
  }),
);
