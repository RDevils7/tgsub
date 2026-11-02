import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { CallbackQuery, CallbackQueryEvent } from "telegram/events/CallbackQuery";
import { Button } from "telegram/tl/custom/button";
import type { EntityLike } from "telegram/define";

import { db, getBotToken, getSetting, getSettings, setSetting, updateSettings } from "../db";
import { logger } from "../logger";
import { Channel, PLATFORM_LABEL, Subscription } from "../types";
import { deriveName } from "../utils";
import { currentProxy, getAppCredentials, getAuthState, resolveChannel } from "./client";
import { getSchedulerState, isScanning, scanAll, scanChannel, type ScanResult } from "./scanner";
import { downloadFromLink, extractTelegramLinks, type DirectResult } from "./direct";
import { downloader } from "./downloader";
import { setNotifySender } from "./notify";
import { invalidateMatcherCache } from "../match";
import { parsePlatformLink, splitPlatformLinks } from "../platform/detect";
import { enqueueFromChoice, enqueuePlatformLinks, type PlatformChoiceInfo, type PlatformQueued } from "../platform/jobs";

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

export interface BotState {
  enabled: boolean;
  running: boolean;
  username: string | null;
  userId: string | null;
  error: string | null;
  startedAt: number | null;
  /** 白名单里的用户数 */
  allowCount: number;
  tokenSet: boolean;
  tokenHint: string | null;
}

let bot: TelegramClient | null = null;
let starting: Promise<void> | null = null;
let startingAt = 0;
let lastError: string | null = null;
let startedAt: number | null = null;
let identity: { username: string | null; userId: string | null } = { username: null, userId: null };

/** gramjs 内置 DC 地址表（TCP 80 端口，Node 端默认走 TCPFull） */
const DC_IP: Record<number, string> = {
  1: "149.154.175.53",
  2: "149.154.167.51",
  3: "149.154.175.100",
  4: "149.154.167.91",
  5: "91.108.56.130",
};

/**
 * 机器人归属 DC（登录成功后记下来）。
 *
 * 不记的话每次启动都会先连默认 DC 4、授权时被服务器迁移到所属 DC，
 * 而迁移后 gramjs 会丢掉那个在途请求（实测必然超时），只能靠重试补救。
 * 记住之后直接连对端，登录从 ~15s 降到 ~8s 且没有失败请求。
 */
function botDcId(): number | null {
  const raw = Number(getSetting("bot_dc"));
  return Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : null;
}

