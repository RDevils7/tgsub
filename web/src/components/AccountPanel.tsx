import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { SessionState } from "../types";
import { formatDateTime } from "../utils";
import { Badge, Button, Field, useToast } from "./ui";
import CollapsibleCard from "./CollapsibleCard";
import { IconKey, IconLogout, IconShield } from "./icons";

/**
 * 设置页的「账号与安全」。
 *
 * 只有一组凭据，所以这里的操作就是三件：改名字、改密码、把其它设备踢下线。
 * 改密码会连带清空所有会话（包括别的设备），这是刻意的 ——
 * 改密码的动机十次里有九次是「觉得别人还登着」。
 */
export default function AccountPanel() {
  const [state, setState] = useState<SessionState | null>(null);
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<null | "save" | "others">(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const next = await api.sessionState();
      setState(next);
      setUsername(next.username ?? "");
    } catch {
      /* 未登录时由外层门禁接管，这里静默 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    // AUTH_DISABLED 下允许不填当前密码（那时旧密码本来就不在手上）
    if (!currentPassword && !state?.authDisabled) {
      toast.push("请先填写当前密码", "error");
      return;
    }
    if (newPassword && newPassword !== confirm) {
      toast.push("两次输入的新密码不一致", "error");
      return;
    }
    const nameChanged = username.trim() && username.trim() !== state?.username;
    if (!nameChanged && !newPassword) {
      toast.push("用户名和密码都没有改动", "error");
      return;
    }

    setBusy("save");
    try {
      await api.sessionUpdateAccount({
        currentPassword,
        ...(nameChanged ? { username: username.trim() } : {}),
        ...(newPassword ? { newPassword, confirm } : {}),
      });
      toast.push(newPassword ? "已更新账号与密码，其它设备已下线" : "用户名已更新", "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      await load();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : (err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const kickOthers = async () => {
    setBusy("others");
    try {
      const res = await api.sessionLogoutOthers();
      toast.push(res.removed > 0 ? `已下线 ${res.removed} 个其它设备` : "没有其它在线设备", "success");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const devices = state?.devices ?? 0;

  return (
    <CollapsibleCard
      id="account"
      tint="emerald"
      icon={<IconShield className="h-4 w-4" />}
      title="账号与安全"
      desc="管理界面登录用的用户名与密码；改密码后其它设备会被强制下线"
      extra={
        <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-300">
          {state?.username ?? "—"}
        </Badge>
      }
    >
      {state?.authDisabled && (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3.5 py-2.5">
          <p className="text-[12px] font-medium text-warn">当前登录已被 AUTH_DISABLED 关闭</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">
            任何人都能直接打开界面。设置好账号密码后，请把 docker-compose.yml 里的
            <code className="mx-1 rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[10.5px]">AUTH_DISABLED</code>
            删掉并重启。
          </p>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <p className="text-[11px] text-slate-500">当前账号</p>
          <p className="mt-1 text-[13px] font-medium text-white">{state?.username ?? "—"}</p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <p className="text-[11px] text-slate-500">在线设备</p>
          <p className="mt-1 text-[13px] font-medium text-white">
            {devices} 台
            {state?.session?.expiresAt ? (
              <span className="ml-2 text-[11px] font-normal text-slate-500">
                本机至 {formatDateTime(state.session.expiresAt)}
              </span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="用户名">
          <input
            className="field"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            maxLength={32}
          />
        </Field>
        <Field label={state?.authDisabled ? "当前密码（本次可留空）" : "当前密码（必填）"}>
          <input
            className="field"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder={state?.authDisabled ? "AUTH_DISABLED 下无需验证" : "验证身份后才能修改"}
            autoComplete="current-password"
          />
        </Field>
        <Field label="新密码（不改留空）">
          <input
            className="field"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="至少 8 位"
            autoComplete="new-password"
          />
        </Field>
        <Field label="确认新密码">
          <input
            className="field"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="再输一次"
            autoComplete="new-password"
          />
        </Field>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
        <IconKey className="mt-0.5 h-3 w-3 shrink-0" />
        密码以 scrypt 加盐哈希保存在本机数据库，忘记后只能从服务端用 AUTH_DISABLED 临时放行再重设。
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="danger" onClick={() => void kickOthers()} loading={busy === "others"}>
          <IconLogout className="h-3.5 w-3.5" />
          下线其它设备
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} loading={busy === "save"}>
          保存账号设置
        </Button>
      </div>
    </CollapsibleCard>
  );
}
