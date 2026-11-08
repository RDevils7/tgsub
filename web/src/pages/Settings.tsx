import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { formatBytes, formatDateTime } from "../utils";
import type {
  AppSettings,
  AuthState,
  BotIdentity,
  BotState,
  CacheStats,
  NetProbeReport,
  ProxyStatus,
  QrState,
  SettingsResponse,
} from "../types";
import { Badge, Button, Field, Spinner, StatusDot, Toggle, useToast } from "../components/ui";
import PlatformPanel from "../components/PlatformPanel";
import CollapsibleCard from "../components/CollapsibleCard";
import AccountPanel from "../components/AccountPanel";
import EmbySettingsPanel from "../components/EmbySettingsPanel";
import {
  IconAlert,
  IconBot,
  IconCheck,
  IconDownload,
  IconKey,
  IconLink,
  IconLogout,
  IconQr,
  IconRefresh,
  IconShield,
  IconSpark,
  IconTrash,
} from "../components/icons";

type LoginStep = "idle" | "code" | "password";

const MB = 1024 * 1024;

type SourceDirKey =
  | "dir_telegram"
  | "dir_bilibili"
  | "dir_xiaohongshu"
  | "dir_youtube"
  | "dir_m3u8";

/** 分来源保存目录：顺序与下载列表里的来源一致 */
const SOURCE_DIR_FIELDS: Array<{ key: SourceDirKey; label: string }> = [
  { key: "dir_telegram", label: "Telegram" },
  { key: "dir_bilibili", label: "B站" },
  { key: "dir_xiaohongshu", label: "小红书" },
  { key: "dir_youtube", label: "YouTube" },
  { key: "dir_m3u8", label: "网页 / m3u8" },
];

