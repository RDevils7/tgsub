import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { formatDateTime } from "../utils";
import type { AppSettings, AuthState, BotState, QrState, SettingsResponse } from "../types";
import { Badge, Button, Field, Spinner, StatusDot, Toggle, useToast } from "../components/ui";
import { IconBot, IconDownload, IconKey, IconLogout, IconQr, IconShield, IconSpark } from "../components/icons";

type LoginStep = "idle" | "code" | "password";

const MB = 1024 * 1024;

export default function Settings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
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

  const [botToken, setBotToken] = useState("");
  const [bot, setBot] = useState<BotState | null>(null);
  const [botBusy, setBotBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [settingsRes, authRes] = await Promise.all([api.settings(), api.authState()]);
      setData(settingsRes);
      setDraft(settingsRes.settings);
      setAuth(authRes);
      setBot(settingsRes.bot ?? null);
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
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSavingSection(null);
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

  const botStatus = !draft.bot_enabled
    ? { dot: "bg-slate-500", tone: "border-white/10 bg-white/[0.03] text-slate-400", label: "未启用" }
    : bot?.running
      ? {
          dot: "bg-emerald-400",
          tone: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
          label: `在线 · @${bot.username ?? bot.userId ?? "bot"}`,
        }
      : bot?.error
        ? { dot: "bg-rose-400", tone: "border-rose-500/25 bg-rose-500/10 text-rose-300", label: "连接失败" }
        : { dot: "bg-amber-400", tone: "border-amber-500/25 bg-amber-500/10 text-amber-300", label: "连接中…" };

  return (
    <div className="space-y-5">
      {/* Telegram 账号 */}
      <section className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-500/20 bg-brand-500/10 text-brand-300">
              <IconShield className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-[14px] font-semibold text-white">Telegram 账号</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">登录后可读取频道消息，session 会加密保存在本地数据库</p>
            </div>
          </div>
          {isLoggedIn ? (
            <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
              <StatusDot className="bg-emerald-400" />
              已登录
            </Badge>
          ) : (
            <Badge className="border-amber-500/20 bg-amber-500/10 text-amber-300">
              <StatusDot className="bg-amber-400" />
              未登录
            </Badge>
          )}
        </div>

        <div className="mt-4">
          {isLoggedIn ? (
            <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-gradient text-[13px] font-semibold text-white">
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
                  <p className="text-[12.5px] font-medium text-amber-200">本地登录凭据已被 Telegram 判定失效</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
                    常见原因是重启时旧进程还没退出、新旧连接共用了同一个 authKey。先点「重试连接」，多数情况能直接恢复，不必重新扫码。
                    {auth.error && <span className="ml-1 text-slate-500">（{auth.error}）</span>}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="primary" loading={retrying} onClick={() => void retryAuth()}>
                      重试连接
                    </Button>
                    <Button size="sm" onClick={() => setShowSessionBox(true)}>
                      手动导入 session
                    </Button>
                  </div>
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
                      <div className="flex h-[168px] w-[168px] shrink-0 items-center justify-center rounded-xl bg-white p-2">
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
                <p className="text-[11.5px] leading-relaxed text-rose-300/80">{qr.error}</p>
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
                <p className="text-[11.5px] leading-relaxed text-amber-300/80">
                  当前为「自定义 API」模式但尚未填写 api_id / api_hash，请在下方补全，或切换回内置凭证。
                </p>
              )}
              {auth?.error && <p className="text-[11.5px] leading-relaxed text-rose-300/80">{auth.error}</p>}
            </div>
          )}
        </div>
      </section>

      {/* API 凭证 */}
      <section className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-300">
              <IconKey className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-[14px] font-semibold text-white">API 凭证与网络</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                使用内置凭证可跳过 my.telegram.org 申请；也可切换为自建应用
              </p>
            </div>
          </div>
        </div>

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
            <p className="text-[12.5px] font-medium text-emerald-200/90">无需申请 api_id / api_hash</p>
            <p className="text-[11.5px] leading-relaxed text-slate-400">
              使用公开的 Telegram Desktop 官方客户端应用标识（与 tdl 等工具一致），登录时手机扫码即可。
              设备指纹会自动对齐到 Desktop 平台，避免「凭证平台与设备不匹配」带来的额外风控。
            </p>
            <Field label="内置应用">
              <select
                className="field"
                value={draft.builtin_app}
                onChange={(e) => patch("builtin_app", e.target.value)}
              >
                <option value="desktop">Telegram Desktop（官方客户端，推荐）</option>
                <option value="builtin">tdl 内置应用</option>
              </select>
            </Field>
            {data.credential && (
              <p className="text-[11px] text-slate-500">
                当前生效：{data.credential.label} · api_id {data.credential.apiId}
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-amber-300/70">
              提示：公开凭证被大量用户共用，其账号信任度低于你自行申请的应用。若后续能申请到 api_id，
              切换为「自定义 API」会更稳妥。
            </p>
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

        <div className="mt-3">
          <Field
            label="SOCKS5 代理（可选）"
            hint="例如 socks5://192.168.5.2:7890，留空表示直连"
          >
            <input
              className="field font-mono"
              placeholder="socks5://192.168.5.2:7890"
              value={draft.proxy_url}
              onChange={(e) => patch("proxy_url", e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              void saveSection("api", ["credential_mode", "builtin_app", "api_id", "api_hash", "proxy_url"])
            }
            loading={savingSection === "api"}
          >
            保存凭证
          </Button>
        </div>
      </section>

      {/* 扫描策略 */}
      <section className="card p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
            <IconSpark className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-[14px] font-semibold text-white">扫描策略</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">控制扫描频率与每次读取的消息数量</p>
          </div>
        </div>

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
      </section>

      {/* 下载 */}
      <section className="card p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-300">
            <IconDownload className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-[14px] font-semibold text-white">下载设置</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">并发数、文件大小过滤与存储路径规则</p>
          </div>
        </div>

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

        <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">存储位置</p>
          <p className="mt-1.5 break-all font-mono text-[11.5px] text-slate-300">{data.paths.downloadDir}</p>
          <p className="mt-1 break-all font-mono text-[11px] text-slate-600">{data.paths.dbFile}</p>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              void saveSection("download", ["concurrency", "min_file_size", "max_file_size", "file_template"])
            }
            loading={savingSection === "download"}
          >
            保存设置
          </Button>
        </div>
      </section>

      <section className="card p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-300">
            <IconSpark className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-[14px] font-semibold text-white">Emby 媒体库</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">边下边生成元信息，Emby 扫描即出海报、简介与集数</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <div className="pr-4">
            <p className="text-[13px] text-slate-200">生成 Emby 媒体信息</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              每集写入「剧名S01E04.nfo」，剧集目录写入 tvshow.nfo，并用随机剧照生成 poster / landscape / fanart
            </p>
          </div>
          <Toggle checked={draft.emby_meta} onChange={(next) => patch("emby_meta", next)} />
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field
            label="每条消息保留封面图"
            hint="从消息内的图片里随机挑选，0 表示图片全部不下载"
          >
            <input
              type="number"
              min={0}
              max={9}
              className="field"
              value={draft.cover_images}
              onChange={(e) => patch("cover_images", Math.max(0, Math.min(9, Number(e.target.value) || 0)))}
            />
          </Field>
          <Field
            label="ffmpeg 路径"
            hint="用于「元数据」页从视频截帧；留空自动使用内置二进制或系统 PATH 里的 ffmpeg"
            className="sm:col-span-2"
          >
            <input
              className="field font-mono text-[12.5px]"
              placeholder="留空自动查找，例如 C:/ffmpeg/bin/ffmpeg.exe"
              value={draft.ffmpeg_path}
              onChange={(e) => patch("ffmpeg_path", e.target.value)}
            />
          </Field>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 sm:col-span-3">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">落盘结构</p>
            <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-400">{`美人局/
  美人局S01E04.mp4
  美人局S01E04.nfo
  tvshow.nfo
  poster.jpg  landscape.jpg  fanart.jpg`}</pre>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void saveSection("emby", ["emby_meta", "cover_images", "ffmpeg_path"])}
            loading={savingSection === "emby"}
          >
            保存设置
          </Button>
        </div>
      </section>

      {/* Telegram 机器人 */}
      <section className="card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
              <IconBot className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-[14px] font-semibold text-white">Telegram 机器人</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                给机器人发一条消息就能扫描频道、增删订阅、看下载进度，不用打开网页
              </p>
            </div>
          </div>
          <Badge className={botStatus.tone}>
            <span className={`h-1.5 w-1.5 rounded-full ${botStatus.dot}`} />
            {botStatus.label}
          </Badge>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <div className="pr-4">
            <p className="text-[13px] text-slate-200">启用机器人控制</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              机器人用独立的 bot token 登录，和账号的扫码 session 互不影响，也不会占用扫描连接
            </p>
          </div>
          <Toggle checked={draft.bot_enabled} onChange={(next) => patch("bot_enabled", next)} />
        </div>

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

        {bot?.error && draft.bot_enabled && (
          <p className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.07] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-rose-300">
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
      </section>
    </div>
  );
}
