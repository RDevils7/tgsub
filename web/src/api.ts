import type {
  AppSettings,
  AuthState,
  BotState,
  Channel,
  CredentialInfo,
  DirectResult,
  DownloadItem,
  MessagePreview,
  MessageLog,
  QrState,
  ScanState,
  SettingsResponse,
  Stats,
  Subscription,
} from "./types";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; code?: string };
    throw new ApiError(res.status, payload.error || `请求失败 (${res.status})`, payload.code);
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean; uptime: number }>("/health"),

  stats: () => request<Stats>("/settings/stats"),
  scanState: () => request<ScanState>("/scan/state"),
  scanNow: (channelId?: number) =>
    request<{ results: Array<Record<string, unknown>> }>("/scan", {
      method: "POST",
      body: JSON.stringify(channelId ? { channelId } : {}),
    }),

  channels: () => request<{ items: Channel[] }>("/channels"),
  addChannel: (input: string) =>
    request<{ channel: Channel }>("/channels", { method: "POST", body: JSON.stringify({ input }) }),
  updateChannel: (id: number, patch: Record<string, unknown>) =>
    request<{ channel: Channel }>(`/channels/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteChannel: (id: number) => request<{ ok: boolean }>(`/channels/${id}`, { method: "DELETE" }),
  scanChannel: (id: number) =>
    request<{ scanned: number; matched: number; queued: number; error?: string }>(`/channels/${id}/scan`, {
      method: "POST",
    }),

  subscriptions: () => request<{ items: Subscription[] }>("/subscriptions"),
  createSubscription: (payload: Record<string, unknown>) =>
    request<{ subscription: Subscription }>("/subscriptions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateSubscription: (id: number, payload: Record<string, unknown>) =>
    request<{ subscription: Subscription }>(`/subscriptions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteSubscription: (id: number) =>
    request<{ ok: boolean }>(`/subscriptions/${id}`, { method: "DELETE" }),

  downloads: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== undefined && v !== "" && v !== 0) acc[k] = String(v);
        return acc;
      }, {}),
    ).toString();
    return request<{
      items: DownloadItem[];
      total: number;
      limit: number;
      offset: number;
      queue: { active: number; waiting: number; speed?: number };
    }>(`/downloads${qs ? `?${qs}` : ""}`);
  },
  /** 按链接下载（或指定频道+消息）；不判断订阅关键词 */
  downloadLink: (payload: { link?: string; channelId?: number; messageId?: number }) =>
    request<{ item: DirectResult }>("/downloads/link", { method: "POST", body: JSON.stringify(payload) }),
  retryDownload: (id: number) => request<{ ok: boolean }>(`/downloads/${id}/retry`, { method: "POST" }),  retryFailed: () => request<{ ok: boolean; count: number }>("/downloads/retry-failed", { method: "POST" }),
  /** 队列控制：暂停 / 停止 / 继续 / 插队 */
  pauseDownload: (id: number) => request<{ ok: boolean }>(`/downloads/${id}/pause`, { method: "POST" }),
  stopDownload: (id: number) => request<{ ok: boolean }>(`/downloads/${id}/stop`, { method: "POST" }),
  resumeDownload: (id: number) => request<{ ok: boolean }>(`/downloads/${id}/resume`, { method: "POST" }),
  jumpDownload: (id: number) => request<{ ok: boolean }>(`/downloads/${id}/jump`, { method: "POST" }),
  deleteDownload: (id: number, purge = false) =>
    request<{ ok: boolean }>(`/downloads/${id}${purge ? "?purge=1" : ""}`, { method: "DELETE" }),

  messages: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== undefined && v !== "" && v !== 0) acc[k] = String(v);
        return acc;
      }, {}),
    ).toString();
    return request<{
      items: MessageLog[];
      total: number;
      limit: number;
      offset: number;
      counts: Record<string, number>;
    }>(`/messages${qs ? `?${qs}` : ""}`);
  },
  /** 监控历史悬停预览：完整介绍 + 封面图 */
  messagePreview: (id: number) => request<MessagePreview>(`/messages/${id}/preview`),
  clearMessages: () => request<{ ok: boolean; count: number }>("/messages", { method: "DELETE" }),

  settings: () => request<SettingsResponse>("/settings"),
  saveSettings: (patch: Partial<AppSettings> & { bot_token?: string }) =>
    request<{ settings: AppSettings; credential?: CredentialInfo; bot?: BotState }>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  botState: () => request<{ bot: BotState }>("/bot"),
  botRestart: () => request<{ ok: boolean }>("/bot/restart", { method: "POST" }),

  authState: () => request<AuthState>("/auth/state"),
  authRetry: () =>
    request<{ ok: boolean; auth: AuthState }>("/auth/retry", { method: "POST" }),
  qrStart: () => request<QrState>("/auth/qr/start", { method: "POST" }),
  qrState: () => request<QrState>("/auth/qr/state"),
  qrPassword: (password: string) =>
    request<QrState>("/auth/qr/password", { method: "POST", body: JSON.stringify({ password }) }),
  qrCancel: () => request<{ ok: boolean }>("/auth/qr/cancel", { method: "POST" }),
  sendCode: (phone: string) =>
    request<{ ok: boolean; phoneCodeHash: string }>("/auth/send-code", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),
  signIn: (code: string) =>
    request<{ ok: boolean; passwordNeeded: boolean; auth?: AuthState }>("/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  submitPassword: (password: string) =>
    request<{ ok: boolean; auth: AuthState }>("/auth/password", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  importSession: (session: string) =>
    request<{ ok: boolean; auth: AuthState }>("/auth/session", {
      method: "POST",
      body: JSON.stringify({ session }),
    }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
};
