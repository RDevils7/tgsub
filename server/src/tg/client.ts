import crypto from "node:crypto";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import {
  db,
  getSession,
  getSessionBackup,
  getSessionMeta,
  getSetting,
  getSettings,
  setSession,
  setSetting,
  clearSession,
  markSessionInvalid,
  markSessionValid,
} from "../db";
import { getBuiltinApp, type BuiltinApp } from "./credentials";
import type { CredentialMode } from "../types";
import { logger } from "../logger";

export class TgError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AuthState {
  configured: boolean;
  connected: boolean;
  authorized: boolean;
  me: { id: string; username: string | null; firstName: string | null } | null;
  pendingCode: boolean;
  error: string | null;
  /** 最近一次验证通过并落库的时间（重启后仍然读得到） */
  sessionSavedAt: number | null;
  /** ok=有可用 session；dead=被服务器判死，需要重新登录；none=从未登录 */
  sessionState: "ok" | "dead" | "none";
  /** session 是否已加密落盘（登录一次即可跨重启复用） */
  sessionPersisted: boolean;
}

/** 这些错误码代表 authKey 在服务器端已不可用 */
const DEAD_SESSION_ERRORS = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_DUPLICATED",
  "AUTH_KEY_PERM_EMPTY",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED_BAN",
]);

/**
 * 这两个错误在「重启时旧进程连接尚未释放」的场景下也会出现：
 * 两个连接共用一个 authKey，服务器先回 AUTH_KEY_DUPLICATED。
 * 此时立刻判死会逼用户重新扫码，而旧连接通常几秒内就会断开，
 * 所以先退避重试几轮，仍然失败才算真的失效。
 */
const RETRYABLE_SESSION_ERRORS = new Set(["AUTH_KEY_DUPLICATED", "AUTH_KEY_UNREGISTERED"]);

/** 重试间隔：总等待约 5.5 秒，覆盖进程退出/网络抖动窗口，又不会让界面卡太久 */
const CONNECT_RETRY_DELAYS = [1500, 4000];

/**
 * 连接掉线后等待 gramjs 自动重连的宽限期。
 *
 * 关键教训：连接抖动时如果立刻「销毁旧 client + 用同一个 session 新建 client」，
 * 旧 socket 在服务器端可能还活着，两条连接共用一个 authKey ->
 * 服务器回 AUTH_KEY_DUPLICATED 并作废整个 key，结果就是必须重新扫码。
 * 宽限期内交给 gramjs 自己重连，能彻底避开这个窗口。
 */
const RECONNECT_GRACE_MS = 10_000;

async function waitConnected(client: TelegramClient, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (client.connected) return true;
    await sleep(250);
  }
  return Boolean(client.connected);
}

interface PendingLogin {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  apiId: number;
  apiHash: string;
  createdAt: number;
}

let activeClient: TelegramClient | null = null;
let pending: PendingLogin | null = null;
let lastError: string | null = null;
let connecting: Promise<TelegramClient> | null = null;
let cachedMe: AuthState["me"] = null;

const PENDING_TTL_MS = 10 * 60 * 1000;

function parseIntOrThrow(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new TgError("BAD_CONFIG", `${label} 无效`);
  return n;
}

/** 解析 socks5://user:pass@host:port 或 host:port */
function buildProxy(raw: string) {
  const value = raw.trim();
  if (!value) return undefined;
  try {
    const withScheme = value.includes("://") ? value : `socks5://${value}`;
    const url = new URL(withScheme);
    if (!url.protocol.startsWith("socks")) {
      throw new TgError("BAD_PROXY", "仅支持 SOCKS5 代理（例如 socks5://127.0.0.1:7897）");
    }
    const port = Number(url.port || 1080);
    return {
      ip: url.hostname,
      port,
      socksType: 5 as const,
      username: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
      timeout: 15,
    };
  } catch (err) {
    if (err instanceof TgError) throw err;
    throw new TgError("BAD_PROXY", "代理地址格式不正确，应为 socks5://host:port");
  }
}

interface ResolvedCredentials {
  apiId: number;
  apiHash: string;
  device: BuiltinApp["device"];
  mode: CredentialMode;
  label: string;
}

/**
 * 解析当前生效的应用凭证。
 * 内置模式不依赖用户填写的 api_id/api_hash，因此无需访问 my.telegram.org。
 */
function requireCredentials(): ResolvedCredentials {
  const s = getSettings();
  if (s.credential_mode === "custom") {
    if (!s.api_id || !s.api_hash) {
      throw new TgError("NOT_CONFIGURED", "尚未填写 API ID / API Hash，可切换为「内置凭证」免申请使用");
    }
    return {
      apiId: parseIntOrThrow(s.api_id, "API ID"),
      apiHash: s.api_hash.trim(),
      device: getBuiltinApp("desktop").device,
      mode: "custom",
      label: "自定义应用",
    };
  }
  const app = getBuiltinApp(s.builtin_app);
  return { apiId: app.apiId, apiHash: app.apiHash, device: app.device, mode: "builtin", label: app.label };
}

