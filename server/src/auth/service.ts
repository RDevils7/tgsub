import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { db, getSetting, setSetting } from "../db";
import { env } from "../env";
import { HttpError } from "../lib/http";
import { logger } from "../logger";
import { parseCookie } from "./cookie";
import {
  confirmProblem,
  hashPassword,
  passwordProblem,
  usernameProblem,
  verifyPassword,
} from "./password";

/**
 * 管理界面登录（单账号）。
 *
 * 这个项目和「多租户后台」无关：一台机器、一个下载器、一个主人。
 * 所以不做用户表、不做角色、不做注册 —— 只存一组账号密码，
 * 首次打开时强制设置，之后凭 cookie 进来的才看得到界面。
 *
 * 三个安全决定值得记下来：
 *
 * 1) cookie 只存随机串，库里存它的 sha256。库文件泄漏也换不出可用凭据。
 * 2) 会话落数据库而不是内存。升级镜像 = 容器重建，内存会话会让所有人重登一次，
 *    而「升级就要重新登录」正是用户最烦的那种小摩擦。
 * 3) 忘了密码有两条逃生路：AUTH_DISABLED=1 临时启动、或在容器里删掉 account 行
 *    重新初始化。没有这两条，单账号登录就等于给用户上了一把可能永久锁死的锁。
 */

export const COOKIE_NAME = "tgsub_sid";

const KEY_USER = "login_user";
const KEY_HASH = "login_hash";
const KEY_SINCE = "login_since";

const DAY = 24 * 60 * 60 * 1000;
const REMEMBER_DAYS = 30;
const SESSION_HOURS = 12;

/* ------------------------------------------------------------------ */
/* 账号                                                                */
/* ------------------------------------------------------------------ */

export interface AccountInfo {
  username: string;
  since: number;
}

function readAccountHash(): string {
  return getSetting(KEY_HASH) || "";
}

export function getAccount(): AccountInfo | null {
  const username = getSetting(KEY_USER) || "";
  const hash = readAccountHash();
  if (!username || !hash) return null;
  return { username, since: Number(getSetting(KEY_SINCE) || 0) };
}

export function isConfigured(): boolean {
  return getAccount() !== null;
}

/**
 * 首次初始化：只在还没有账号时可用。
 *
 * 这里刻意不校验「请求是不是来自本机」：私有部署常见于 NAS / 反代后面，
 * 真实客户端 IP 未必可信。取而代之的是「只能设置一次」——
 * 一旦配好，任何人不带 cookie 都调不动这个接口。
 */
export async function setupAccount(input: {
  username: unknown;
  password: unknown;
  confirm?: unknown;
}): Promise<{ account: AccountInfo; token: string; expiresAt: number }> {
  if (isConfigured()) throw new HttpError(409, "管理员账号已设置，请直接登录");

  const userIssue = usernameProblem(input.username);
  if (userIssue) throw new HttpError(400, userIssue);
  const pwdIssue = passwordProblem(input.password);
  if (pwdIssue) throw new HttpError(400, pwdIssue);
  if (input.confirm !== undefined) {
    const mismatch = confirmProblem(input.password, input.confirm);
    if (mismatch) throw new HttpError(400, mismatch);
  }

  const username = String(input.username).trim();
  const hash = await hashPassword(String(input.password));
  setSetting(KEY_USER, username);
  setSetting(KEY_HASH, hash);
  setSetting(KEY_SINCE, String(Date.now()));
  logger.info({ username }, "已设置管理界面登录账号");

  const session = createSession(username, true);
  return { account: { username, since: Date.now() }, ...session };
}