/** 机器人用 bot token 授权，跟用户账号的 session 是两套 authKey，互不影响 */
function createBotClient(dcId: number | null = botDcId()): TelegramClient {
  const cred = getAppCredentials();
  const session = new StringSession("");
  if (dcId && DC_IP[dcId]) {
    // 连接前把 session 指到目标 DC，connect() 就会直连它
    (session as unknown as { setDC: (dc: number, addr: string, port: number) => void }).setDC(
      dcId,
      DC_IP[dcId],
      80,
    );
  }
  return new TelegramClient(session, cred.apiId, cred.apiHash, {
    connectionRetries: 3,
    retryDelay: 2000,
    autoReconnect: true,
    // 内部重试压到 2 次：挂住时由外层的 loginBot 重试，比在库内部无限等更好控
    requestRetries: 2,
    timeout: 20000,
    deviceModel: "tgsub",
    systemVersion: "1.0",
    appVersion: "1.0",
    langCode: "zh",
    systemLangCode: "zh",
    proxy: currentProxy(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给挂住的网络请求兜个底：超时即抛错，交给重试逻辑 */
async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 授权失败时值得重试的情况：超时 / 连接被断 / DC 迁移后请求丢失 */
function isTransientAuthError(msg: string): boolean {
  return /TIMEOUT|unsuccessful|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|Disconnect|MIGRATE|not connected/i.test(
    msg,
  );
}

/**
 * 用 bot token 登录。
 *
 * 实测：归属 DC 与当前 DC 不同时，gramjs 会自动迁移并重连，但**迁移前发出的那次请求会超时**，
 * 换 DC 后同一条请求再发一次就成功（<1s）。所以这里带重试，成功一次就停。
 */
async function loginBot(client: TelegramClient, token: string): Promise<Api.User> {
  const cred = getAppCredentials();
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const auth = await withTimeout(
        client.invoke(
          new Api.auth.ImportBotAuthorization({
            apiId: cred.apiId,
            apiHash: cred.apiHash,
            botAuthToken: token,
          }),
        ),
        25000,
        "机器人授权",
      );
      return (auth as Api.auth.Authorization).user as Api.User;
    } catch (err) {
      lastErr = err;
      const msg = errorText(err);
      const dc = migrateDcOf(err);
      if (dc && DC_IP[dc]) {
        // 记下归属 DC，下次启动直接连它
        setSetting("bot_dc", String(dc));
        logger.info({ dc }, "机器人归属 DC 已记录");
      }
      if (attempt === 4 || !isTransientAuthError(msg)) throw err;
      logger.warn({ attempt, err: msg }, "机器人授权失败，重试");
      await sleep(1200 * attempt);
    }
  }
  throw lastErr ?? new Error("机器人授权失败");
}

/** 手机号/机器人登录都可能返回 MIGRATE，切 DC 后重试一次即可 */
function migrateDcOf(err: unknown): number | null {
  const e = err as { errorMessage?: string; message?: string };
  const head = (e?.errorMessage || e?.message || "").split(":")[0].trim();
  const m = /^(?:PHONE|NETWORK|USER)_MIGRATE_(\d+)$/.exec(head);
  return m ? Number(m[1]) : null;
}

function errorText(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string };
  return e?.errorMessage || e?.message || String(err);
}

/**
 * 机器人登录被 Telegram 限流（短时间反复重启/授权会触发）。
 * 这类失败重试就会好，不值得让用户去手动点「重新连接」。
 */
function isFlood(err: unknown): boolean {
  return /FLOOD/i.test(errorText(err));
}

function friendlyAuthError(err: unknown): string {
  const msg = errorText(err);
  if (msg.includes("USER_DEACTIVATED_BAN") || msg.includes("USER_DEACTIVATED")) {
    return (
      "这个机器人已被 Telegram 冻结或删除（所属账号被判定可疑活动时会连带处置它创建的全部机器人）。" +
      "冻结的机器人无法恢复，请到 @BotFather 重新创建一个，并换用新的 Token。"
    );
  }
  if (msg.includes("ACCESS_TOKEN_INVALID") || msg.includes("ACCESS_TOKEN_EXPIRED")) {
    return (
      "Bot Token 已失效。如果 Telegram 给你的账号发过「可疑活动」通知，" +
      "它会把相关机器人的 Token 一并重置 —— 旧 Token 永久作废，必须去 @BotFather 重新获取（或用 /token 换新）。"
    );
  }
  if (msg.includes("API_ID_INVALID") || msg.includes("API_ID_PUBLISHED_FLOOD")) {
    return "当前应用凭证无法用于机器人，请改用「自定义 API ID」";
  }
  if (isFlood(err)) return "Telegram 限流（短时间内重启太频繁），稍后会自动重试";
  if (/TIMEOUT|超时|ENOTFOUND|ECONNREFUSED|ECONNRESET|SOCKS|unsuccessful/i.test(msg)) {
    return `连接 Telegram 失败：${msg}（检查代理设置）`;
  }
  return msg;
}

/** 限流退避：1 分钟起步，最长 30 分钟，成功后清零 */
let floodAttempts = 0;
let floodTimer: NodeJS.Timeout | null = null;

function scheduleFloodRetry(): void {
  if (floodTimer) return;
  const wait = Math.min(1800, 60 * 2 ** Math.min(floodAttempts, 5));
  floodAttempts += 1;
  lastError = `Telegram 限流，约 ${Math.round(wait / 60)} 分钟后自动重试`;
  floodTimer = setTimeout(() => {
    floodTimer = null;
    void startBot();
  }, wait * 1000);
  floodTimer.unref?.();
}

export async function startBot(): Promise<void> {
  if (starting) {
    // 启动流程理论上不会超过 2 分钟（各步都有超时），超时说明卡死了，允许重新来一次
    if (Date.now() - startingAt < 180_000) return starting;
    logger.warn("上一次机器人启动迟迟没结束，强制重新开始");
  }
  startingAt = Date.now();
  const task = (async () => {
    await stopBot();
    lastError = null;
    const settings = getSettings();
    if (!settings.bot_enabled) return;

    const token = getBotToken();
    if (!token) {
      lastError = "尚未填写 Bot Token（在 @BotFather 发送 /newbot 获取）";
      return;
    }

    let client: TelegramClient | null = null;
    try {
      client = createBotClient();
      await withTimeout(client.connect() as unknown as Promise<void>, 40000, "连接 Telegram");

      const user = await loginBot(client, token);

      // 登录成功后把实际所在 DC 记下来，下次启动直连它（省掉迁移）
      const dcId = (client.session as unknown as { dcId?: number }).dcId;
      if (dcId && DC_IP[dcId]) setSetting("bot_dc", String(dcId));

      bot = client;
      identity = { username: user.username ?? null, userId: String(user.id) };
      startedAt = Date.now();

      client.addEventHandler(
        (event) => {
          void handleMessage(event);
        },
        new NewMessage({ incoming: true }),
      );
      client.addEventHandler(
        (event) => {
          void handleCallback(event);
        },
        new CallbackQuery({}),
      );

      setNotifySender(async (text) => {
        const sender = bot;
        const peer = peerOf();
        if (!sender || !peer) throw new Error("还没有可推送的会话（先给机器人发一条消息）");
        await sendText(sender, peer, text);
      });

      // 命令菜单注册失败不影响收发消息，只记日志
      await withTimeout(registerCommands(client), 20000, "注册命令菜单").catch((err: unknown) => {
        logger.warn({ err: errorText(err) }, "机器人命令菜单注册失败（不影响使用）");
      });
      floodAttempts = 0;
      logger.info({ bot: identity.username ?? identity.userId }, "Telegram 机器人已上线");
    } catch (err) {
      lastError = friendlyAuthError(err);
      logger.warn({ err: errorText(err) }, "Telegram 机器人启动失败");
      if (client && client !== bot) await client.disconnect().catch(() => undefined);
      bot = null;
      identity = { username: null, userId: null };
      startedAt = null;
      setNotifySender(null);
      // 限流不是配置问题：等一会儿自己再来，失败次数翻倍退避
      if (isFlood(err) && getSettings().bot_enabled) scheduleFloodRetry();
    }
  })();

  starting = task;
  try {
    await task;
  } finally {
    if (starting === task) starting = null;
  }
}

export async function stopBot(): Promise<void> {
  const current = bot;
  bot = null;
  setNotifySender(null);
  identity = { username: null, userId: null };
  startedAt = null;
  if (current) {
    await current.disconnect().catch(() => undefined);
    logger.info("Telegram 机器人已下线");
  }
}

/** 设置变更后重建连接（token / 开关改动都需要重新授权） */
export async function restartBot(): Promise<void> {
  await stopBot();
  lastError = null;
  await startBot();
}

export function getBotState(): BotState {
  const settings = getSettings();
  const token = getBotToken();
  return {
    enabled: settings.bot_enabled,
    running: Boolean(bot && bot.connected),
    username: identity.username,
    userId: identity.userId,
    error: lastError,
    startedAt,
    allowCount: allowList().length,
    tokenSet: Boolean(token),
    tokenHint: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null,
  };
}

/* ------------------------------------------------------------------ */
/* 权限                                                                */
/* ------------------------------------------------------------------ */

function allowList(): string[] {
  return getSettings()
    .bot_allow_users.split(/[\s,，;；]+/)
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v));
}