/** 供机器人复用同一套应用凭证与代理配置 */
export function getAppCredentials(): { apiId: number; apiHash: string } {
  const cred = requireCredentials();
  return { apiId: cred.apiId, apiHash: cred.apiHash };
}

/** 供机器人复用当前代理设置 */
export function currentProxy(): ReturnType<typeof buildProxy> {
  return buildProxy(getSettings().proxy_url);
}

function createClient(session: string, cred: ResolvedCredentials): TelegramClient {
  const settings = getSettings();
  return new TelegramClient(new StringSession(session), cred.apiId, cred.apiHash, {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    requestRetries: 3,
    timeout: 30000,
    useWSS: false,
    // 设备指纹必须与凭证声明的平台一致，否则「平台不匹配」本身就是风控信号
    deviceModel: cred.device.deviceModel,
    systemVersion: cred.device.systemVersion,
    appVersion: cred.device.appVersion,
    langCode: cred.device.langCode,
    systemLangCode: cred.device.systemLangCode,
    proxy: buildProxy(settings.proxy_url),
  });
}

/**
 * 收紧 gramjs 的自动重连节奏。
 *
 * 实测：本机经 SOCKS 代理连 Telegram，updates 心跳的 ping 会周期性 10s 超时，
 * gramjs 每次超时都会 `_sender.reconnect()` —— 关掉旧 socket，1 秒后重开一条连接。
 * 但服务器侧未必那么快回收旧连接，于是同一个 authKey 上出现两条连接，
 * Telegram 回 AUTH_KEY_DUPLICATED 并永久作废这个 key，表现就是「莫名其妙又要重新扫码」。
 *
 * 这里把重连改成延迟 + 递增退避，给服务器足够时间回收旧连接，
 * 同时把每次重连记进日志，方便判断到底是网络抖动还是账号侧问题。
 */
const RECONNECT_BASE_DELAY_MS = 4000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_RESET_MS = 180_000;

function hardenReconnect(client: TelegramClient): void {
  const sender = (client as unknown as { _sender?: Record<string, unknown> })._sender as
    | (Record<string, unknown> & { reconnect: () => void; isReconnecting?: boolean })
    | undefined;
  if (!sender || typeof sender.reconnect !== "function" || sender.__tgsubHardened) return;
  sender.__tgsubHardened = true;

  const original = sender.reconnect.bind(sender);
  let pending: NodeJS.Timeout | null = null;
  let strikes = 0;
  let lastAt = 0;

  sender.reconnect = () => {
    if (pending) return;
    const now = Date.now();
    if (now - lastAt > RECONNECT_RESET_MS) strikes = 0;
    lastAt = now;
    strikes += 1;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * strikes, RECONNECT_MAX_DELAY_MS);
    logger.warn({ fp: keyFingerprint(client), strikes, delayMs: delay }, "连接异常，延迟重连");
    // 自己先占住「重连中」标志：让心跳跳过、避免请求继续压在死连接上
    sender.isReconnecting = true;
    pending = setTimeout(() => {
      pending = null;
      sender.isReconnecting = false;
      original();
    }, delay);
    pending.unref?.();
  };
}

/** 统一入口：连上之后立刻加装重连节流 */
async function connectTelegram(client: TelegramClient): Promise<void> {
  await client.connect();
  hardenReconnect(client);
}

export function isConfigured(): boolean {
  const s = getSettings();
  if (s.credential_mode === "custom") return Boolean(s.api_id && s.api_hash);
  return true;
}