/** 修改账号 / 密码：必须先验证当前密码 */
export async function updateAccount(input: {
  currentPassword: unknown;
  username?: unknown;
  newPassword?: unknown;
  confirm?: unknown;
}): Promise<{ account: AccountInfo; token: string; expiresAt: number }> {
  const account = getAccount();
  if (!account) throw new HttpError(409, "尚未设置管理员账号");

  // AUTH_DISABLED 是「忘记密码」的唯一出口，那时旧密码压根不知道，
  // 必须跳过校验；此时登录本来就是关的，跳过不会多开一道口子。
  if (!env.authDisabled) {
    const ok = await verifyPassword(String(input.currentPassword ?? ""), readAccountHash());
    if (!ok) throw new HttpError(400, "当前密码不正确", "BAD_PASSWORD");
  }

  let nextUser = account.username;
  if (input.username !== undefined && String(input.username).trim() !== account.username) {
    const userIssue = usernameProblem(input.username);
    if (userIssue) throw new HttpError(400, userIssue);
    nextUser = String(input.username).trim();
  }

  const wantsNewPassword = input.newPassword !== undefined && String(input.newPassword) !== "";
  let nextHash = readAccountHash();
  if (wantsNewPassword) {
    const pwdIssue = passwordProblem(input.newPassword);
    if (pwdIssue) throw new HttpError(400, pwdIssue);
    if (input.confirm !== undefined) {
      const mismatch = confirmProblem(input.newPassword, input.confirm);
      if (mismatch) throw new HttpError(400, mismatch);
    }
    nextHash = await hashPassword(String(input.newPassword));
  }

  if (nextUser === account.username && nextHash === readAccountHash()) {
    throw new HttpError(400, "用户名和密码都没有变化");
  }

  setSetting(KEY_USER, nextUser);
  setSetting(KEY_HASH, nextHash);
  // 改完凭据，其它设备上的旧会话必须立刻失效：改密码的动机通常是「别人也登着」
  db.prepare("DELETE FROM login_sessions").run();
  logger.info({ username: nextUser, passwordChanged: wantsNewPassword }, "管理账号已更新");

  // 给当前这台设备补一张新会话，否则刚保存就被自己的中间件踢到登录页
  const session = createSession(nextUser, true);
  return { account: { username: nextUser, since: account.since }, ...session };
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSession(username: string, remember: boolean, req?: Request): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const ttl = remember ? REMEMBER_DAYS * DAY : SESSION_HOURS * 60 * 60 * 1000;
  const expiresAt = now + ttl;

  db.prepare(
    "INSERT INTO login_sessions(token_hash, username, created_at, expires_at, last_seen, ip, ua) VALUES(?,?,?,?,?,?,?)",
  ).run(hashToken(token), username, now, expiresAt, now, clientIp(req), String(req?.headers["user-agent"] ?? "").slice(0, 300));

  // 每次登录顺手清掉过期会话，不用额外的定时器
  db.prepare("DELETE FROM login_sessions WHERE expires_at < ?").run(now);

  return { token, expiresAt };
}

export function readCookie(req: Request, name: string): string {
  return parseCookie(req.headers.cookie, name);
}

export interface SessionInfo {
  username: string;
  createdAt: number;
  expiresAt: number;
}

/** 校验当前请求的 cookie；顺带节流更新 last_seen（每 5 分钟一次足够） */
export function currentSession(req: Request): SessionInfo | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;

  const row = db
    .prepare("SELECT username, created_at, expires_at, last_seen FROM login_sessions WHERE token_hash = ?")
    .get(hashToken(token)) as
    | { username: string; created_at: number; expires_at: number; last_seen: number }
    | undefined;
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now) {
    db.prepare("DELETE FROM login_sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  if (now - row.last_seen > 5 * 60 * 1000) {
    db.prepare("UPDATE login_sessions SET last_seen = ? WHERE token_hash = ?").run(now, hashToken(token));
  }
  return { username: row.username, createdAt: row.created_at, expiresAt: row.expires_at };
}

export function destroySession(req: Request): void {
  const token = readCookie(req, COOKIE_NAME);
  if (token) db.prepare("DELETE FROM login_sessions WHERE token_hash = ?").run(hashToken(token));
}

export function destroyAllSessions(): number {
  return db.prepare("DELETE FROM login_sessions").run().changes;
}

/** 只保留当前这台设备的会话（「退出其它设备」） */
export function destroyOtherSessions(req: Request): number {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return destroyAllSessions();
  return db.prepare("DELETE FROM login_sessions WHERE token_hash <> ?").run(hashToken(token)).changes;
}

