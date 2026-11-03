import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { SessionState } from "../types";
import { IconEye, IconEyeOff, IconShield } from "../components/icons";
import { Spinner } from "../components/ui";

/**
 * 登录页 / 首次初始化页。
 *
 * 这里刻意不使用项目里的主题变量（bg-ink-900 / text-slate-200 这些）。
 * 原因：那套变量在浅色主题下是「反转」的，同一个 class 换个主题就变色。
 * 这页要做的是「深蓝插画 + 白卡」的固定观感，任何跟随主题的写法都会在
 * 某种主题下走样，所以颜色一律写字面色值。
 *
 * 两种模式共用一套骨架：
 *   setup —— 还没有任何账号，强制设置用户名与密码（不可跳过、不可关闭）
 *   login —— 已设置过，凭账号密码进入
 */

type Mode = "setup" | "login";

const IMG_BLUE_1 = "#16337d";
const IMG_BLUE_2 = "#1c44b0";
const IMG_BLUE_3 = "#2557d4";

export default function Login({ state, onDone }: { state: SessionState; onDone: () => void }) {
  const mode: Mode = state.configured ? "login" : "setup";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    userRef.current?.focus();
  }, [mode]);

  // 初始化和登录的字段不同，切换时把上一半的输入清干净
  useEffect(() => {
    setPassword("");
    setConfirm("");
    setError(null);
  }, [mode]);

  const title = mode === "setup" ? "初始化账号" : "欢迎回来";
  const subtitle =
    mode === "setup" ? "首次使用，请先设置管理员账号" : "轻量级频道订阅下载器";
  const badge = mode === "setup" ? "首次启动" : "管理员登录";

  // 按钮不做「没填完就变灰」：那样一进来就是一片灰按钮，观感很差。
  // 只有提交中才禁用，字段缺失在点击时说清楚。
  const canSubmit = !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }

    if (mode === "setup") {
      if (!confirm) {
        setError("请再输入一次密码");
        return;
      }
      if (password !== confirm) {
        setError("两次输入的密码不一致");
        return;
      }
      if (password.length < 8) {
        setError("密码至少 8 位");
        return;
      }
    }

    setBusy(true);
    try {
      if (mode === "setup") {
        await api.sessionSetup({ username: username.trim(), password, confirm });
      } else {
        await api.sessionLogin({ username: username.trim(), password, remember });
      }
      onDone();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setError(message || "登录失败，请重试");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex overflow-y-auto bg-[#f4f6fb]">
      {/* 左侧：深蓝插画区（窄屏隐藏，保证小屏上表单第一时间可见） */}
      <div
        className="relative hidden shrink-0 overflow-hidden md:block md:w-[52%] lg:w-[55%]"
        style={{ background: `linear-gradient(158deg, ${IMG_BLUE_1} 0%, ${IMG_BLUE_2} 48%, ${IMG_BLUE_3} 100%)` }}
      >
        {/* 细网格：截图里左区有很淡的方格纹理，用两层 linear-gradient 铺出来 */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.8]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
            maskImage: "radial-gradient(120% 100% at 20% 10%, #000 20%, transparent 78%)",
            WebkitMaskImage: "radial-gradient(120% 100% at 20% 10%, #000 20%, transparent 78%)",
          }}
        />
        {/* 右上角一团柔光，让纯色不至于太平 */}
        <div
          className="pointer-events-none absolute -right-24 -top-32 h-[520px] w-[520px] rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, #4f8bff 0%, transparent 68%)" }}
        />

        {/* 插画：四个圆角角色，左下角对齐 */}
        <div className="pointer-events-none absolute bottom-0 left-0 w-[min(88%,430px)] pl-6 sm:pl-10 lg:pl-16">
          <Mascots className="h-auto w-full" />
        </div>

        <div className="absolute left-6 top-6 flex items-center gap-2.5 sm:left-10 lg:left-16">
          <img src="/logo.png" alt="tgsub" className="h-8 w-8 rounded-lg object-cover ring-1 ring-[rgba(255,255,255,0.25)]" />
          <div className="leading-tight">
            <p className="text-[13.5px] font-semibold tracking-tight text-[#ffffff]">tgsub</p>
            <p className="text-[10.5px] tracking-wide text-[rgba(255,255,255,0.55)]">频道订阅下载器</p>
          </div>
        </div>
      </div>

      {/* 右侧：表单卡片 */}
      <div className="flex min-h-full flex-1 items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[352px] animate-fade-up">
          <form
            onSubmit={submit}
            className="rounded-[16px] bg-[#ffffff] px-6 py-7 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_18px_48px_-16px_rgba(15,23,42,0.22)] sm:px-7 sm:py-8"
          >
            <div className="text-center">
              <p className="text-[11px] font-medium tracking-[0.12em] text-[#2f6fe4]">{badge}</p>
              <h1 className="mt-2 text-[22px] font-bold tracking-tight text-[#0f172a]">{title}</h1>
              <p className="mt-1 text-[11.5px] text-[#98a2b3]">{subtitle}</p>
            </div>

            {mode === "setup" && (
              <div className="mt-5 flex gap-2 rounded-[9px] border border-[#dbe7fb] bg-[#f4f8ff] px-3 py-2.5">
                <IconShield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2f6fe4]" />
                <p className="text-[11px] leading-relaxed text-[#4a6285]">
                  这个账号只设置一次，之后打开界面都要用它登录。请记牢，或先抄在安全的地方。
                </p>
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-[9px] border border-[#fbd5d5] bg-[#fef3f3] px-3 py-2 text-[11.5px] leading-relaxed text-[#c02b2b]">
                {error}
              </div>
            )}

            <div className={mode === "setup" ? "mt-5 space-y-3.5" : "mt-6 space-y-3.5"}>
              <Field label="用户名">
                <input
                  ref={userRef}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="请输入用户名"
                  autoComplete="username"
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={32}
                  className="login-input"
                />
              </Field>

              <Field label="密码">
                <div className="relative">
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type={showPassword ? "text" : "password"}
                    placeholder={mode === "setup" ? "至少 8 位，建议字母加数字" : "请输入密码"}
                    autoComplete={mode === "setup" ? "new-password" : "current-password"}
                    maxLength={128}
                    className="login-input pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    tabIndex={-1}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-[#b3bac6] transition hover:bg-[#eef1f6] hover:text-[#6b7280]"
                  >
                    {showPassword ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>

              {mode === "setup" && (
                <Field label="确认密码">
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    type={showPassword ? "text" : "password"}
                    placeholder="再输一次"
                    autoComplete="new-password"
                    maxLength={128}
                    className="login-input"
                  />
                </Field>
              )}
            </div>

            {mode === "login" ? (
              <div className="mt-3.5 flex items-center justify-between">
                <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11.5px] text-[#6b7280]">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[#d3d8e0] text-[#2f6fe4] accent-[#2f6fe4]"
                  />
                  保持登录（30 天）
                </label>
                <button
                  type="button"
                  onClick={() => setHelpOpen((v) => !v)}
                  className="text-[11.5px] text-[#2f6fe4] transition hover:text-[#1e56bd] hover:underline"
                >
                  忘记密码？
                </button>
              </div>
            ) : (
              <div className="mt-3.5 text-[11px] text-[#98a2b3]">
                密码至少 8 位；请记牢，丢失后只能从服务端重置。
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-[9px] text-[13px] font-medium text-[#ffffff] transition
                disabled:cursor-not-allowed disabled:opacity-55"
              style={{
                background: "linear-gradient(96deg, #1c3f9e 0%, #2a63d4 52%, #2f86e6 100%)",
                boxShadow: "0 8px 20px -10px rgba(31,86,190,0.85)",
              }}
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {mode === "setup" ? "创建账号并进入" : "登录"}
            </button>

            <p className="mt-4 text-center text-[10.5px] leading-relaxed text-[#98a4b6]">
              {mode === "setup"
                ? "账号只保存在本机数据库，密码经 scrypt 加盐哈希后落盘"
                : "登录状态保存在浏览器 Cookie，30 天内免重复输入"}
            </p>
          </form>

          {helpOpen && mode === "login" && <ForgotPassword />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-[#4b5563]">{label}</span>
      {children}
    </label>
  );
}

/** 忘记密码的兜底说明：单账号系统没有「发邮件重置」，只能从服务端放行 */
function ForgotPassword() {
  return (
    <div className="mt-3 rounded-[12px] border border-[#e3e8f0] bg-[rgba(255,255,255,0.86)] px-4 py-3 text-[11px] leading-relaxed text-[#5c6779]">
      <p className="font-medium text-[#334155]">用户名或密码想不起来了？</p>
      <p className="mt-1.5">单机部署没有邮箱找回，只能从服务端重来：</p>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4">
        <li>
          在 <code className="rounded bg-[#f1f4f9] px-1 py-0.5 font-mono text-[10.5px]">docker-compose.yml</code>{" "}
          的 environment 里加 <code className="rounded bg-[#f1f4f9] px-1 py-0.5 font-mono text-[10.5px]">AUTH_DISABLED: "1"</code>
        </li>
        <li>重启容器，这会临时跳过登录（内网短暂窗口，用完立刻删掉这行）</li>
        <li>进「设置 → 账号与安全」重新设置用户名与密码</li>
      </ol>
      <p className="mt-1.5 text-[#8b95a6]">
        也可以直接删掉数据库里的 <code className="font-mono text-[10.5px]">login_user / login_hash</code>{" "}
        两行，重启后回到首次初始化。
      </p>
    </div>
  );
}

/**
 * 左下角插画。
 *
 * 四个形状都是从截图里拼回来的：橙色圆顶、深蓝竖条、近黑竖条、黄色圆顶，
 * 底部统一裁在画布下沿，看起来像「一排站着的小家伙」。
 */
function Mascots({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 340 300" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="m-orange" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff8f66" />
          <stop offset="1" stopColor="#f97350" />
        </linearGradient>
        <linearGradient id="m-violet" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7c4df5" />
          <stop offset="1" stopColor="#6636e8" />
        </linearGradient>
        <linearGradient id="m-yellow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6dd55" />
          <stop offset="1" stopColor="#eccf3a" />
        </linearGradient>
      </defs>

      {/* 深蓝竖条（最高，被橙色挡住左半边） */}
      <path d="M56 300 L56 104 Q56 74 88 74 Q120 74 120 104 L120 300 Z" fill="url(#m-violet)" />
      <circle cx="76" cy="112" r="5.2" fill="#ffffff" />
      <circle cx="100" cy="112" r="5.2" fill="#ffffff" />
      <circle cx="76" cy="112" r="2.4" fill="#1a1633" />
      <circle cx="100" cy="112" r="2.4" fill="#1a1633" />

      {/* 近黑竖条 */}
      <path d="M128 300 L128 156 Q128 128 158 128 Q188 128 188 156 L188 300 Z" fill="#242424" />
      <circle cx="146" cy="164" r="5.2" fill="#ffffff" />
      <circle cx="170" cy="164" r="5.2" fill="#ffffff" />
      <circle cx="146" cy="164" r="2.4" fill="#0f0f0f" />
      <circle cx="170" cy="164" r="2.4" fill="#0f0f0f" />

      {/* 橙色圆顶（最左，最矮） */}
      <path d="M0 300 L0 252 A56 56 0 0 1 112 252 L112 300 Z" fill="url(#m-orange)" />
      <circle cx="34" cy="252" r="5.2" fill="#ffffff" />
      <circle cx="62" cy="252" r="5.2" fill="#ffffff" />
      <circle cx="34" cy="252" r="2.4" fill="#3a1c12" />
      <circle cx="62" cy="252" r="2.4" fill="#3a1c12" />

      {/* 黄色圆顶（最右） */}
      <path d="M186 300 L186 254 A52 52 0 0 1 290 254 L290 300 Z" fill="url(#m-yellow)" />
      <circle cx="218" cy="248" r="5.2" fill="#ffffff" />
      <circle cx="246" cy="248" r="5.2" fill="#ffffff" />
      <circle cx="218" cy="248" r="2.4" fill="#2f2a08" />
      <circle cx="246" cy="248" r="2.4" fill="#2f2a08" />
      <path d="M226 270 L252 270" stroke="#2f2a08" strokeWidth="3" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}