export default function Settings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  /** 登录状态要连 Telegram 探测，别让它挡住整页渲染 */
  const [authLoading, setAuthLoading] = useState(true);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const toast = useToast();

  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<LoginStep>("idle");
  const [loginBusy, setLoginBusy] = useState(false);
  const [sessionInput, setSessionInput] = useState("");
  const [showSessionBox, setShowSessionBox] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [qrPassword, setQrPassword] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [resetting, setResetting] = useState(false);

  const [botToken, setBotToken] = useState("");
  const [bot, setBot] = useState<BotState | null>(null);
  const [botBusy, setBotBusy] = useState(false);

  const [proxyInfo, setProxyInfo] = useState<ProxyStatus | null>(null);
  const [proxyBusy, setProxyBusy] = useState<null | "test">(null);
  const [probe, setProbe] = useState<NetProbeReport | null>(null);
  const [botTest, setBotTest] = useState<BotIdentity | null>(null);
  /** 改完 ffmpeg 路径保存后，让状态面板重新检测（用 key 强制重建） */
  const [ffmpegToken, setFfmpegToken] = useState(0);
  const [botTesting, setBotTesting] = useState(false);

  const [cache, setCache] = useState<CacheStats | null>(null);
  const [cacheBusy, setCacheBusy] = useState<null | "trim" | "clear">(null);
  /** 清空缓存要点两次：第一次只是把按钮变成「确认清空」 */
  const [confirmClear, setConfirmClear] = useState(false);

  // 缓存占用比例；上限为 0（不限制）时不画进度条
  const pct = cache?.limitMb ? Math.min(100, ((cache.total.bytes / (cache.limitMb * MB)) * 100)) : 0;

  const load = useCallback(async () => {
    try {
      // 只有 settings 是渲染整页必需的；其余三项后台补齐。
      // 以前四个一起 Promise.all：auth/state 要连 Telegram 探测、cache/status 要递归扫
      // 上千个缓存文件，最慢的那个决定整个设置页白屏多久。
      const settingsRes = await api.settings();
      setData(settingsRes);
      setDraft(settingsRes.settings);
      setBot(settingsRes.bot ?? null);
      setAuthLoading(true);
      void api
        .authState()
        .then(setAuth)
        .catch(() => undefined)
        .finally(() => setAuthLoading(false));
      void api.cacheStatus().then(setCache).catch(() => undefined);
      void api.proxyStatus().then(setProxyInfo).catch(() => undefined);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // 扫码登录期间轮询状态：二维码每 30 秒轮换一次，2 秒一轮足够
  useEffect(() => {
    if (!qr?.active) return undefined;
    let stopped = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const state = await api.qrState();
          if (stopped) return;
          setQr(state);
          if (state.status === "success") {
            toast.push("扫码登录成功", "success");
            await load();
          }
        } catch {
          /* 单次轮询失败忽略，下一轮继续 */
        }
      })();
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [qr?.active, load, toast]);

  /** 相对目录 → 绝对路径（只用于预览，真实的拼接与校验在服务端） */
  const previewDir = (rel: string): string => {
    const base = String(data?.paths?.downloadDir ?? "").replace(/[\\/]+$/, "");
    const tail = String(rel ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!tail) return base;
    // 跟着系统的写法走：Windows 用反斜杠，其它平台用正斜杠，别混着写成 downloads/telegram
    const sep = base.includes("\\") ? "\\" : "/";
    return `${base}${sep}${tail.split("/").join(sep)}`;
  };

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const saveSection = async (section: string, keys: Array<keyof AppSettings>) => {
    if (!draft) return;
    setSavingSection(section);
    try {
      const payload: Partial<AppSettings> = {};
      for (const key of keys) {
        (payload as Record<string, unknown>)[key as string] = draft[key];
      }
      const res = await api.saveSettings(payload);
      setData((prev) => (prev ? { ...prev, settings: res.settings } : prev));
      setDraft(res.settings);
      toast.push("设置已保存", "success");
      if (section === "api") setAuth(await api.authState());
      if (section === "cache") await refreshCache();
      if (section === "proxy") {
        setProxyInfo(await api.proxyStatus().catch(() => proxyInfo));
        // 代理变了，Telegram 会重新握手：状态要重新拉，否则界面上还是旧的在离线
        setAuth(await api.authState().catch(() => auth));
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSavingSection(null);
    }
  };

  /** 代理地址里现在写的协议（用于即时提示，不等保存） */
  const draftProxyScheme = (/^([a-z0-9]+):\/\//i.exec(draft?.proxy_url ?? "")?.[1] ?? "socks5").toLowerCase();
  const draftProxyIsHttp = draftProxyScheme === "http" || draftProxyScheme === "https";

  const runProxyTest = async () => {
    if (!draft) return;
    setProxyBusy("test");
    setProbe(null);
    try {
      const res = await api.proxyTest(draft.proxy_url);
      setProbe(res);
      const ok = res.results.filter((r) => r.ok).length;
      toast.push(
        `${ok}/${res.results.length} 个站点连通${res.viaProxy ? "（经代理）" : "（直连）"}`,
        ok === res.results.length ? "success" : ok > 0 ? "info" : "error",
      );
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setProxyBusy(null);
    }
  };

  /** 切换协议：只替换 scheme，地址与认证信息原地保留 */
  const switchProxyScheme = (scheme: string) => {
    const current = (draft?.proxy_url ?? "").trim();
    const rest = current.replace(/^[a-z0-9]+:\/\//i, "");
    patch("proxy_url", rest ? `${scheme}://${rest}` : `${scheme}://`);
  };

  const testBot = async () => {
    if (!draft) return;
    setBotTesting(true);
    setBotTest(null);
    try {
      const res = await api.botTest({
        token: botToken.trim() || undefined,
        proxyUrl: draft.proxy_url,
      });
      setBotTest(res.identity);
      toast.push(
        res.ok
          ? `Token 有效：@${res.identity?.username ?? res.identity?.id}`
          : res.error || res.identity?.error || "验证失败",
        res.ok ? "success" : "error",
      );
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBotTesting(false);
    }
  };

  const refreshCache = async () => {
    try {
      setCache(await api.cacheStatus());
    } catch {
      /* 状态拉不到不影响清理本身 */
    }
  };

  const runCacheTrim = async () => {
    setCacheBusy("trim");
    try {
      const res = await api.cacheTrim();
      setCache(res.stats);
      toast.push(res.message, res.triggered ? "success" : "info");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setCacheBusy(null);
    }
  };

  const runCacheClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      toast.push("再点一次「确认清空」就会删掉全部缓存", "info");
      window.setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    setConfirmClear(false);
    setCacheBusy("clear");
    try {
      const res = await api.cacheClear();
      setCache(res.stats);
      toast.push(res.message, "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setCacheBusy(null);
    }
  };

  const saveBot = async () => {
    if (!draft) return;
    setBotBusy(true);
    try {
      const payload: Partial<AppSettings> & { bot_token?: string } = {
        bot_enabled: draft.bot_enabled,
        bot_allow_users: draft.bot_allow_users,
        bot_notify: draft.bot_notify,
      };
      if (botToken.trim()) payload.bot_token = botToken.trim();
      const res = await api.saveSettings(payload);
      setData((prev) => (prev ? { ...prev, settings: res.settings, bot: res.bot ?? prev.bot } : prev));
      setDraft(res.settings);
      if (res.bot) setBot(res.bot);
      setBotToken("");
      toast.push(draft.bot_enabled ? "机器人设置已保存，正在连接…" : "已关闭机器人", "success");

      // 重新握手要走代理，几秒后才连上：轮询几次把结果带回来
      if (draft.bot_enabled) {
        for (let i = 0; i < 6; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const state = await api.botState().catch(() => null);
          if (!state) continue;
          setBot(state.bot);
          if (state.bot.running || state.bot.error) break;
        }
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBotBusy(false);
    }
  };

  const restartBot = async () => {
    setBotBusy(true);
    try {
      await api.botRestart();
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const state = await api.botState().catch(() => null);
        if (!state) continue;
        setBot(state.bot);
        if (state.bot.running || state.bot.error) break;
      }
      toast.push("已重新连接机器人", "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBotBusy(false);
    }
  };

  const sendCode = async () => {
    if (!phone.trim()) {
      toast.push("请输入手机号（含国际区号）", "error");
      return;
    }
    setLoginBusy(true);
    try {
      await api.sendCode(phone.trim());
      setStep("code");
      setCooldown(60);
      toast.push("验证码已发送，请在 Telegram 中查看", "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoginBusy(false);
    }
  };

  const submitCode = async () => {
    if (!code.trim()) {
      toast.push("请输入验证码", "error");
      return;
    }
    setLoginBusy(true);
    try {
      const res = await api.signIn(code.trim());
      if (res.passwordNeeded) {
        setStep("password");
        toast.push("该账号开启了两步验证，请输入密码", "info");
      } else {
        toast.push("登录成功", "success");
        setStep("idle");
        setCode("");
        setPhone("");
        if (res.auth) setAuth(res.auth);
        await load();
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoginBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!password) {
      toast.push("请输入两步验证密码", "error");
      return;
    }
    setLoginBusy(true);
    try {
      const res = await api.submitPassword(password);
      toast.push("登录成功", "success");
      setStep("idle");
      setPassword("");
      setPhone("");
      setCode("");
      setAuth(res.auth);
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoginBusy(false);
    }
  };

  const importSession = async () => {
    if (!sessionInput.trim()) {
      toast.push("请粘贴 session", "error");
      return;
    }
    setLoginBusy(true);
    try {
      const res = await api.importSession(sessionInput.trim());
      setAuth(res.auth);
      setSessionInput("");
      setShowSessionBox(false);
      toast.push("session 导入成功", "success");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoginBusy(false);
    }
  };

  const retryAuth = async () => {
    setRetrying(true);
    try {
      const res = await api.authRetry();
      setAuth(res.auth);
      toast.push(res.auth.authorized ? "连接已恢复，无需重新扫码" : "凭据确实失效了，请重新扫码登录", res.auth.authorized ? "success" : "error");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setRetrying(false);
    }
  };

  /**
   * 彻底重置登录状态。
   *
   * 服务器已把 authKey 作废时（AUTH_KEY_UNREGISTERED / SESSION_REVOKED），
   * 光重新扫码不够：本地那份被判死的 session 和备份还在，
   * 重新登录时会被一起加载出来互相打架。先清干净再重新扫码才有效。
   */
  const resetAuth = async () => {
    setResetting(true);
    try {
      const res = await api.authReset();
      setAuth(res.auth);
      setQr(null);
      toast.push("已清除本地登录凭据，请重新扫码登录", "success");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setResetting(false);
    }
  };

  const logout = async () => {
    setLoginBusy(true);
    try {
      await api.logout();
      toast.push("已退出登录", "success");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setLoginBusy(false);
    }
  };

  const startQr = async () => {
    setQrBusy(true);
    try {
      const state = await api.qrStart();
      setQr(state);
      if (state.status === "error" && state.error) toast.push(state.error, "error");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setQrBusy(false);
    }
  };

  const cancelQr = async () => {
    try {
      await api.qrCancel();
    } catch {
      /* ignore */
    }
    setQr(null);
    setQrPassword("");
  };

  const submitQrPwd = async () => {
    if (!qrPassword) {
      toast.push("请输入两步验证密码", "error");
      return;
    }
    setQrBusy(true);
    try {
      const state = await api.qrPassword(qrPassword);
      setQr(state);
      setQrPassword("");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setQrBusy(false);
    }
  };

  if (!data || !draft) {
    return (
      <div className="flex h-64 items-center justify-center text-slate-500">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  const isLoggedIn = Boolean(auth?.authorized);
  /** 首次进来还没拿到登录状态时显示骨架，刷新时保留旧状态不闪 */
  const showAuthSkeleton = authLoading && !auth;

  const botStatus = !draft.bot_enabled
    ? {
        dot: "bg-slate-500",
        tone: "border-white/10 bg-white/[0.03] text-slate-400",
        // Token 已存在却关着开关时，说清楚这是「没启用」而不是「坏了」
        label: bot?.tokenHint ? "未启用 · Token 已保存" : "未启用",
      }
    : bot?.running
      ? {
          dot: "bg-emerald-400",
          tone: "border-emerald-500/25 bg-emerald-500/10 text-ok",
          label: `在线 · @${bot.username ?? bot.userId ?? "bot"}`,
        }
      : bot?.error
        ? { dot: "bg-rose-400", tone: "border-rose-500/25 bg-rose-500/10 text-err", label: "连接失败" }
        : { dot: "bg-amber-400", tone: "border-amber-500/25 bg-amber-500/10 text-warn", label: "连接中…" };

  return (
    <div className="space-y-5">
      {/* Telegram 账号 */}
      <CollapsibleCard
        id="account"
        tint="brand"
        icon={<IconShield className="h-4 w-4" />}
        title="Telegram 账号"
        desc="登录后可读取频道消息，session 会加密保存在本地数据库"
        defaultOpen
        extra={
          <>
            {showAuthSkeleton ? (
              <Badge className="border-white/10 bg-white/[0.03] text-slate-400">
                <Spinner className="h-3 w-3" />
                检测中
              </Badge>
            ) : isLoggedIn ? (
              <Badge className="border-emerald-500/20 bg-emerald-500/10 text-ok">
                <StatusDot className="bg-emerald-400" />
                已登录
              </Badge>
            ) : (
              <Badge className="border-amber-500/20 bg-amber-500/10 text-warn">
                <StatusDot className="bg-amber-400" />
                未登录
              </Badge>
            )}
          </>
        }
      >

        <div className="mt-4">
          {showAuthSkeleton ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-[12.5px] text-slate-400">
              <Spinner className="h-4 w-4" />
              正在检测 Telegram 登录状态…
            </div>
          ) : isLoggedIn ? (
            <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-gradient text-[13px] font-semibold text-onbrand">
                  {(auth?.me?.firstName || auth?.me?.username || "T").slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <p className="text-[13px] font-medium text-white">
                    {auth?.me?.firstName || "Telegram 用户"}
                    {auth?.me?.username && <span className="ml-1.5 text-[12px] text-slate-500">@{auth.me.username}</span>}
                  </p>
                  <p className="text-[11px] text-slate-500">ID: {auth?.me?.id}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void load()}>
                  刷新状态
                </Button>
                <Button size="sm" variant="danger" onClick={() => void logout()} loading={loginBusy}>
                  <IconLogout className="h-3 w-3" />
                  退出登录
                </Button>
              </div>
            </div>
            <p className="flex items-center gap-1.5 pl-1 text-[11px] text-slate-500">
              <IconKey className="h-3 w-3 shrink-0" />
              登录凭据已加密存于本地数据库{auth?.sessionSavedAt ? `（${formatDateTime(auth.sessionSavedAt)} 校验通过）` : ""}
              ，重启服务、重建容器都不需要重新扫码
            </p>
            </div>
          ) : (
            <div className="space-y-3">
              {auth?.sessionState === "dead" && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3">
                  <p className="text-[12.5px] font-medium text-warn">本地登录凭据已被 Telegram 判定失效</p>
                  {auth.riskSuspect && (
                    <div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/[0.08] px-3 py-2.5">
                      <p className="text-[12px] font-medium text-err">
                        疑似 Telegram 风控处置，不是本站的故障
                      </p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-slate-300">
                        Telegram 已把你的全部登录会话重置（其他设备会被一起踢下线），并可能冻结相关机器人、
                        重置它们的 Token。这是它对「账号可疑活动」的标准处置，在本地反复重新登录不会让它恢复。
                      </p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
                        正确做法：在手机 Telegram 打开 <span className="text-slate-200">@SpamBot</span>
                        {" "}发送 /start 查看状态并申诉，恢复前不要再反复扫码。
                      </p>
                    </div>
                  )}
                  {/*
                    分两种情况给不同指引：
                    - 可自愈（AUTH_KEY_DUPLICATED）：只是重启时新旧连接短暂撞车，点重试即可；
                    - 不可自愈（服务器已作废）：重试多少次都没用，必须先清掉本地旧凭据再重新扫码。
                    之前一律提示「先点重试连接」，用户点了很多次也没用。
                  */}
                  {auth.sessionRecoverable ? (
                    <>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
                        多数情况是重启时旧进程还没退出、新旧连接短暂共用了同一个 authKey。
                        点「重试连接」通常能直接恢复，不必重新扫码。
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="primary" loading={retrying} onClick={() => void retryAuth()}>
                          重试连接
                        </Button>
                        <Button size="sm" loading={resetting} onClick={() => void resetAuth()}>
                          彻底重置并重新登录
                        </Button>
                        <Button size="sm" onClick={() => setShowSessionBox(true)}>
                          手动导入 session
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
                        服务器已把这个登录凭据作废（{auth.sessionErrorCode || "AUTH_KEY_INVALID"}），
                        重试连接不会恢复，必须重新登录。
                        请先「彻底重置」清掉本地残留的旧凭据，再重新扫码 —— 否则新旧凭据会互相打架，新扫出来的也会立刻失效。
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="primary" loading={resetting} onClick={() => void resetAuth()}>
                          彻底重置并重新登录
                        </Button>
                        <Button size="sm" onClick={() => setShowSessionBox(true)}>
                          手动导入 session
                        </Button>
                      </div>
                    </>
                  )}
                  {auth.error && (
                    <p className="mt-2 text-[11px] leading-relaxed text-slate-500">最近一次错误：{auth.error}</p>
                  )}
                </div>
              )}
              {qr && (qr.status === "waiting" || qr.status === "scanned" || qr.status === "password") ? (
                <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.05] p-3.5">
                  {qr.status === "password" ? (
                    <div className="space-y-2">
                      <p className="text-[12.5px] text-slate-200">
                        该账号开启了两步验证{qr.passwordHint ? `（提示：${qr.passwordHint}）` : ""}
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          className="field flex-1"
                          placeholder="两步验证密码"
                          value={qrPassword}
                          onChange={(e) => setQrPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void submitQrPwd();
                          }}
                        />
                        <Button variant="primary" size="sm" onClick={() => void submitQrPwd()} loading={qrBusy}>
                          提交
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <div className="flex h-[168px] w-[168px] shrink-0 items-center justify-center rounded-xl bg-[#fff] p-2">
                        {qr.qrDataUrl ? (
                          <img src={qr.qrDataUrl} alt="Telegram 登录二维码" className="h-full w-full" />
                        ) : (
                          <Spinner className="h-5 w-5 text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <p className="text-[13px] font-medium text-white">用手机 Telegram 扫码登录</p>
                        <p className="text-[11.5px] leading-relaxed text-slate-400">
                          手机 Telegram → 设置 → 设备 → 链接桌面设备 → 扫描左侧二维码
                        </p>
                        <p className="text-[11.5px] text-brand-300">
                          {qr.status === "scanned" ? "已扫描，请在手机上确认登录" : "等待扫描…"}
                        </p>
                        <p className="text-[11px] text-slate-500">凭据来源：{qr.appLabel ?? "—"}</p>
                        <Button size="sm" onClick={() => void cancelQr()}>
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Button variant="primary" onClick={() => void startQr()} loading={qrBusy}>
                    <IconQr className="h-3.5 w-3.5" />
                    扫码登录
                  </Button>
                  <p className="text-[11.5px] text-slate-500">
                    无需申请 api_id，手机扫一下即可；国内网络请先在下方配置代理
                  </p>
                </div>
              )}

              {qr?.status === "error" && qr.error && (
                <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3.5 py-3">
                  <p className="text-[12.5px] font-medium text-err">登录失败</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-slate-300">{qr.error}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => void startQr()} loading={qrBusy}>
                      重新生成二维码
                    </Button>
                    <Button size="sm" loading={resetting} onClick={() => void resetAuth()}>
                      彻底重置并重新登录
                    </Button>
                    <span className="text-[11px] text-slate-500">
                      详细过程可在「日志」页查看
                    </span>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="h-px flex-1 bg-white/[0.06]" />
                <span className="text-[10.5px] uppercase tracking-wider text-slate-600">或使用手机号</span>
                <span className="h-px flex-1 bg-white/[0.06]" />
              </div>

              {step === "idle" && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    className="field flex-1"
                    placeholder="+8613800000000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !loginBusy) void sendCode();
                    }}
                  />
                  <Button variant="primary" onClick={() => void sendCode()} loading={loginBusy}>
                    发送验证码
                  </Button>
                </div>
              )}

              {step === "code" && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    className="field flex-1 font-mono tracking-[0.3em]"
                    placeholder="Telegram 验证码"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !loginBusy) void submitCode();
                    }}
                  />
                  <Button variant="primary" onClick={() => void submitCode()} loading={loginBusy}>
                    确认登录
                  </Button>
                  <Button
                    onClick={() => void sendCode()}
                    disabled={cooldown > 0 || loginBusy}
                    title="重新发送验证码"
                  >
                    {cooldown > 0 ? `${cooldown}s` : "重新发送"}
                  </Button>
                </div>
              )}

              {step === "password" && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    className="field flex-1"
                    placeholder="两步验证密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !loginBusy) void submitPassword();
                    }}
                  />
                  <Button variant="primary" onClick={() => void submitPassword()} loading={loginBusy}>
                    提交密码
                  </Button>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowSessionBox((v) => !v)}
                  className="text-[12px] text-slate-500 transition hover:text-brand-300"
                >
                  {showSessionBox ? "收起" : "或导入已有 session →"}
                </button>
                {step !== "idle" && (
                  <button
                    onClick={() => {
                      setStep("idle");
                      setCode("");
                      setPassword("");
                    }}
                    className="text-[12px] text-slate-500 transition hover:text-slate-300"
                  >
                    返回
                  </button>
                )}
              </div>

              {showSessionBox && (
                <div className="space-y-2">
                  <textarea
                    className="field min-h-[80px] font-mono text-[11.5px]"
                    placeholder="粘贴 StringSession 内容"
                    value={sessionInput}
                    onChange={(e) => setSessionInput(e.target.value)}
                  />
                  <Button size="sm" onClick={() => void importSession()} loading={loginBusy}>
                    导入 session
                  </Button>
                </div>
              )}

              {!auth?.configured && (
                <p className="text-[11.5px] leading-relaxed text-warn/80">
                  当前为「自定义 API」模式但尚未填写 api_id / api_hash，请在下方补全，或切换回内置凭证。
                </p>
              )}
              {auth?.error && <p className="text-[11.5px] leading-relaxed text-err/80">{auth.error}</p>}
            </div>
          )}
        </div>
      </CollapsibleCard>

      {/* 网络与代理：协议可选 socks4/5、http、https，自带连通性测试 */}
      <CollapsibleCard
        id="proxy"
        tint="cyan"
        icon={<IconLink className="h-4 w-4" />}
        title="网络与代理"
        desc="访问 Telegram 需要代理时填在这里；保存后账号与机器人会重新握手，留空表示直连"
        extra={
          <Badge
            className={
              draft.proxy_url.trim()
                ? "border-cyan-500/25 bg-cyan-500/10 text-cyan-300"
                : "border-white/10 bg-white/[0.03] text-slate-400"
            }
          >
            {draft.proxy_url.trim() ? `${draftProxyScheme.toUpperCase()} · 已配置` : "直连"}
          </Badge>
        }
      >

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[132px_minmax(0,1fr)]">
          <Field label="协议" hint="Telegram 只能用 SOCKS">
            <select className="field" value={draftProxyScheme} onChange={(e) => switchProxyScheme(e.target.value)}>
              {(
                proxyInfo?.schemes ?? [
                  { value: "socks5", label: "SOCKS5", hint: "" },
                  { value: "socks5h", label: "SOCKS5H", hint: "" },
                  { value: "socks4", label: "SOCKS4", hint: "" },
                  { value: "http", label: "HTTP", hint: "" },
                  { value: "https", label: "HTTPS", hint: "" },
                ]
              ).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="代理地址"
            hint="主机:端口，也可以带用户名密码：socks5://user:pass@host:port"
          >
            <input
              className="field font-mono text-[12.5px]"
              placeholder="socks5://192.168.5.2:7890"
              value={draft.proxy_url}
              onChange={(e) => patch("proxy_url", e.target.value)}
            />
          </Field>
        </div>

        {proxyInfo?.problem && (
          <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-err">
            <IconAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {proxyInfo.problem}
          </p>
        )}

        {draftProxyIsHttp && (
          <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-warn">
            <IconAlert className="mt-0.5 h-3 w-3 shrink-0" />
            HTTP(S) 代理只能用于联网检测与 Bot API 校验；Telegram 的 MTProto 连接是裸 TCP，
            只能走 SOCKS4 / SOCKS5。保存当前设置后，账号会连不上。
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">
            {proxyInfo?.proxy
              ? `当前生效：${proxyInfo.proxy.scheme}://${proxyInfo.proxy.host}:${proxyInfo.proxy.port}${
                  proxyInfo.proxy.hasAuth ? "（带认证）" : ""
                }`
              : "当前未使用代理，所有请求直连"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                patch("proxy_url", "");
                setProbe(null);
                toast.push("已清空输入，点「保存代理」后生效", "info");
              }}
              disabled={!draft.proxy_url}
            >
              清空
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveSection("proxy", ["proxy_url"])}
              loading={savingSection === "proxy"}
            >
              保存代理
            </Button>
            <Button size="sm" variant="primary" onClick={() => void runProxyTest()} loading={proxyBusy === "test"}>
              <IconRefresh className="h-3 w-3" />
              Ping 测试
            </Button>
          </div>
        </div>

        {probe && (
          <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] text-slate-300">
                Ping 测试 · {probe.viaProxy ? "经代理" : "直连"} · 用时 {(probe.elapsedMs / 1000).toFixed(1)}s
              </p>
              <p className="text-[11px] text-slate-500">
                {probe.results.filter((r) => r.ok).length}/{probe.results.length} 连通
              </p>
            </div>
            <ul className="mt-2 space-y-1">
              {probe.results.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <StatusDot className={item.ok ? "bg-emerald-400" : "bg-rose-400"} />
                  <span className="text-slate-300">{item.label}</span>
                  <span className="truncate text-[11px] text-slate-600">{item.url}</span>
                  <span className={`ml-auto font-mono text-[11px] ${item.ok ? "text-ok" : "text-err"}`}>
                    {item.ok ? `${item.status} · ${item.ms} ms` : item.error}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              拿到 HTTP 状态码就算通（403/404 也是通）。成功但下载异常时，多半是该站点被限速或证书被中间人代理替换。
            </p>
          </div>
        )}

        {/* 网页 / m3u8 下载的线路：默认直连优先，不通才回退代理 */}
        <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12.5px] font-medium text-slate-200">网页 / m3u8 视频下载</p>
            <Badge
              className={
                draft.m3u8_proxy_mode === "always"
                  ? "border-sky-500/25 bg-sky-500/10 text-sky-300"
                  : draft.m3u8_proxy_mode === "off"
                    ? "border-white/10 bg-white/[0.03] text-slate-400"
                    : "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
              }
            >
              {draft.m3u8_proxy_mode === "always"
                ? "强制走代理"
                : draft.m3u8_proxy_mode === "off"
                  ? "只直连"
                  : "直连优先"}
            </Badge>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[132px_minmax(0,1fr)]">
            <Field label="线路策略" hint="默认直连优先">
              <select
                className="field"
                value={draft.m3u8_proxy_mode}
                onChange={(e) => patch("m3u8_proxy_mode", e.target.value as "auto" | "always" | "off")}
              >
                <option value="auto">直连优先</option>
                <option value="always">强制走代理</option>
                <option value="off">只用直连</option>
              </select>
            </Field>
            <Field
              label="代理地址"
              hint="留空则用环境变量 M3U8_BROWSER_PROXY / HTTPS_PROXY；SOCKS 会被转成本地桥给 ffmpeg 用"
            >
              <input
                className="field font-mono text-[12.5px]"
                placeholder="socks5://192.168.5.2:7890"
                value={draft.m3u8_proxy}
                onChange={(e) => patch("m3u8_proxy", e.target.value)}
              />
            </Field>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            「直连优先」= 先不用代理直接连源站，连不上（超时 / DNS 失败）才自动改走代理，
            并记住这个域名下次直接用代理。下载列表每条任务都会标出走的是直连还是代理。
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                patch("m3u8_proxy", "");
                patch("m3u8_proxy_mode", "auto");
                toast.push("已清空输入，点「保存线路」后生效", "info");
              }}
              disabled={!draft.m3u8_proxy && draft.m3u8_proxy_mode === "auto"}
            >
              恢复默认
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveSection("webproxy", ["m3u8_proxy", "m3u8_proxy_mode"])}
              loading={savingSection === "webproxy"}
            >
              保存线路
            </Button>
          </div>
        </div>
      </CollapsibleCard>

      {/* 扫描策略 */}
      <CollapsibleCard
        id="scan"
        tint="emerald"
        icon={<IconSpark className="h-4 w-4" />}
        title="扫描策略"
        desc="控制扫描频率与每次读取的消息数量"
      >

        <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <div>
            <p className="text-[13px] text-slate-200">自动扫描</p>
            <p className="mt-0.5 text-[11px] text-slate-500">关闭后只能手动触发扫描</p>
          </div>
          <Toggle checked={draft.auto_scan} onChange={(next) => patch("auto_scan", next)} />
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="扫描间隔（分钟）">
            <input
              type="number"
              min={1}
              max={1440}
              className="field"
              value={draft.scan_interval_minutes}
              onChange={(e) => patch("scan_interval_minutes", Number(e.target.value))}
            />
          </Field>
          <Field label="首次扫描消息数" hint="新频道只回溯最近 N 条">
            <input
              type="number"
              min={1}
              max={500}
              className="field"
              value={draft.initial_scan_messages}
              onChange={(e) => patch("initial_scan_messages", Number(e.target.value))}
            />
          </Field>
          <Field label="单批拉取条数" hint="建议 50-100，过大易触发限流">
            <input
              type="number"
              min={10}
              max={100}
              className="field"
              value={draft.batch_size}
              onChange={(e) => patch("batch_size", Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              void saveSection("scan", ["auto_scan", "scan_interval_minutes", "initial_scan_messages", "batch_size"])
            }
            loading={savingSection === "scan"}
          >
            保存策略
          </Button>
        </div>
      </CollapsibleCard>

      {/* 下载 */}
      <CollapsibleCard
        id="download"
        tint="amber"
        icon={<IconDownload className="h-4 w-4" />}
        title="下载设置"
        desc="并发数、文件大小过滤与存储路径规则"
      >

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="并发下载数" hint="当前固定逐条下载：媒体在别的数据中心，并发会互相打断">
            <input
              type="number"
              min={1}
              max={10}
              className="field"
              value={draft.concurrency}
              onChange={(e) => patch("concurrency", Number(e.target.value))}
            />
          </Field>
          <Field label="最小文件大小（MB）" hint="0 表示不过滤；仅对图片/文档生效，视频始终下载">
            <input
              type="number"
              min={0}
              className="field"
              value={Math.round((draft.min_file_size / MB) * 100) / 100}
              onChange={(e) => patch("min_file_size", Math.round(Number(e.target.value) * MB))}
            />
          </Field>
          <Field label="最大文件大小（MB）" hint="0 表示不限制；仅对图片/文档生效，视频始终下载">
            <input
              type="number"
              min={0}
              className="field"
              value={Math.round((draft.max_file_size / MB) * 100) / 100}
              onChange={(e) => patch("max_file_size", Math.round(Number(e.target.value) * MB))}
            />
          </Field>
          <Field
            label="存储路径模板"
            hint="可用变量：{date} {channel} {name} {id}。正文里带《剧名》的短剧不受此模板影响，统一按「剧名/剧名S01E04.mp4」归档"
            className="sm:col-span-3"
          >
            <input
              className="field font-mono text-[12.5px]"
              value={draft.file_template}
              onChange={(e) => patch("file_template", e.target.value)}
            />
          </Field>
        </div>

        {/* 分来源保存目录：每条下载链路各一个顶层目录，可改名、可加层级 */}
        <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">分来源保存目录</p>
            <span className="text-[11px] text-slate-600">相对下载根；留空 = 直接放根下</span>
          </div>
          <div className="mt-2.5 space-y-3">
            {SOURCE_DIR_FIELDS.map(({ key, label }) => (
              <div
                key={key}
                className="grid grid-cols-1 gap-1 sm:grid-cols-[84px_minmax(0,1fr)] sm:items-start sm:gap-x-3"
              >
                <span className="pt-2 text-[12px] text-slate-400">{label}</span>
                <div>
                  <input
                    className="field font-mono text-[12.5px]"
                    value={draft[key]}
                    onChange={(e) => patch(key, e.target.value)}
                    placeholder="（空）"
                    spellCheck={false}
                  />
                  <p className="mt-1 break-all font-mono text-[10.5px] text-slate-400">
                    {previewDir(draft[key])}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-600">
            默认 <span className="font-mono text-slate-500">telegram / B站 / 小红书 / youtube / m3u8</span>，
            可以改名，也可以加一层（如 <span className="font-mono text-slate-500">影视/B站</span>）。
            只能填下载目录内的相对路径 —— 元数据页、删除校验与 Emby 路径映射都建立在「下载根之下」这个前提上。
          </p>
        </div>

        <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">存储位置</p>
          <dl className="mt-2 space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="shrink-0 text-[11.5px] text-slate-400">下载目录</dt>
              <dd className="break-all font-mono text-[11.5px] text-slate-300">
                {data.paths.downloadDir}
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="shrink-0 text-[11.5px] text-slate-400">数据目录</dt>
              <dd className="break-all font-mono text-[11.5px] text-slate-300">
                {data.paths.dataDir}
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="shrink-0 text-[11.5px] text-slate-500">数据库文件</dt>
              <dd className="break-all font-mono text-[11px] text-slate-600">
                {data.paths.dbFile}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] text-slate-600">
            Docker 部署时下载目录与数据目录是两个独立挂载点，下载目录可单独指向大容量盘；
            两者由环境变量 DOWNLOAD_DIR / DATA_DIR 决定，重启后生效。
          </p>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              void saveSection("download", [
                "concurrency",
                "min_file_size",
                "max_file_size",
                "file_template",
                ...SOURCE_DIR_FIELDS.map((field) => field.key),
              ])
            }
            loading={savingSection === "download"}
          >
            保存设置
          </Button>
        </div>
      </CollapsibleCard>

      {/* 第三方平台：B站 / 小红书 / YouTube，引擎 yt-dlp */}
      <PlatformPanel />

      {/* Emby 媒体库：媒体信息生成、入库通知与 Emby 端配置说明 */}
      <EmbySettingsPanel />

      {/* 缓存：covers 与 frames 都是可重建的缓存，可设上限自动清理 */}
      <CollapsibleCard
        id="cache"
        tint="sky"
        icon={<IconTrash className="h-4 w-4" />}
        title="缓存清理"
        desc="封面预览与截帧候选图存在 data 目录下，删掉会自动重建；数据库、下载文件与日志不受影响"
        extra={
          <Badge
            className={
              (cache?.overBytes ?? 0) > 0
                ? "border-amber-500/25 bg-amber-500/10 text-warn"
                : "border-sky-500/20 bg-sky-500/10 text-sky-300"
            }
          >
            {cache ? formatBytes(cache.total.bytes) : "—"}
          </Badge>
        }
      >

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { label: "合计", usage: cache?.total, note: `${cache?.total.groups ?? 0} 组` },
            { label: "封面预览", usage: cache?.covers, note: "消息列表用" },
            { label: "截帧缓存", usage: cache?.frames, note: "元数据页用" },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3"
            >
              <p className="text-[11px] uppercase tracking-wider text-slate-500">{item.label}</p>
              <p className="mt-1 font-mono text-[15px] text-white">{formatBytes(item.usage?.bytes ?? 0)}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {item.usage?.files ?? 0} 个文件 · {item.note}
              </p>
            </div>
          ))}
        </div>

        {cache && cache.limitMb > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                已用 {formatBytes(cache.total.bytes)} / 上限 {cache.limitMb} MB
              </span>
              <span
                className={
                  pct >= 90 ? "text-err" : pct >= 70 ? "text-warn" : "text-slate-400"
                }
              >
                {pct.toFixed(0)}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={
                  pct >= 90 ? "h-full rounded-full bg-rose-400/80" : pct >= 70 ? "h-full rounded-full bg-amber-400/80" : "h-full rounded-full bg-sky-400/70"
                }
                style={{ width: `${Math.max(1.5, Math.min(100, pct))}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field
            label="缓存上限（MB）"
            hint="超过上限时自动清理最旧的那批，留出 20% 余量；填 0 表示不自动清理"
            className="w-full sm:w-56"
          >
            <input
              type="number"
              min={0}
              max={102400}
              className="field"
              value={draft.cache_limit_mb}
              onChange={(e) => patch("cache_limit_mb", Number(e.target.value))}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2 pb-[19px]">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveSection("cache", ["cache_limit_mb"])}
              loading={savingSection === "cache"}
            >
              保存上限
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void runCacheTrim()}
              loading={cacheBusy === "trim"}
              disabled={!draft.cache_limit_mb}
            >
              按上限清理一次
            </Button>
            <Button
              variant={confirmClear ? "danger" : "ghost"}
              size="sm"
              onClick={() => void runCacheClear()}
              loading={cacheBusy === "clear"}
            >
              {confirmClear ? "确认清空" : "一键清空"}
            </Button>
          </div>
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          {cache?.lastTrimAt
            ? `上次${
                cache.lastTrimReason === "clear"
                  ? "清空"
                  : cache.lastTrimReason === "auto"
                    ? "自动清理"
                    : "手动清理"
              }：${formatDateTime(cache.lastTrimAt)}，释放 ${formatBytes(cache.lastTrimFreed)}`
            : "还没有清理过。下载完成与截帧之后会各检查一次，超过上限自动清理。"}
        </p>
      </CollapsibleCard>

      {/* Telegram 机器人 */}
      <CollapsibleCard
        id="bot"
        tint="emerald"
        icon={<IconBot className="h-4 w-4" />}
        title="Telegram 机器人"
        desc="给机器人发一条消息就能扫描频道、增删订阅、看下载进度，不用打开网页"
        extra={
          <Badge className={botStatus.tone}>
            <span className={`h-1.5 w-1.5 rounded-full ${botStatus.dot}`} />
            {botStatus.label}
          </Badge>
        }
      >

        <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <div className="pr-4">
            <p className="text-[13px] text-slate-200">启用机器人控制</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              机器人用独立的 bot token 登录，和账号的扫码 session 互不影响，也不会占用扫描连接
            </p>
          </div>
          <Toggle checked={draft.bot_enabled} onChange={(next) => patch("bot_enabled", next)} />
        </div>

        {!draft.bot_enabled && bot?.tokenHint && (
          <p className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-slate-400">
            Token 已保存（{bot.tokenHint}）。打开上面的开关，再点右下角「保存并连接」就会上线；
            开关本身只是草稿，不保存不会生效。
          </p>
        )}

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Bot Token"
            hint={
              bot?.tokenHint
                ? `已保存 ${bot.tokenHint}，留空表示不修改`
                : "在 Telegram 里找 @BotFather，发送 /newbot 获取"
            }
          >
            <input
              type="password"
              className="field font-mono text-[12.5px]"
              placeholder={bot?.tokenHint ? "留空保持不变" : "123456789:AAH…"}
              value={botToken}
              autoComplete="new-password"
              onChange={(e) => setBotToken(e.target.value)}
            />
          </Field>
          <Field
            label="允许的用户"
            hint="只填数字 ID，逗号分隔。先给机器人发 /id，它会告诉你自己的 ID"
          >
            <input
              className="field font-mono text-[12.5px]"
              placeholder="123456789"
              value={draft.bot_allow_users}
              onChange={(e) => patch("bot_allow_users", e.target.value)}
            />
          </Field>
        </div>

        {botTest && (
          <div
            className={`mt-3 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[11.5px] leading-relaxed ${
              botTest.ok
                ? "border-emerald-500/25 bg-emerald-500/[0.06] text-ok"
                : "border-rose-500/25 bg-rose-500/[0.06] text-err"
            }`}
          >
            {botTest.ok ? (
              <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <div>
              {botTest.ok
                ? `Token 有效：@${botTest.username ?? botTest.id}${botTest.name ? `（${botTest.name}）` : ""} · ID ${botTest.id}${
                    botTest.ms !== null ? ` · ${botTest.ms} ms` : ""
                  }`
                : botTest.error}
              <p className="mt-0.5 text-[11px] text-slate-500">
                这一步走的是 Bot API（普通 HTTPS，会经过上面的代理）：通了说明 token 与网络都没问题，
                机器人仍未在线就说明 MTProto 那条连接被挡了。
              </p>
            </div>
          </div>
        )}

        {bot?.error && draft.bot_enabled && (
          <p className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.07] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-err">
            {bot.error}
          </p>
        )}

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">常用命令</p>
            <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-400">{`/status   运行状态（带按钮）
/scan     立即扫描（可跟频道名）
/channels 频道列表
/subs     订阅规则
/sub 关键词  新建订阅
/tasks    最近下载
/pause    暂停自动扫描`}</pre>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">怎么开始</p>
            <ol className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-slate-400">
              <li>1. @BotFather 发 /newbot，拿到 token 填到左边</li>
              <li>2. 保存后会自动连接，状态变成「在线」</li>
              <li>3. 在 Telegram 里给机器人发 /id，复制返回的数字</li>
              <li>4. 把 ID 填进「允许的用户」再保存一次</li>
              <li>5. 之后发 /help 就能用了</li>
            </ol>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <label className="flex items-center gap-2 text-[12px] text-slate-400">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-emerald-500"
              checked={draft.bot_notify}
              onChange={(e) => patch("bot_notify", e.target.checked)}
            />
            定时扫描发现新内容时推送到 Telegram
          </label>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void testBot()}
              loading={botTesting}
              disabled={!botToken.trim() && !bot?.tokenSet}
            >
              <IconRefresh className="h-3 w-3" />
              测试 Token
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void restartBot()}
              loading={botBusy}
              disabled={!draft.bot_enabled}
            >
              重新连接
            </Button>
            <Button variant="primary" size="sm" onClick={() => void saveBot()} loading={botBusy}>
              保存并连接
            </Button>
          </div>
        </div>
      </CollapsibleCard>

      {/* API 凭证 */}
      <CollapsibleCard
        id="credentials"
        tint="violet"
        icon={<IconKey className="h-4 w-4" />}
        title="API 凭证"
        desc="使用内置凭证可跳过 my.telegram.org 申请；也可切换为自建应用（改完需要重新连接）"
      >

        <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
          <button
            onClick={() => patch("credential_mode", "builtin")}
            className={`rounded-lg px-3 py-2 text-[12.5px] transition ${
              draft.credential_mode === "builtin"
                ? "bg-brand-500/15 font-medium text-brand-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            内置凭证（免申请）
          </button>
          <button
            onClick={() => patch("credential_mode", "custom")}
            className={`rounded-lg px-3 py-2 text-[12.5px] transition ${
              draft.credential_mode === "custom"
                ? "bg-brand-500/15 font-medium text-brand-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            自定义 API
          </button>
        </div>

        {draft.credential_mode === "builtin" ? (
          <div className="mt-3 space-y-2.5 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] px-3.5 py-3">
            <p className="text-[12.5px] font-medium text-ok/90">无需申请 api_id / api_hash</p>
            <p className="text-[11.5px] leading-relaxed text-slate-400">
              当前默认使用 tdl 内置应用（api_id 15055931），它是 tdl 自行申请的应用，
              不属于任何官方客户端，登录时手机扫码即可。设备指纹会自动对齐到 Desktop 平台，
              避免「凭证平台与设备不匹配」带来的额外风控。
            </p>
            <div className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2">
              <p className="text-[11.5px] font-medium text-err">仍是公开凭证，长期使用请换自定义 API</p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                公开凭证被所有使用该工具的人共用。1.0.1 起已不再默认使用 Telegram Desktop
                官方客户端凭证 —— 拿官方客户端身份从机房/代理 IP 批量下载，会被判定为
                <span className="text-slate-100">「仿冒官方客户端」</span>，代价是账号的全部会话被重置、
                相关机器人被冻结。自己的 api_id 在 my.telegram.org 免费申请，两分钟即可。
              </p>
            </div>
            <Field label="内置应用">
              <select
                className="field"
                value={draft.builtin_app}
                onChange={(e) => patch("builtin_app", e.target.value)}
              >
                <option value="builtin">tdl 内置应用（默认，推荐）</option>
                <option value="desktop">Telegram Desktop（官方客户端，风控最敏感，不推荐）</option>
              </select>
            </Field>
            {data.credential && (
              <p className="text-[11px] text-slate-500">
                当前生效：{data.credential.label} · api_id {data.credential.apiId}
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="API ID">
              <input
                className="field font-mono"
                placeholder="12345678"
                value={draft.api_id}
                onChange={(e) => patch("api_id", e.target.value)}
              />
            </Field>
            <Field label="API Hash">
              <input
                className="field font-mono"
                placeholder="0123456789abcdef0123456789abcdef"
                value={draft.api_hash}
                onChange={(e) => patch("api_hash", e.target.value)}
              />
            </Field>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void saveSection("api", ["credential_mode", "builtin_app", "api_id", "api_hash"])}
            loading={savingSection === "api"}
          >
            保存凭证
          </Button>
        </div>
      </CollapsibleCard>

      {/* 管理界面登录：和上面的「Telegram 账号」不是一回事，别混在一起 */}
      <AccountPanel />

      {/* 版本信息：与镜像标签、/api/health 的 version 保持一致 */}
      <p className="pb-2 text-center text-[11px] text-slate-600">
        tgsub {data.version ?? "—"} · {data.paths.dataDir}
      </p>
    </div>
  );
}