export async function getClient(opts: { force?: boolean } = {}): Promise<TelegramClient> {
  if (!isConfigured()) {
    throw new TgError("NOT_CONFIGURED", "尚未配置 Telegram API ID / API Hash");
  }
  if (activeClient?.connected) return activeClient;
  if (activeClient) {
    // 连接掉了：先给 gramjs 的 autoReconnect 一点时间，不要急着重连。
    // 旧 socket 在服务器端还没释放时新建连接 = 同 authKey 双连接 = key 被作废。
    const recovered = await waitConnected(activeClient, RECONNECT_GRACE_MS);
    if (recovered) {
      logger.info({ fp: keyFingerprint(activeClient) }, "连接已由客户端自动恢复");
      try {
        const probe = await probeAuthorization(activeClient);
        if (probe.ok) {
          markSessionValid();
          probeCache = null;
          return activeClient;
        }
      } catch (err) {
        // 网络还没通：保留 session，别在这里重建连接
        throw new TgError("NETWORK", `连接 Telegram 失败：${errText(err)}`);
      }
    }
    // 确实没恢复（socket 已关闭），此时销毁重建是安全的
    logger.warn({ fp: keyFingerprint(activeClient) }, "连接在宽限期内未恢复，重建客户端");
    await activeClient.disconnect().catch(() => undefined);
    activeClient = null;
  }
  if (connecting) return connecting;

  // 已判定失效、用户还没重新登录：直接拒绝，避免每个请求都白等一轮重试
  if (!opts.force && getSetting("session_state") === "dead") {
    throw new TgError("NOT_AUTHORIZED", "登录状态已失效，请重新登录");
  }

  const cred = requireCredentials();
  let session = getSession();
  let usingBackup = false;
  if (!session) {
    const backup = getSessionBackup();
    if (backup) {
      session = backup;
      usingBackup = true;
      logger.warn("主 session 不可用，改用备份 session 尝试恢复登录");
    }
  }
  if (!session) {
    throw new TgError("NOT_AUTHORIZED", "尚未登录 Telegram 账号");
  }

  connecting = (async () => {
    let lastCode: string | null = null;

    for (let attempt = 0; attempt <= CONNECT_RETRY_DELAYS.length; attempt++) {
      const client = createClient(session, cred);
      try {
        await connectTelegram(client);
      } catch (err) {
        await client.disconnect().catch(() => undefined);
        logger.warn({ err: errText(err) }, "连接 Telegram 网络异常，保留本地 session");
        throw new TgError("NETWORK", `连接 Telegram 失败：${errText(err)}`);
      }

      const fp = keyFingerprint(client);
      let probe: { ok: boolean; code: string | null };
      try {
        probe = await probeAuthorization(client);
      } catch (err) {
        // 网络/代理抖动：保留 session。误判为失效会逼用户重新登录，代价远高于报错
        await client.disconnect().catch(() => undefined);
        logger.warn({ fp, err: errText(err) }, "连接 Telegram 网络异常，保留本地 session");
        throw new TgError("NETWORK", `连接 Telegram 失败：${errText(err)}`);
      }

      if (probe.ok) {
        activeClient = client;
        lastError = null;
        markSessionValid();
        if (usingBackup) {
          // 备份跑通了就把它提升为主记录，下次启动直接命中最新的那份
          setSession(session);
          logger.info({ fp }, "备份 session 验证通过，已提升为主记录");
        }
        logger.info({ fp }, "Telegram 客户端已连接");
        return client;
      }

      lastCode = probe.code;
      await client.disconnect().catch(() => undefined);

      const retryable =
        lastCode !== null && RETRYABLE_SESSION_ERRORS.has(lastCode) && attempt < CONNECT_RETRY_DELAYS.length;
      if (!retryable) break;
      const delay = CONNECT_RETRY_DELAYS[attempt];
      logger.warn(
        { fp, code: lastCode, attempt: attempt + 1, delay },
        "authKey 暂时不可用（多见于重启时新旧连接短暂重叠），稍后重试",
      );
      await sleep(delay);
    }

    // 重试用尽仍然是失效码：只做标记，不删 session，留档便于排查与手动恢复
    markSessionInvalid(lastCode || "UNKNOWN");
    logger.warn(
      { code: lastCode, state: getSessionMeta().state },
      "session 被服务器判定失效，已标记为需重新登录（备份仍保留）",
    );
    throw new TgError("NOT_AUTHORIZED", "登录状态已失效，请重新登录");
  })();

  try {
    return await connecting;
  } catch (err) {
    lastError = (err as Error).message;
    throw err;
  } finally {
    connecting = null;
  }
}

/**
 * 认证心跳：每 45 秒确认一次 session 仍有效。
 *
 * 两个作用：
 * 1. 保活——长时间没有请求时，MTProto 连接容易被代理/中间设备静默掐断；
 * 2. 取证——一旦真的失效，日志里会带上「什么时刻、哪个 authKey、原始错误码」，
 *    避免再出现「只知道要重新扫码，不知道为什么」的情况。
 */
export function startAuthWatchdog(): NodeJS.Timeout {
  let lastSig = "";
  let lastConnected: boolean | null = null;

  // 连接状态监视：只读 client.connected，不发任何请求。
  // 掉线/恢复都留一条日志 —— 下次若再出现「莫名其妙失效」，
  // 日志能直接告诉我们失效前有没有发生过掉线重连。
  const monitor = setInterval(() => {
    const client = activeClient;
    if (!client) {
      lastConnected = null;
      return;
    }
    const now = Boolean(client.connected);
    if (lastConnected !== null && now !== lastConnected) {
      const fp = keyFingerprint(client);
      if (now) logger.info({ fp }, "Telegram 连接已恢复");
      else logger.warn({ fp }, "Telegram 连接断开，等待客户端自动重连");
    }
    lastConnected = now;
  }, 5_000);
  monitor.unref();

  const check = async (): Promise<void> => {
    const client = activeClient;
    if (!client) return;
    if (!client.connected) {
      logger.warn({ fp: keyFingerprint(client) }, "认证心跳跳过：连接当前不可用");
      return;
    }
    const fp = keyFingerprint(client);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const probe = await probeAuthorization(client);
        const sig = `${probe.ok}|${probe.code ?? ""}`;
        if (sig !== lastSig) {
          logger.info({ fp, authorized: probe.ok, code: probe.code }, "认证心跳");
          lastSig = sig;
        }
        if (probe.ok) return;
        if (attempt === 0) {
          await sleep(3000);
          continue;
        }
        invalidateSession(`心跳检测判定失效（${probe.code}）`);
        return;
      } catch (err) {
        // 网络异常不代表失效
        logger.warn({ fp, err: errText(err) }, "认证心跳未收到响应，保留 session");
        return;
      }
    }
  };

  const timer = setInterval(() => void check(), 45_000);
  timer.unref();
  return timer;
}