export function activeSessionCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM login_sessions WHERE expires_at > ?").get(Date.now()) as { n: number }
  ).n;
}

/* ------------------------------------------------------------------ */
/* 失败限流                                                            */
/* ------------------------------------------------------------------ */

const failures = new Map<string, { count: number; until: number; last: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

function clientIp(req?: Request): string {
  if (!req) return "";
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "";
}

function checkLock(ip: string): void {
  const entry = failures.get(ip);
  if (!entry) return;
  if (entry.until > Date.now()) {
    const mins = Math.ceil((entry.until - Date.now()) / 60000);
    throw new HttpError(429, `密码错误次数过多，请 ${mins} 分钟后再试`, "TOO_MANY_ATTEMPTS");
  }
  if (Date.now() - entry.last > LOCK_MS) failures.delete(ip);
}

function noteFailure(ip: string): void {
  const now = Date.now();
  const entry = failures.get(ip) ?? { count: 0, until: 0, last: now };
  entry.count += 1;
  entry.last = now;
  if (entry.count >= MAX_FAILURES) entry.until = now + LOCK_MS;
  failures.set(ip, entry);
  // 顺手清一下长期没动静的条目，避免 Map 无限涨
  if (failures.size > 500) {
    for (const [key, value] of failures) if (now - value.last > LOCK_MS) failures.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

export async function login(
  req: Request,
  input: { username: unknown; password: unknown; remember?: unknown },
): Promise<{ token: string; expiresAt: number; username: string }> {
  const account = getAccount();
  if (!account) throw new HttpError(409, "尚未设置管理员账号", "NOT_CONFIGURED");

  const ip = clientIp(req);
  checkLock(ip);

  const username = String(input.username ?? "").trim();
  const password = String(input.password ?? "");
  if (!username || !password) throw new HttpError(400, "请输入用户名和密码");

  // 用户名与密码各自校验，但对外的错误提示统一成一句话：
  // 「用户名不存在」和「密码错误」分开说，等于免费告诉爆破者哪一半猜对了
  const userOk = username === account.username;
  const passOk = await verifyPassword(password, readAccountHash());
  if (!userOk || !passOk) {
    noteFailure(ip);
    const left = MAX_FAILURES - (failures.get(ip)?.count ?? 0);
    throw new HttpError(
      401,
      left > 0 ? `用户名或密码不正确（还可尝试 ${left} 次）` : "用户名或密码不正确，账号已临时锁定 5 分钟",
      "BAD_CREDENTIALS",
    );
  }

  failures.delete(ip);
  const session = createSession(account.username, Boolean(input.remember), req);
  logger.info({ username: account.username, ip, remember: Boolean(input.remember) }, "管理界面登录成功");
  return { ...session, username: account.username };
}

export function writeCookie(req: Request, res: Response, token: string, expiresAt: number, remember: boolean): void {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] ?? "").startsWith("https");
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    // 不勾「保持登录」时给会话 cookie（关浏览器即失效），勾了才落盘 30 天
    ...(remember ? { maxAge: Math.max(0, expiresAt - Date.now()) } : {}),
  });
}

export function clearCookie(req: Request, res: Response): void {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] ?? "").startsWith("https");
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", path: "/", secure });
}

/* ------------------------------------------------------------------ */
/* 中间件                                                              */
/* ------------------------------------------------------------------ */

/** 不需要登录就能访问的接口：探活、登录自身 */
function isPublicApi(path: string): boolean {
  return path === "/health" || path === "/version" || path === "/session" || path.startsWith("/session/");
}

/**
 * 保护所有 /api 接口。
 *
 * 只保护接口、不保护静态资源：登录页本身就在静态资源里，
 * 把 index.html 也挡住的话连登录框都加载不出来。
 */
export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (env.authDisabled) {
    next();
    return;
  }
  if (isPublicApi(req.path)) {
    next();
    return;
  }
  if (currentSession(req)) {
    next();
    return;
  }
  res.status(401).json({
    error: isConfigured() ? "请先登录" : "尚未设置管理员账号",
    code: isConfigured() ? "LOGIN_REQUIRED" : "SETUP_REQUIRED",
  });
}
