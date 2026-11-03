import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { SessionState } from "../types";
import { IconEye, IconEyeOff } from "../components/icons";
import { Spinner } from "../components/ui";

/**
 * 登录页 / 首次初始化页（简洁风）。
 *
 * 这里刻意不使用项目里的主题变量（bg-ink-900 / text-slate-200 这些）。
 * 原因：那套变量在浅色主题下是「反转」的，同一个 class 换个主题就变色。
 * 这页固定浅色观感，所以颜色一律写字面色值。
 *
 * 两种模式共用一套骨架：
 *   setup —— 还没有任何账号，强制设置用户名与密码（不可跳过、不可关闭）
 *   login —— 已设置过，凭账号密码进入
 *
 * 视觉上只保留「标题 + 字段 + 按钮」：不放插画、不放图片，
 * 页面加载不需要任何图片资源。
 */

type Mode = "setup" | "login";

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
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f7f8fa]">
      <div className="flex min-h-full items-center justify-center px-5 py-12">
        <div className="w-full max-w-[344px] animate-fade-up">
          <form
            onSubmit={submit}
            className="rounded-[12px] border border-[#e8ebf0] bg-[#ffffff] px-6 py-7 shadow-[0_1px_2px_rgba(15,23,42,0.03)]"
          >
            <div>
              <p className="text-[10.5px] font-semibold tracking-[0.16em] text-[#9aa4b2]">TGSUB</p>
              <h1 className="mt-2.5 text-[20px] font-semibold tracking-tight text-[#0f172a]">{title}</h1>
              <p className="mt-1 text-[12px] text-[#98a2b3]">{subtitle}</p>
            </div>

            <div className="mt-6 space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-[#475569]">用户名</span>
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
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-[#475569]">密码</span>
                <div className="relative">
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type={showPassword ? "text" : "password"}
                    placeholder={mode === "setup" ? "至少 8 位" : "请输入密码"}
                    autoComplete={mode === "setup" ? "new-password" : "current-password"}
                    maxLength={128}
                    className="login-input pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    tabIndex={-1}
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-[#b3bac6] transition hover:text-[#6b7280]"
                  >
                    {showPassword ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
                  </button>
                </div>
              </label>

              {mode === "setup" && (
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-[#475569]">确认密码</span>
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    type={showPassword ? "text" : "password"}
                    placeholder="再输一次"
                    autoComplete="new-password"
                    maxLength={128}
                    className="login-input"
                  />
                </label>
              )}
            </div>

            {error && (
              <p className="mt-3 text-[11.5px] leading-relaxed text-[#c02b2b]">{error}</p>
            )}

            {mode === "login" ? (
              <div className="mt-4 flex items-center justify-between">
                <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11.5px] text-[#6b7280]">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-[#d3d8e0] accent-[#2f6fe4]"
                  />
                  保持登录
                </label>
                <button
                  type="button"
                  onClick={() => setHelpOpen((v) => !v)}
                  className="text-[11.5px] text-[#2f6fe4] transition hover:text-[#1e56bd]"
                >
                  忘记密码？
                </button>
              </div>
            ) : (
              <p className="mt-4 text-[11px] leading-relaxed text-[#98a2b3]">
                密码至少 8 位；丢失后只能从服务端重置。
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-[9px] bg-[#2f6fe4] text-[13px] font-medium text-[#ffffff]
                transition hover:bg-[#2a63d4] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {mode === "setup" ? "创建账号并进入" : "登录"}
            </button>
          </form>

          {helpOpen && mode === "login" && <ForgotPassword />}

          <p className="mt-5 text-center text-[10.5px] leading-relaxed text-[#a8b0bd]">
            {mode === "setup"
              ? "账号只保存在本机数据库，密码经加盐哈希后落盘"
              : "登录状态保存在浏览器 Cookie，勾选后 30 天内免重复输入"}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 忘记密码的兜底说明：单账号系统没有「发邮件重置」，只能从服务端放行 */
function ForgotPassword() {
  return (
    <div className="mt-3 rounded-[10px] border border-[#e8ebf0] bg-[#ffffff] px-4 py-3 text-[11px] leading-relaxed text-[#64748b]">
      <p className="font-medium text-[#334155]">没有邮箱找回</p>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4">
        <li>
          在 <code className="rounded bg-[#f4f6f9] px-1 py-0.5 font-mono text-[10.5px]">docker-compose.yml</code>{" "}
          的 environment 里加{" "}
          <code className="rounded bg-[#f4f6f9] px-1 py-0.5 font-mono text-[10.5px]">AUTH_DISABLED: "1"</code>
        </li>
        <li>重启容器，临时跳过登录（用完立刻删掉这行）</li>
        <li>进「设置 → 账号与安全」重设用户名与密码</li>
      </ol>
    </div>
  );
}