export async function disconnectClient(): Promise<void> {
  if (activeClient) {
    await activeClient.disconnect().catch(() => undefined);
    activeClient = null;
  }
  if (pending) {
    await pending.client.disconnect().catch(() => undefined);
    pending = null;
  }
  sdkAvailable = undefined;
}

let sdkAvailable: boolean | undefined;

/** 探测 SDK 是否可用（用于健康检查） */
export function sdkLoaded(): boolean {
  if (sdkAvailable === undefined) sdkAvailable = typeof TelegramClient === "function";
  return sdkAvailable === true;
}

/** 探测结果缓存：前端每 10 秒轮询一次，没必要每次都打 getMe 上去 */
const PROBE_CACHE_MS = 8000;
let probeCache: { at: number; ok: boolean; code: string | null } | null = null;

export async function getAuthState(opts: { fresh?: boolean } = {}): Promise<AuthState> {
  const configured = isConfigured();
  let connected = false;
  let authorized = false;
  let me: AuthState["me"] = null;

  if (configured) {
    try {
      const client = await getClient();
      connected = Boolean(client.connected);

      let verified: boolean | null = null;
      let deadCode: string | null = null;
      const cached = !opts.fresh && probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS ? probeCache : null;
      if (cached) {
        verified = cached.ok;
        deadCode = cached.code;
        if (!cached.ok) lastError = `登录状态已失效（${cached.code || "UNKNOWN"}），请重新登录`;
      } else {
        try {
          const probe = await probeAuthorization(client);
          verified = probe.ok;
          deadCode = probe.code;
          probeCache = { at: Date.now(), ok: probe.ok, code: probe.code };
          if (!probe.ok) lastError = `登录状态已失效（${probe.code}），请重新登录`;
        } catch (err) {
          // 网络异常不等于未登录，沿用上次已知状态，避免界面在「已登录/未登录」之间反复跳
          lastError = `网络异常，未能确认登录状态（${errText(err)}）`;
        }
      }

      if (verified === false) {
        logger.warn({ code: deadCode, fp: keyFingerprint(client) }, "探测到 session 已失效");
        invalidateSession(`probe 判定 session 已失效（${deadCode || "UNKNOWN"}）`);
        connected = false;
        authorized = false;
        me = null;
      } else if (verified === true) {
        authorized = true;
        lastError = null;
        if (cachedMe) {
          me = cachedMe;
        } else {
          const self = await client.getMe();
          me = {
            id: String(self.id),
            username: (self as { username?: string }).username ?? null,
            firstName: (self as { firstName?: string }).firstName ?? null,
          };
          cachedMe = me;
        }
      } else {
        // 无法确认：有历史登录信息就认为仍然登录，只是当前连不上
        authorized = Boolean(cachedMe);
        me = cachedMe;
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const meta = getSessionMeta();
  return {
    configured,
    connected,
    authorized,
    me,
    pendingCode: Boolean(pending && Date.now() - pending.createdAt < PENDING_TTL_MS),
    error: lastError,
    sessionSavedAt: meta.savedAt,
    sessionState: meta.state,
    sessionPersisted: meta.state !== "none",
  };
}

/**
 * 手动重试连接：用于「被判 AUTH_KEY_DUPLICATED 但其实只是重启撞车」的情况。
 * 先彻底断开，再清掉失效标记，强制重新握手。
 */
export async function retrySession(): Promise<AuthState> {
  await disconnectClient();
  markSessionValid();
  probeCache = null;
  lastError = null;
  await getClient({ force: true });
  return getAuthState({ fresh: true });
}


/* ------------------------------------------------------------------ */
/* 登录流程                                                            */
/* ------------------------------------------------------------------ */

/** 解析 PHONE_MIGRATE_X / NETWORK_MIGRATE_X，返回目标 DC */
function migrateDc(err: unknown): number | null {
  const msg = errText(err);
  const m = /^(?:PHONE|NETWORK|USER)_MIGRATE_(\d+)$/.exec(msg.split(":")[0].trim());
  return m ? Number(m[1]) : null;
}

/** gramjs 未处理跨 DC，这里手动切换后重试；_switchDC 是内部 API */
async function switchDc(client: TelegramClient, dcId: number): Promise<void> {
  const current = (client.session as unknown as { dcId?: number }).dcId;
  if (current === dcId) return;
  logger.info({ from: current, dcId }, "账号主 DC 与当前连接不同，切换数据中心");
  await (client as unknown as { _switchDC: (d: number) => Promise<void> })._switchDC(dcId);
  // 记住账号的主 DC，下次登录直接连过去，避免登录过程中再触发一次迁移
  setSetting("account_dc", String(dcId));
}

/** 已知账号主 DC 时，连上就先切过去，让后续请求从第一步就落在正确的 DC */
async function preconnectPreferredDc(client: TelegramClient): Promise<void> {
  const raw = getSetting("account_dc");
  const dcId = Number(raw);
  if (!Number.isInteger(dcId) || dcId <= 0) return;
  try {
    await switchDc(client, dcId);
  } catch (err) {
    logger.warn({ dcId, err: errText(err) }, "预切换 DC 失败，继续使用默认 DC");
  }
}

export async function requestLoginCode(phone: string): Promise<{ phoneCodeHash: string }> {
  const cred = requireCredentials();
  const normalized = phone.trim().replace(/[\s-]/g, "");
  if (!/^\+?\d{6,16}$/.test(normalized)) throw new TgError("BAD_PHONE", "手机号格式不正确，请包含国际区号");

  if (activeClient) {
    await activeClient.disconnect().catch(() => undefined);
    activeClient = null;
  }

  const client = createClient("", cred);
  await connectTelegram(client);
  await preconnectPreferredDc(client);

  let phoneCodeHash: string;
  try {
    ({ phoneCodeHash } = await client.sendCode({ apiId: cred.apiId, apiHash: cred.apiHash }, normalized));
  } catch (err) {
    // 账号主 DC 不在当前连接上：切过去再发一次
    const dc = migrateDc(err);
    if (!dc) throw err;
    await switchDc(client, dc);
    const resent = (await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: normalized,
        apiId: cred.apiId,
        apiHash: cred.apiHash,
        settings: new Api.CodeSettings({}),
      }),
    )) as Api.auth.SentCode;
    phoneCodeHash = resent.phoneCodeHash;
  }

  pending = {
    client,
    phone: normalized,
    phoneCodeHash,
    apiId: cred.apiId,
    apiHash: cred.apiHash,
    createdAt: Date.now(),
  };
  logger.info({ phone: normalized.slice(0, 4) + "***" }, "已发送登录验证码");
  return { phoneCodeHash };
}

