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
    res.status(201).json({
      ok: true,
      username: result.account.username,
      expiresAt: result.expiresAt,
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
    res.json({ ok: true, username: result.username, expiresAt: result.expiresAt });
  }),
);

sessionRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    destroySession(req);
    clearCookie(req, res);
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
    res.json({ ok: true, username: result.account.username });
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