function isAllowed(userId: string): boolean {
  const list = allowList();
  return list.length > 0 && list.includes(userId);
}

/* ------------------------------------------------------------------ */
/* 推送对象：记住最后一次私聊的用户，重启后也能继续推送                  */
/* ------------------------------------------------------------------ */

async function rememberPeer(msg: NewMessageEvent["message"]): Promise<void> {
  try {
    let entity = (await msg.getSender().catch(() => undefined)) as
      | { id?: unknown; accessHash?: unknown }
      | undefined;
    if (!entity?.id) {
      entity = (await msg.getChat().catch(() => undefined)) as
        | { id?: unknown; accessHash?: unknown }
        | undefined;
    }
    if (!entity?.id) return;
    // 私聊里 accessHash 可能拿不到：机器人对自己发起过会话的用户可以用 0
    setSetting(
      "bot_peer",
      JSON.stringify({ id: String(entity.id), hash: String(entity.accessHash ?? 0) }),
    );
  } catch {
    /* 拿不到就下次再说 */
  }
}

function peerOf(): EntityLike | null {
  const raw = getSetting("bot_peer");
  if (!raw) return null;
  try {
    const peer = JSON.parse(raw) as { id?: string; hash?: string };
    if (!peer.id || !peer.hash) return null;
    return new Api.InputPeerUser({
      userId: bigInt(peer.id),
      accessHash: bigInt(peer.hash),
    }) as unknown as EntityLike;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 发送                                                                */
/* ------------------------------------------------------------------ */

const MAX_CHUNK = 3500;

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf("\n", MAX_CHUNK);
    if (cut < MAX_CHUNK * 0.5) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

async function sendText(client: TelegramClient, peer: EntityLike, text: string, buttons?: Api.TypeKeyboardButton[][]): Promise<void> {
  const chunks = chunkText(text);
  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1;
    await client.sendMessage(peer, {
      message: chunk,
      parseMode: "html",
      linkPreview: false,
      ...(last && buttons ? { buttons } : {}),
    });
  }
}

const btn = (text: string, data: string): Api.KeyboardButtonCallback =>
  Button.inline(text, Buffer.from(data));

const esc = (input: string): string =>
  String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* 命令表                                                              */
/* ------------------------------------------------------------------ */

const COMMANDS: Array<{ command: string; description: string }> = [
  { command: "status", description: "运行状态（含快捷按钮）" },
  { command: "scan", description: "立即扫描：/scan 或 /scan 频道名" },
  { command: "channels", description: "频道列表" },
  { command: "addch", description: "添加频道：/addch @用户名或链接" },
  { command: "rmch", description: "删除频道：/rmch 频道ID" },
  { command: "subs", description: "订阅规则列表" },
  { command: "sub", description: "新建订阅：/sub 关键词1,关键词2" },
  { command: "rmsub", description: "删除订阅：/rmsub 订阅ID" },
  { command: "tasks", description: "最近下载任务" },
  { command: "queue", description: "下载队列" },
  { command: "dl", description: "按链接下载：/dl t.me/频道/123" },
  { command: "retry", description: "重试失败下载：/retry 或 /retry all" },
  { command: "pause", description: "暂停自动扫描" },
  { command: "resume", description: "恢复自动扫描" },
  { command: "stats", description: "累计统计" },
  { command: "help", description: "命令说明" },
];

async function registerCommands(client: TelegramClient): Promise<void> {
  try {
    await client.invoke(
      new Api.bots.SetBotCommands({
        scope: new Api.BotCommandScopeDefault(),
        langCode: "",
        commands: COMMANDS.map((c) => new Api.BotCommand({ command: c.command, description: c.description })),
      }),
    );
  } catch (err) {
    logger.debug({ err: errorText(err) }, "设置机器人命令菜单失败（不影响使用）");
  }
}

const HELP_TEXT = `🤖 <b>tgsub 控制台</b>

<b>查看</b>
/status 运行状态 · /channels 频道 · /subs 订阅
/tasks 最近下载 · /queue 队列 · /stats 累计统计

<b>操作</b>
/scan 立即扫描全部频道
/scan 美人局 只扫某个频道（也可用频道 ID）
/addch @频道 或 t.me 链接
/rmch 频道ID
/sub 关键词1,关键词2 新建订阅（多个关键词用逗号分隔）
/rmsub 订阅ID
/dl https://t.me/频道名/123 按链接直接下载
/retry 重试全部失败 · /retry 123 重试单条
/pause · /resume 暂停或恢复自动扫描

<b>直接发链接就能下载</b>
· Telegram 消息链接：https://t.me/频道名/123
· B站 / 抖音 / 小红书 / YouTube：App 里「复制链接」的整段分享口令
  原样粘贴即可（带一串说明文字也没关系），最多一次处理 5 条。
点消息下方的按钮也能直接操作。`;

function mainButtons(): Api.TypeKeyboardButton[][] {
  const auto = getSettings().auto_scan;
  return [
    [btn("🔄 立即扫描", "cmd:scan"), btn("📊 刷新状态", "cmd:status")],
    [btn("📡 频道", "cmd:channels"), btn("🎯 订阅", "cmd:subs"), btn("🗂 最近任务", "cmd:tasks")],
    [btn(auto ? "⏸ 暂停自动扫描" : "▶️ 恢复自动扫描", auto ? "cmd:pause" : "cmd:resume")],
  ];
}

export interface BotCtx {
  userId: string;
  /** 处理过程中主动补发一条消息（长任务用） */
  send: (text: string, buttons?: Api.TypeKeyboardButton[][]) => Promise<void>;
}

export interface BotReply {
  text: string;
  buttons?: Api.TypeKeyboardButton[][];
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

function channelsByKeyword(keyword: string): Channel[] {
  const all = db.prepare<[], Channel>("SELECT * FROM channels ORDER BY id ASC").all();
  const key = keyword.trim().toLowerCase().replace(/^@/, "");
  if (!key) return [];
  if (/^\d+$/.test(key)) {
    const byId = all.filter((c) => c.id === Number(key));
    if (byId.length) return byId;
  }
  return all.filter(
    (c) => (c.username ?? "").toLowerCase() === key || c.title.toLowerCase().includes(key),
  );
}

function channelTitle(id: number): string {
  const row = db.prepare<[number], { title: string }>("SELECT title FROM channels WHERE id = ?").get(id);
  return row?.title ?? `频道 #${id}`;
}

function summarize(results: ScanResult[], singleTitle?: string): string {
  if (!results.length) return "没有可扫描的频道（检查频道是否启用、账号是否已登录）";
  const lines = results.map((r) => {
    const title = singleTitle ?? channelTitle(r.channelId);
    if (r.error) return `❌ ${esc(title)}：${esc(r.error).slice(0, 150)}`;
    const extra = r.skipped ? ` · 过滤 ${r.skipped}` : "";
    return `✅ ${esc(title)}：扫到 ${r.scanned} 条 · 命中 ${r.matched} · 新入队 ${r.queued}${extra}`;
  });
  const queued = results.reduce((sum, r) => sum + r.queued, 0);
  const tail = queued > 0 ? "\n\n新任务已进入下载队列，稍后可用 /tasks 查看进度" : "";
  return `📡 <b>扫描完成</b>\n${lines.join("\n")}${tail}`;
}

function buildStatus(account: string): string {
  const stat = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM channels) AS channels,
         (SELECT COUNT(*) FROM channels WHERE enabled = 1) AS enabled_channels,
         (SELECT COUNT(*) FROM subscriptions WHERE enabled = 1) AS subs,
         (SELECT COUNT(*) FROM downloads WHERE status = 'done') AS done,
         (SELECT COUNT(*) FROM downloads WHERE status = 'failed') AS failed,
         (SELECT COUNT(*) FROM downloads WHERE created_at >= ?) AS today,
         (SELECT COALESCE(SUM(file_size), 0) FROM downloads WHERE status = 'done') AS bytes`,
    )
    .get(new Date().setHours(0, 0, 0, 0)) as Record<string, number>;

  const queue = downloader.stats();
  const sched = getSchedulerState();
  const auto = sched.autoScan;
  const next = auto && sched.nextRunAt ? fmtTime(sched.nextRunAt) : null;

  const lines = [`📊 <b>tgsub 运行状态</b>`];
  lines.push(`账号：${account}`);
  lines.push(
    `频道 ${stat.channels} 个（启用 ${stat.enabled_channels}）· 订阅 ${stat.subs} 条`,
  );
  lines.push(`队列：下载中 ${queue.active} · 等待 ${queue.waiting}`);
  lines.push(
    `累计：完成 ${stat.done} · 失败 ${stat.failed} · ${fmtBytes(stat.bytes)}；今日新增 ${stat.today} 个文件`,
  );
  lines.push(
    `自动扫描：${auto ? `每 ${sched.intervalMinutes} 分钟` : "已暂停"} · 上次 ${fmtTime(sched.lastScanAt)}${
      next ? ` · 下次约 ${next}` : ""
    }`,
  );
  lines.push(`机器人：@${identity.username ?? "—"} ✅ 在线`);
  return lines.join("\n");
}

/**
 * 命令执行入口。
 * 单独导出是为了能在不连 Telegram 的情况下跑自检（scripts/test-bot.ts）：
 * 命令层只依赖数据库与下载队列，不依赖 bot 连接本身。
 */
export async function runBotCommand(cmd: string, args: string[], ctx: BotCtx): Promise<BotReply> {
  return execute(cmd, args, ctx);
}

/** 手动/链接下载的回执 */
function directText(r: DirectResult): string {
  const lines = [`✅ <b>${esc(r.channelTitle)}</b> · 消息 #${r.messageId}`];
  if (r.title) lines.push(`📄 ${esc(r.title)}${r.files > 1 ? ` 等 ${r.files} 个文件` : ""}`);
  if (r.queued > 0) lines.push(`⬇️ 已入队 ${r.queued} 个文件，正在下载`);
  if (r.existing > 0) lines.push(`⏭ ${r.existing} 个之前已下载，跳过`);
  if (r.skipped > 0) lines.push(`⚪ ${r.skipped} 个被文件大小限制跳过`);
  if (r.queued === 0 && r.existing === 0 && r.skipped > 0) lines.push("可在设置里调整最小/最大文件大小");
  if (r.autoAdded) lines.push("ℹ️ 该频道已加入频道列表但保持停用，不参与定时扫描");
  return lines.join("\n");
}

/** 第三方平台（B站 / 抖音 / 小红书 / YouTube）入队回执 */
function platformQueuedText(r: PlatformQueued): string {
  const label = PLATFORM_LABEL[r.platform] ?? r.platform;
  if (!r.ok) return `❌ <b>${esc(label)}</b>\n${esc(r.error ?? "解析失败")}`;
  const lines = [`🎬 <b>${esc(label)}</b>${r.title ? ` · ${esc(r.title)}` : ""}`];
  if (r.uploader) lines.push(`👤 ${esc(r.uploader)}`);
  if (r.existing) {
    lines.push(r.count > 1 ? `⏭ 这 ${r.count} 个之前都下过，这次跳过` : "⏭ 之前已在队列或已下载过，这次跳过");
  } else {
    lines.push(
      r.count > 1
        ? `⬇️ 已加入下载队列：${r.count} 个视频，用 /tasks 看进度`
        : "⬇️ 已加入下载队列，稍后用 /tasks 看进度",
    );
  }
  return lines.join("\n");
}

/** 合集 / 多P：让用户选「只下第一个」还是「全部下载」 */
function platformChoiceText(choice: PlatformChoiceInfo): string {
  const label = PLATFORM_LABEL[choice.platform] ?? choice.platform;
  const lines = [
    `🎬 <b>${esc(label)}</b> · 这条链接是个合集`,
    `📚 ${esc(choice.title)}`,
    `共 <b>${choice.count}</b> 个视频${choice.capped ? "（只读了前 200 个）" : ""}`,
  ];
  if (choice.firstTitle) lines.push(`① ${esc(choice.firstTitle)}`);
  lines.push("", "只下这一个，还是整份都下载？");
  return lines.join("\n");
}

function platformChoiceButtons(choice: PlatformChoiceInfo): Api.TypeKeyboardButton[][] {
  return [
    [
      btn("只下第一个", `cmd:pg ${choice.token} one`),
      btn(`全部下载 ${choice.count} 个`, `cmd:pg ${choice.token} all`),
    ],
  ];
}

/** 一批链接全失败且原因是同一个（比如平台没启用）时，只回一条，别刷屏 */
function platformBatchReplies(results: PlatformQueued[]): string[] {
  const failures = results.filter((r) => !r.ok);
  const reasons = new Set(failures.map((r) => r.error ?? ""));
  if (failures.length === results.length && reasons.size === 1) {
    return [`❌ ${esc(failures[0].error ?? "解析失败")}`];
  }
  return results.filter((r) => !r.choice).map(platformQueuedText);
}

async function execute(cmd: string, args: string[], ctx: BotCtx): Promise<BotReply> {
  switch (cmd) {
    case "start":
    case "help":
      return { text: HELP_TEXT, buttons: mainButtons() };

    case "id":
      return { text: `🆔 你的 Telegram ID：<code>${esc(ctx.userId)}</code>` };

    case "status": {
      const authState = await getAuthState();
      const account = authState.authorized
        ? `@${authState.me?.username ?? authState.me?.firstName ?? "已登录"}`
        : `未登录${authState.error ? `（${esc(authState.error)}）` : ""}`;
      return { text: buildStatus(account), buttons: mainButtons() };
    }

    case "scan": {
      if (isScanning()) return { text: "⏳ 已有扫描在进行中，请稍后再试" };
      const target = args.join(" ").trim();
      if (!target) {
        await ctx.send("🚀 开始扫描全部启用的频道，可能需要几分钟…");
        const results = await scanAll("bot");
        return { text: summarize(results) };
      }
      const matches = channelsByKeyword(target);
      if (!matches.length) {
        return {
          text: `没有找到匹配「${esc(target)}」的频道`,
          buttons: [[btn("📡 频道列表", "cmd:channels")]],
        };
      }
      if (matches.length > 1) {
        const list = matches.slice(0, 10).map((c) => `#${c.id} ${esc(c.title)}`).join("\n");
        return { text: `匹配到多个频道，请用 /scan ID 指定：\n${list}` };
      }
      const channel = matches[0];
      await ctx.send(`🚀 开始扫描「${esc(channel.title)}」…`);
      const result = await scanChannel(channel.id, { ignoreDisabled: true });
      return { text: summarize([result], channel.title) };
    }

    case "channels": {
      const rows = db.prepare<[], Channel>("SELECT * FROM channels ORDER BY id ASC").all();
      if (!rows.length) return { text: "还没有添加频道，用 /addch @频道 添加" };
      const body = rows
        .slice(0, 30)
        .map(
          (c) =>
            `${c.enabled ? "🟢" : "⚪️"} <b>#${c.id}</b> ${esc(c.title)}${
              c.username ? ` · @${esc(c.username)}` : ""
            } · 上次 ${fmtTime(c.last_scan_at)}${c.last_error ? `\n　❌ ${esc(c.last_error).slice(0, 80)}` : ""}`,
        )
        .join("\n");
      return { text: `📡 <b>频道（${rows.length}）</b>\n${body}` };
    }

    case "addch": {
      const input = args.join(" ").trim();
      if (!input) return { text: "用法：/addch @频道用户名 或 /addch https://t.me/xxx" };
      try {
        const resolved = await resolveChannel(input);
        const existing = db
          .prepare("SELECT * FROM channels")
          .all()
          .find(
            (row) =>
              (row as Channel).tg_id === resolved.tgId ||
              ((row as Channel).username ?? "").toLowerCase() === (resolved.username ?? "").toLowerCase(),
          ) as Channel | undefined;
        if (existing) return { text: `⚠️ 频道「${esc(existing.title)}」已在列表中（#${existing.id}）` };
        const info = db
          .prepare("INSERT INTO channels(tg_id, username, title, enabled, created_at) VALUES (?, ?, ?, 1, ?)")
          .run(resolved.tgId, resolved.username, resolved.title, Date.now());
        const id = Number(info.lastInsertRowid);
        return {
          text: `✅ 已添加频道「${esc(resolved.title)}」（#${id}）\n发 /scan ${id} 可以立刻扫一次`,
        };
      } catch (err) {
        return { text: `❌ 添加失败：${esc(errorText(err))}` };
      }
    }

    case "rmch": {
      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) return { text: "用法：/rmch 频道ID（ID 见 /channels）" };
      const row = db.prepare<[number], Channel>("SELECT * FROM channels WHERE id = ?").get(id);
      if (!row) return { text: `没有 ID 为 ${id} 的频道` };
      db.transaction(() => {
        db.prepare("DELETE FROM downloads WHERE channel_id = ?").run(id);
        db.prepare("DELETE FROM channels WHERE id = ?").run(id);
      })();
      return { text: `🗑 已删除频道「${esc(row.title)}」及其下载记录` };
    }

    case "subs": {
      const rows = db.prepare<[], Subscription>("SELECT * FROM subscriptions ORDER BY id DESC").all();
      if (!rows.length) return { text: "还没有订阅规则，用 /sub 关键词 新建" };
      const body = rows
        .slice(0, 20)
        .map((s) => {
          const ids = JSON.parse(s.channel_ids || "[]") as number[];
          const scope = ids.length ? `${ids.length} 个频道` : "全部频道";
          return `${s.enabled ? "🟢" : "⚪️"} <b>#${s.id}</b> ${esc(s.name)}\n　关键词：${esc(s.keywords)} · ${s.match_mode} · ${scope}`;
        })
        .join("\n");
      return { text: `🎯 <b>订阅规则（${rows.length}）</b>\n${body}` };
    }

    case "sub": {
      const raw = args.join(" ").trim();
      if (!raw) return { text: "用法：/sub 关键词1,关键词2\n也可以加名称：/sub 关键词 | 我的订阅" };
      const [keywordsPart, namePart] = raw.split("|").map((v) => v.trim());
      const keywords = keywordsPart
        .split(/[\s,，;；]+/)
        .filter(Boolean)
        .join(",");
      if (!keywords) return { text: "请至少填写一个关键词" };
      const name = namePart || deriveName(keywords);
      const info = db
        .prepare(
          `INSERT INTO subscriptions(name, keywords, match_mode, channel_ids, enabled, created_at)
           VALUES (?, ?, 'contains', '[]', 1, ?)`,
        )
        .run(name, keywords, Date.now());
      invalidateMatcherCache();
      return {
        text: `✅ 已创建订阅「${esc(name)}」（#${Number(info.lastInsertRowid)}）\n关键词：${esc(keywords)}\n下一轮扫描生效，可发 /scan 立刻扫一次`,
      };
    }

    case "rmsub": {
      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) return { text: "用法：/rmsub 订阅ID（ID 见 /subs）" };
      const row = db.prepare<[number], Subscription>("SELECT * FROM subscriptions WHERE id = ?").get(id);
      if (!row) return { text: `没有 ID 为 ${id} 的订阅` };
      db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
      invalidateMatcherCache();
      return { text: `🗑 已删除订阅「${esc(row.name)}」` };
    }

    case "tasks": {
      const rows = db
        .prepare("SELECT id, save_name, file_name, status, progress, file_size, created_at FROM downloads ORDER BY id DESC LIMIT 8")
        .all() as Array<{
        id: number;
        save_name: string | null;
        file_name: string;
        status: string;
        progress: number;
        file_size: number;
        created_at: number;
      }>;
      if (!rows.length) return { text: "还没有下载任务" };
      const icon = (s: string): string =>
        s === "done" ? "✅" : s === "downloading" ? "⏳" : s === "queued" ? "🕒" : s === "failed" ? "❌" : "⏭";
      const body = rows
        .map(
          (r) =>
            `${icon(r.status)} <b>#${r.id}</b> ${esc(r.save_name ?? r.file_name)}${
              r.status === "downloading" ? ` ${r.progress}%` : ""
            } · ${fmtBytes(r.file_size)} · ${fmtTime(r.created_at)}`,
        )
        .join("\n");
      return { text: `🗂 <b>最近任务</b>\n${body}` };
    }

    case "queue": {
      const queue = downloader.stats();
      const running = db
        .prepare("SELECT id, save_name, file_name, progress FROM downloads WHERE status = 'downloading' ORDER BY id")
        .all() as Array<{ id: number; save_name: string | null; file_name: string; progress: number }>;
      const lines = [`⬇️ <b>下载队列</b>`, `下载中 ${queue.active} · 等待 ${queue.waiting}`];
      for (const row of running) {
        lines.push(`⏳ #${row.id} ${esc(row.save_name ?? row.file_name)} ${row.progress}%`);
      }
      return { text: lines.join("\n") };
    }

    case "dl": {
      const link = args.join(" ").trim();
      if (!link) {
        return {
          text:
            "用法：<code>/dl https://t.me/频道名/123</code>\n" +
            "也可以直接发链接：Telegram 消息链接、B站 / 抖音 / 小红书 / YouTube 的分享口令都认。",
        };
      }
      // 平台链接（含分享口令）走 yt-dlp；其余仍按 Telegram 消息链接处理
      const platformLinks = splitPlatformLinks(link);
      if (platformLinks.length && !extractTelegramLinks(link).length) {
        const results = await enqueuePlatformLinks(platformLinks.slice(0, 5));
        const lines = platformBatchReplies(results);
        const choices = results.filter((r) => r.choice);
        // 一条命令只能带一组按钮：多个合集时第一个给按钮，其余提示单独发
        if (choices.length > 1) {
          lines.push(`还有 ${choices.length - 1} 个合集需要单独发链接后再选`);
        }
        return {
          text: [...lines, ...(choices.length ? [platformChoiceText(choices[0].choice!)] : [])]
            .filter(Boolean)
            .join("\n\n"),
          ...(choices.length ? { buttons: platformChoiceButtons(choices[0].choice!) } : {}),
        };
      }
      try {
        return { text: directText(await downloadFromLink(link)), buttons: mainButtons() };
      } catch (err) {
        return { text: `❌ ${esc(errorText(err))}` };
      }
    }

    // 合集按钮回调：/pg 不会出现在命令列表里，只有按钮会发
    case "pg": {
      const [token, modeRaw] = args;
      if (!token) return { text: "这个按钮已经失效了，请重新发一次链接" };
      const mode = modeRaw === "all" ? "all" : "one";
      const outcome = await enqueueFromChoice(token, mode);
      if (outcome.type === "playlist") return { text: "这个选择已经处理过了，请重新发一次链接" };
      const queued = outcome.tasks.filter((task) => !task.existing).length;
      const existing = outcome.tasks.length - queued;
      const lines = [
        mode === "all"
          ? `✅ 合集已展开：共 ${outcome.tasks.length} 个视频`
          : `✅ 已加入下载队列：${esc(outcome.tasks[0]?.title ?? "")}`,
        `⬇️ 新入队 ${queued} 个${existing ? ` · 之前下过 ${existing} 个` : ""}`,
      ];
      if (outcome.playlist?.capped) lines.push("ℹ️ 合集超过 200 个，只取了前 200 个");
      const dir = outcome.tasks[0]?.saveDir;
      if (dir) lines.push(`📁 <code>${esc(dir)}/</code>`);
      return { text: lines.join("\n") };
    }

    case "retry": {
      const arg = (args[0] ?? "").toLowerCase();
      if (!arg || arg === "all") {
        const rows = db.prepare("SELECT id FROM downloads WHERE status = 'failed'").all() as Array<{ id: number }>;
        if (!rows.length) return { text: "没有失败的任务" };
        rows.forEach((row) => downloader.retry(row.id));
        return { text: `🔁 已重新排队 ${rows.length} 个失败任务` };
      }
      const id = Number(arg);
      if (!Number.isInteger(id) || id <= 0) return { text: "用法：/retry 或 /retry all 或 /retry 任务ID" };
      return downloader.retry(id) ? { text: `🔁 任务 #${id} 已重新排队` } : { text: `任务 #${id} 不存在` };
    }

    case "pause":
    case "resume": {
      const on = cmd === "resume";
      updateSettings({ auto_scan: on });
      return {
        text: on ? "▶️ 已恢复自动扫描" : "⏸ 已暂停自动扫描（手动 /scan 仍可用）",
        buttons: mainButtons(),
      };
    }

    case "stats": {
      const stat = db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
             COALESCE(SUM(CASE WHEN status = 'done' THEN file_size ELSE 0 END), 0) AS bytes,
             COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today
           FROM downloads`,
        )
        .get(new Date().setHours(0, 0, 0, 0)) as Record<string, number>;
      return {
        text: `📈 <b>累计统计</b>\n任务 ${stat.total} 个\n完成 ${stat.done} · 失败 ${stat.failed}\n已落盘 ${fmtBytes(stat.bytes)}\n今日新增 ${stat.today} 个任务`,
      };
    }

    default:
      return { text: `未知命令：/${esc(cmd)}\n\n${HELP_TEXT}` };
  }
}

/** buildStatus 需要账号信息，由 /status 取到后传进来，避免重复请求 getMe */

/* ------------------------------------------------------------------ */
/* 事件处理                                                            */
/* ------------------------------------------------------------------ */

function denyText(userId: string): string {
  return `⛔ <b>没有操作权限</b>

你的 Telegram ID：<code>${esc(userId)}</code>
把它填到「设置 → Telegram 机器人 → 允许的用户」后即可使用。

这道限制是为了避免机器人被陌生人控制。`;
}

async function handleMessage(event: NewMessageEvent): Promise<void> {
  const msg = event.message;
  try {
    const text = (msg.message ?? "").trim();
    if (!text) return;
    if (msg.isPrivate === false) return; // 只接受私聊指令，避免被拉群乱操作

    const peer = msg.inputChat ?? msg.chatId;
    if (!peer) return;
    const userId = String(msg.senderId ?? "");

    const matched = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/.exec(text);
    const cmd = (matched?.[1] ?? "").toLowerCase();
    const rest = (matched?.[2] ?? "").trim();
    const args = rest ? rest.split(/\s+/) : [];

    await rememberPeer(msg);

    const currentBot = bot;
    if (!currentBot) return;

    if (!isAllowed(userId)) {
      if (cmd === "id" || cmd === "start") {
        await sendText(
          currentBot,
          peer,
          `🆔 你的 Telegram ID：<code>${esc(userId)}</code>\n把它填到「设置 → Telegram 机器人 → 允许的用户」后即可操作。`,
        );
        return;
      }
      await sendText(currentBot, peer, denyText(userId));
      return;
    }

    if (!cmd) {
      // 直接发链接就下载：不用记命令，把 t.me 消息链接丢过来即可
      const links = extractTelegramLinks(text);
      if (links.length) {
        await sendText(currentBot, peer, `🔗 收到 ${links.length} 个链接，正在解析…`);
        for (const link of links.slice(0, 5)) {
          try {
            await sendText(currentBot, peer, directText(await downloadFromLink(link)));
          } catch (err) {
            await sendText(currentBot, peer, `❌ ${esc(link)}\n${esc(errorText(err))}`);
          }
        }
        return;
      }

      // 第三方平台的分享口令：整段文字丢过来就能认（B站 <https://b23.tv/…>、
      // 小红书 xhslink.cn、抖音「复制打开抖音…」那一长串都算）
      const platformLinks = splitPlatformLinks(text);
      if (platformLinks.length) {
        await sendText(currentBot, peer, `🔗 识别到 ${platformLinks.length} 个平台链接，正在解析…`);
        const results = await enqueuePlatformLinks(platformLinks.slice(0, 5));
        const failures = results.filter((r) => !r.ok);
        // 整批同一个原因（比如平台没开、yt-dlp 不可用）只回一条
        if (failures.length === results.length && new Set(failures.map((f) => f.error ?? "")).size === 1) {
          await sendText(currentBot, peer, `❌ ${esc(failures[0].error ?? "解析失败")}`);
          return;
        }
        for (const result of results) {
          if (result.choice) {
            await sendText(currentBot, peer, platformChoiceText(result.choice), platformChoiceButtons(result.choice));
          } else {
            await sendText(currentBot, peer, platformQueuedText(result));
          }
        }
        return;
      }

      await sendText(
        currentBot,
        peer,
        "发 /help 查看可用命令，或直接发链接给我：\n" +
          "· Telegram 消息链接（https://t.me/频道/123）\n" +
          "· B站 / 抖音 / 小红书 / YouTube 分享口令（原样粘贴即可）",
        mainButtons(),
      );
      return;
    }

    const ctx: BotCtx = { userId, send: (t, b) => sendText(currentBot, peer, t, b) };
    const reply = await execute(cmd, args, ctx);
    await sendText(currentBot, peer, reply.text, reply.buttons);
  } catch (err) {
    logger.warn({ err: errorText(err) }, "机器人处理消息失败");
    const currentBot = bot;
    const peer = msg.inputChat ?? msg.chatId;
    if (currentBot && peer) {
      await sendText(currentBot, peer, `❌ 执行失败：${esc(errorText(err))}`).catch(() => undefined);
    }
  }
}

async function handleCallback(event: CallbackQueryEvent): Promise<void> {
  const data = event.data?.toString() ?? "";
  if (!data.startsWith("cmd:")) {
    await event.answer().catch(() => undefined);
    return;
  }
  const userId = String(event.query.userId ?? "");
  if (!isAllowed(userId)) {
    await event.answer({ message: "没有操作权限", alert: true }).catch(() => undefined);
    return;
  }

  const [cmd, ...args] = data.slice(4).split(" ").filter(Boolean);
  await event.answer().catch(() => undefined);
  try {
    const reply = await execute(cmd, args, {
      userId,
      send: async (text, buttons) => {
        await event.respond({ message: text, parseMode: "html", linkPreview: false, buttons });
      },
    });
    await event.respond({
      message: reply.text,
      parseMode: "html",
      linkPreview: false,
      buttons: reply.buttons,
    });
  } catch (err) {
    logger.warn({ err: errorText(err), cmd }, "机器人按钮操作失败");
    await event.respond({ message: `❌ 执行失败：${esc(errorText(err))}`, parseMode: "html" }).catch(() => undefined);
  }
}