function needsPassword(err: unknown): boolean {
  const msg = (err as { errorMessage?: string; message?: string })?.errorMessage
    || (err as Error)?.message
    || "";
  return msg.includes("SESSION_PASSWORD_NEEDED");
}

function requirePending(): PendingLogin {
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw new TgError("NO_PENDING_LOGIN", "验证码已过期，请重新获取");
  }
  return pending;
}

function getComputeCheck(): ((pwd: unknown, password: string) => Promise<unknown>) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("telegram/Password");
    if (typeof mod.computeCheck === "function") return mod.computeCheck;
    if (mod.Password && typeof mod.Password.computeCheck === "function") return mod.Password.computeCheck;
  } catch {
    /* ignore */
  }
  return null;
}

/** 取 session 中 authKey 的短指纹，便于跨次登录对比排查 */
function keyFingerprint(client: TelegramClient): string {
  const s = client.session as unknown as {
    authKey?: { getKey?: () => Buffer | undefined };
    dcId?: number;
  };
  const key = s.authKey?.getKey?.();
  const fp = key && key.length ? crypto.createHash("sha256").update(key).digest("hex").slice(0, 12) : "none";
  return `dc${s.dcId ?? "?"}/${fp}`;
}

/**
 * 登录收尾：**先向服务器验证，再落库**。
 *
 * 真正踩过的坑：扫码登录可能走到 LoginTokenMigrateTo → 换 DC → ImportLoginToken，
 * 此时 client 内部已经换成新 DC 的 authKey，但如果服务器端没完成绑定，
 * session.save() 依然会返回一个结构完整（256 字节 key）但实际是废的 session。
 * 这种 session 落库后，用户看到「登录成功」，随后任何操作都报 AUTH_KEY_UNREGISTERED。
 * 所以这里必须先 getMe() 证明真的授权成功，否则一律不写库。
 */
