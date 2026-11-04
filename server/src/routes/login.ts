import { Router } from "express";
import type { Request, Response } from "express";
import { asyncHandler } from "../lib/http";
import { env } from "../env";
import {
  activeSessionCount,
  clearCookie,
  currentSession,
  destroyOtherSessions,
  destroySession,
  getAccount,
  login,
  setupAccount,
  updateAccount,
  writeCookie,
} from "../auth/service";

/**
 * 管理界面登录接口（挂 /api/session）。
 *
 * 和 /api/auth 不是一回事：那个是登录 Telegram 账号，这里是登录 tgsub 自己。
 * 两条链路互不相干 —— 前者未登录只影响能不能下载，后者未登录连界面都看不到。
 */
export const sessionRouter = Router();

function withCookie(req: Request, res: Response, payload: { token: string; expiresAt: number }, remember: boolean) {
  writeCookie(req, res, payload.token, payload.expiresAt, remember);
}

/**
 * 登录类响应统一带上 token，并且一律不缓存。
 *
 * 为什么响应体里也给 token：有些环境根本存不住 cookie —— 浏览器隐私设置拦掉、
 * 嵌在沙箱 iframe 里（opaque origin）、或者反向代理把 Set-Cookie 吞了。
 * 这种时候前端把 token 放 `X-Tgsub-Session` 头里照样能进，
 * 总比「点登录没反应、一直回登录页」好。
 */
function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

/**
 * 界面启动时第一个请求。
 *
 * 三种状态一次说清：还没设置账号（引导初始化）、设置了但没登录（显示登录框）、
 * 已登录（进主界面）。前端不用自己猜。
 */
sessionRouter.get(
  "/state",
  asyncHandler(async (req, res) => {
    const account = getAccount();
    const session = currentSession(req);
    noStore(res);
    res.json({
      configured: Boolean(account),
      authenticated: Boolean(session) || env.authDisabled,
      authDisabled: env.authDisabled,
      username: account?.username ?? null,
      since: account?.since ?? null,
      session: session
        ? { expiresAt: session.expiresAt, createdAt: session.createdAt }
        : null,
      devices: session ? activeSessionCount() : 0,
    });
  }),
);

/** 首次初始化：设置管理员账号，成功后直接登录，不用再输一遍 */
sessionRouter.post(
  "/setup",
  asyncHandler(async (req, res) => {
    const result = await setupAccount({
      username: req.body?.username,
      password: req.body?.password,
      confirm: req.body?.confirm,
    });
    withCookie(req, res, result, true);
    noStore(res);
    res.status(201).json({
      ok: true,
      username: result.account.username,
      expiresAt: result.expiresAt,
      token: result.token,
    });
  }),
);

sessionRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const remember = Boolean(req.body?.remember);
    const result = await login(req, {
      username: req.body?.username,
      password: req.body?.password,
      remember,
    });
    withCookie(req, res, result, remember);
    noStore(res);
    res.json({ ok: true, username: result.username, expiresAt: result.expiresAt, token: result.token });
  }),
);

sessionRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    destroySession(req);
    clearCookie(req, res);
    noStore(res);
    res.json({ ok: true });
  }),
);

/** 修改用户名 / 密码（需已登录，且要验证当前密码） */
sessionRouter.put(
  "/account",
  asyncHandler(async (req, res) => {
    const result = await updateAccount({
      currentPassword: req.body?.currentPassword,
      username: req.body?.username,
      newPassword: req.body?.newPassword,
      confirm: req.body?.confirm,
    });
    // updateAccount 内部已经把其它设备的旧会话清干净，并给当前设备补发了新会话
    withCookie(req, res, result, true);
    noStore(res);
    res.json({ ok: true, username: result.account.username, token: result.token, expiresAt: result.expiresAt });
  }),
);

/** 踢掉所有其它设备（保留当前这台） */
sessionRouter.post(
  "/logout-others",
  asyncHandler(async (req, res) => {
    const removed = destroyOtherSessions(req);
    res.json({ ok: true, removed });
  }),
);