async function finalizeLogin(client: TelegramClient, source: string): Promise<void> {
  const fp = keyFingerprint(client);
  let me;
  try {
    me = await client.getMe();
  } catch (err) {
    const msg = errText(err);
    logger.warn({ source, fp, err: msg }, "登录后校验失败，session 未保存");
    throw new TgError(
      "LOGIN_UNVERIFIED",
      `登录未生效（${msg}），session 已丢弃，请重新扫码或改用手机号登录`,
    );
  }

  const session = (client.session as StringSession).save();
  if (!session) {
    logger.warn({ source, fp }, "session 序列化结果为空，未保存");
    throw new TgError("LOGIN_UNVERIFIED", "无法保存登录状态，请重试");
  }

  setSession(session);
  activeClient = client;
  pending = null;
  lastError = null;
  probeCache = null;
  cachedMe = {
    id: String(me.id),
    username: (me as { username?: string }).username ?? null,
    firstName: (me as { firstName?: string }).firstName ?? null,
  };
  logger.info({ source, fp, userId: String(me.id) }, "Telegram 登录成功，session 已加密保存");
}

/** 登录状态在服务器端已失效：标记并断开，让前端拿到明确的「请重新登录」 */
export function invalidateSession(reason: string): void {
  logger.warn({ reason }, "登录状态失效，已标记为需重新登录（session 与备份保留在库中）");
  markSessionInvalid(reason);
  cachedMe = null;
  probeCache = null;
  lastError = "登录状态已失效，请重新登录";
  const client = activeClient;
  activeClient = null;
  void client?.disconnect().catch(() => undefined);
}

function isDeadSessionError(err: unknown): boolean {
  const code = errText(err).split(":")[0].trim();
  return DEAD_SESSION_ERRORS.has(code);
}

/**
 * 判断客户端当前是否处于登录状态。
 *
 * 不能用 gramjs 的 `checkAuthorization()`：它的实现是 `try { invoke } catch (e) { return false }`，
 * 任何异常（包括代理抖动导致的 TIMEOUT）都会被当成「未授权」，
 * 曾因此把一个刚验证通过、完全正常的 session 判死并清库。
 * 这里改成显式区分：只有拿到失效类错误码才算失效，网络错误原样抛出。
 */
async function probeAuthorization(client: TelegramClient): Promise<{ ok: boolean; code: string | null }> {
  try {
    await client.getMe();
    return { ok: true, code: null };
  } catch (err) {
    if (isDeadSessionError(err)) {
      const code = errText(err).split(":")[0].trim();
      return { ok: false, code };
    }
    throw err;
  }
}

/**
 * 识别「session 已死」类错误并顺带清理本地状态。
 * 返回 true 表示已处理，调用方应回一个明确的 401，而不是把原始错误码丢给用户。
 */
export function handleDeadSessionError(err: unknown): boolean {
  const msg = errText(err);
  const code = msg.split(":")[0].trim();
  if (!DEAD_SESSION_ERRORS.has(code)) return false;
  invalidateSession(code);
  return true;
}

export async function submitLoginCode(code: string): Promise<{ passwordNeeded: boolean }> {
  const p = requirePending();
  const signIn = () =>
    p.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: p.phone,
        phoneCodeHash: p.phoneCodeHash,
        phoneCode: code.trim(),
      }),
    );

  try {
    try {
      await signIn();
    } catch (err) {
      const dc = migrateDc(err);
      if (!dc) throw err;
      // 换 DC 后 phoneCodeHash 仍然有效，可直接重试
      await switchDc(p.client, dc);
      await signIn();
    }
    await finalizeLogin(p.client, "code");
    return { passwordNeeded: false };
  } catch (err) {
    if (needsPassword(err)) return { passwordNeeded: true };
    const msg = (err as { errorMessage?: string }).errorMessage || (err as Error).message;
    throw new TgError("SIGN_IN_FAILED", msg || "验证码校验失败");
  }
}

export async function submitPassword(password: string): Promise<void> {
  const p = requirePending();
  const computeCheck = getComputeCheck();
  if (!computeCheck) throw new TgError("SDK_ERROR", "当前 SDK 版本不支持两步验证，请改用 session 导入");

  const pwd = await p.client.invoke(new Api.account.GetPassword());
  const check = await computeCheck(pwd, password);
  await p.client.invoke(new Api.auth.CheckPassword({ password: check as Api.TypeInputCheckPasswordSRP }));
  await finalizeLogin(p.client, "password");
}

export async function logout(): Promise<void> {
  logger.warn("收到登出请求：将调用 auth.LogOut 作废当前 authKey");
  try {
    if (activeClient) await activeClient.invoke(new Api.auth.LogOut());
  } catch (err) {
    logger.warn({ err }, "登出请求失败，仍将清除本地 session");
  }
  await disconnectClient();
  cachedMe = null;
  clearSession();
}

/** 导入已有 session（适合已有登录环境的迁移） */
export async function importSession(session: string): Promise<void> {
  const cred = requireCredentials();
  const client = createClient(session.trim(), cred);
  await connectTelegram(client);
  let ok = false;
  try {
    ok = (await probeAuthorization(client)).ok;
  } catch (err) {
    await client.disconnect().catch(() => undefined);
    throw new TgError("NETWORK", `无法验证 session：${errText(err)}`);
  }
  if (!ok) {
    await client.disconnect().catch(() => undefined);
    throw new TgError("BAD_SESSION", "session 无效或已失效");
  }
  await finalizeLogin(client, "import");
}

/* ------------------------------------------------------------------ */
/* 扫码登录（QR Login）                                                 */
/* ------------------------------------------------------------------ */

export type QrStatus = "idle" | "waiting" | "scanned" | "password" | "success" | "error";

export interface QrState {
  active: boolean;
  status: QrStatus;
  /** tg://login?token=... 由前端渲染成二维码 */
  url: string | null;
  expiresAt: number | null;
  error: string | null;
  credentialMode: CredentialMode | null;
  appLabel: string | null;
  passwordHint: string | null;
  elapsedMs: number;
}

interface QrSession {
  client: TelegramClient;
  status: QrStatus;
  url: string | null;
  expiresAt: number | null;
  error: string | null;
  startedAt: number;
  appLabel: string;
  credentialMode: CredentialMode;
  passwordHint: string | null;
  resolvePassword: ((pwd: string) => void) | null;
  firstQr: (() => void) | null;
  detach: (() => void) | null;
}

let qrSession: QrSession | null = null;

/** QR 会话最长存活时间，超时自动收尾，避免僵尸连接 */
const QR_SESSION_TTL_MS = 5 * 60 * 1000;

function errText(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string };
  return e?.errorMessage || e?.message || String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function qrSnapshot(): QrState {
  const s = qrSession;
  if (!s) {
    return {
      active: false,
      status: "idle",
      url: null,
      expiresAt: null,
      error: null,
      credentialMode: null,
      appLabel: null,
      passwordHint: null,
      elapsedMs: 0,
    };
  }
  return {
    active: s.status !== "success" && s.status !== "error",
    status: s.status,
    url: s.url,
    expiresAt: s.expiresAt,
    error: s.error,
    credentialMode: s.credentialMode,
    appLabel: s.appLabel,
    passwordHint: s.passwordHint,
    elapsedMs: Date.now() - s.startedAt,
  };
}

export function getQrState(): QrState {
  if (qrSession && qrSession.status !== "success" && Date.now() - qrSession.startedAt > QR_SESSION_TTL_MS) {
    qrSession.error = "二维码已超时，请重新生成";
    qrSession.status = "error";
  }
  return qrSnapshot();
}

export function cancelQrLogin(): void {
  const s = qrSession;
  if (!s) return;
  qrSession = null;
  s.detach?.();
  if (s.status !== "success") {
    s.client.disconnect().catch(() => undefined);
  }
}

export async function startQrLogin(): Promise<QrState> {
  cancelQrLogin();
  const cred = requireCredentials();

  if (activeClient) {
    await activeClient.disconnect().catch(() => undefined);
    activeClient = null;
  }

  const client = createClient("", cred);
  await connectTelegram(client);
  // 若已知该账号主 DC，先切过去；否则 ExportLoginToken 会返回 LoginTokenMigrateTo，
  // 而登录过程里的中途迁移正是 session 落库后失效的主要怀疑点
  await preconnectPreferredDc(client);

  const session: QrSession = {
    client,
    status: "waiting",
    url: null,
    expiresAt: null,
    error: null,
    startedAt: Date.now(),
    appLabel: cred.label,
    credentialMode: cred.mode,
    passwordHint: null,
    resolvePassword: null,
    firstQr: null,
    detach: null,
  };
  qrSession = session;

  const firstQrReady = new Promise<void>((resolve) => {
    session.firstQr = resolve;
  });

  // 手机扫码后 Telegram 会下发 UpdateLoginToken，用它把状态切到「已扫描」
  const onUpdate = (update: unknown): void => {
    if (qrSession === session && update instanceof Api.UpdateLoginToken) {
      if (session.status === "waiting") session.status = "scanned";
    }
  };
  client.addEventHandler(onUpdate);
  // handler 不主动移除：会话结束后 qrSession !== session，回调自身即为 no-op；
  // 每次扫码都新建 client，旧 client 断连后 handler 随之失效。
  session.detach = null;

  void (async () => {
    try {
      await client.signInUserWithQrCode(
        { apiId: cred.apiId, apiHash: cred.apiHash },
        {
          qrCode: async ({ token, expires }) => {
            if (qrSession !== session) return;
            session.url = `tg://login?token=${token.toString("base64url")}`;
            session.expiresAt = Number(expires) || null;
            session.firstQr?.();
            session.firstQr = null;
          },
          password: async (hint) => {
            if (qrSession !== session) throw new Error("AUTH_USER_CANCEL");
            session.status = "password";
            session.passwordHint = hint ?? null;
            return new Promise<string>((resolve) => {
              session.resolvePassword = resolve;
            });
          },
          onError: async (err) => {
            if (qrSession !== session) return true;
            session.error = errText(err);
            session.status = "error";
            return true;
          },
        },
      );

      if (qrSession !== session) return;
      session.detach?.();
      session.detach = null;
      await finalizeLogin(client, "qr");
      session.status = "success";
      logger.info("扫码登录成功，session 已加密保存");
    } catch (err) {
      if (qrSession !== session) return;
      session.status = "error";
      session.error = errText(err);
      logger.warn({ err: session.error }, "扫码登录失败");
      // 登录未通过校验时不要把半成品 client 留着，下次请求会重新建连
      if (activeClient !== client) await client.disconnect().catch(() => undefined);
    }
  })();

  // 等第一张二维码生成，最多 8 秒，避免前端拿到空 URL
  await Promise.race([firstQrReady, sleep(8000)]);
  return qrSnapshot();
}

export function submitQrPassword(password: string): QrState {
  const s = qrSession;
  if (!s || s.status !== "password" || !s.resolvePassword) {
    throw new TgError("NO_QR_PASSWORD", "当前没有等待两步验证的扫码登录");
  }
  const resolve = s.resolvePassword;
  s.resolvePassword = null;
  s.status = "waiting";
  s.passwordHint = null;
  resolve(password);
  return qrSnapshot();
}

/* ------------------------------------------------------------------ */
/* 频道解析                                                            */
/* ------------------------------------------------------------------ */

export interface ResolvedChannel {
  tgId: string;
  username: string | null;
  title: string;
}

/**
 * 数字输入的频道解析。
 *
 * 用户直接填频道 ID 时，裸号会被 gramjs 当成用户 ID 去查 users.getUsers，
 * 私有频道必然失败。所以先按标记形式（-100<id>）试一次，
 * 确实不是频道（比如本来就是用户 ID）再退回原始数字。
 */
async function resolveEntityInput(
  client: TelegramClient,
  target: string,
  numeric: string | null,
): Promise<unknown> {
  if (!numeric) return client.getEntity(target);
  const candidates = numeric.startsWith("-") ? [numeric] : [`-100${numeric}`, numeric];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await client.getEntity(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("频道解析失败");
}

export async function resolveChannel(input: string): Promise<ResolvedChannel> {
  const client = await getClient();
  const raw = input.trim();
  if (!raw) throw new TgError("BAD_CHANNEL", "请填写频道用户名或链接");

  try {
    // 邀请链接 t.me/+hash / t.me/joinchat/hash
    const invite = raw.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]+)/i);
    if (invite) {
      const result = await client.invoke(new Api.messages.ImportChatInvite({ hash: invite[1] }));
      const chat = (result as { chats?: Array<Record<string, unknown>> }).chats?.[0];
      if (!chat) throw new TgError("BAD_CHANNEL", "邀请链接解析失败");
      return {
        tgId: String(chat.id),
        username: (chat.username as string) || null,
        title: (chat.title as string) || `频道 ${chat.id}`,
      };
    }

    let target = raw
      .replace(/^https?:\/\//i, "")
      .replace(/^t\.me\//i, "")
      .replace(/^telegram\.me\//i, "")
      .replace(/^@/, "")
      .replace(/\/.*$/, "");

    const numeric = /^-?\d+$/.test(target) ? target : null;
    const entity = await resolveEntityInput(client, target, numeric);
    const anyEntity = entity as unknown as {
      id: unknown;
      title?: string;
      username?: string;
      firstName?: string;
      className?: string;
    };
    return {
      tgId: String(anyEntity.id),
      username: anyEntity.username || (numeric ? null : target.toLowerCase()),
      title: anyEntity.title || [anyEntity.firstName].filter(Boolean).join(" ") || `频道 ${anyEntity.id}`,
    };
  } catch (err) {
    if (err instanceof TgError) throw err;
    const msg = (err as { errorMessage?: string }).errorMessage || (err as Error).message;
    if (msg.includes("USERNAME_NOT_OCCUPIED") || msg.includes("No user has")) {
      throw new TgError("CHANNEL_NOT_FOUND", "频道不存在，请检查用户名");
    }
    if (msg.includes("CHANNEL_PRIVATE") || msg.includes("not a member")) {
      throw new TgError("CHANNEL_PRIVATE", "私有频道或尚未加入，请先在 Telegram 中加入该频道");
    }
    throw new TgError("RESOLVE_FAILED", msg || "频道解析失败");
  }
}

export function resetClientCache(): void {
  activeClient = null;
}

export function hasSession(): boolean {
  return Boolean(getSession());
}

/** 供扫描器复用，避免循环依赖 */
export function rawDb() {
  return db;
}
