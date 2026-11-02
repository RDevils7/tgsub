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
  EmbyNotifyRecord,
  EmbyProbeResult,
  EmbyStatus,
  CacheActionResult,
  CacheStats,
  BotTestResult,
  FfmpegStatus,
  NetProbeReport,
  ProxyStatus,
  MetadataDetail,
  MetadataFolderItem,
  MetadataSource,
  BrowseResult,
  FrameCandidate,
  CropRect,
  NfoFields,
  ImageName,
  ImageScope,
  FfmpegInfo,
  LogEntry,
  LogLevel,
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
  /** 批量清空：finished 只清已结束的，all 清掉除下载中以外的全部 */
  clearDownloads: (scope: "finished" | "all" = "finished", purge = false) =>
    request<{ ok: boolean; count: number; purged: number; queue: { active: number; waiting: number } }>(
      `/downloads?scope=${scope}${purge ? "&purge=1" : ""}`,
      { method: "DELETE" },
    ),

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
  /** scope=miss 只清未命中的记录 */
  clearMessages: (scope: "all" | "miss" = "all") =>
    request<{ ok: boolean; count: number; scope: string }>(`/messages?scope=${scope}`, { method: "DELETE" }),

  settings: () => request<SettingsResponse>("/settings"),
  saveSettings: (patch: Partial<AppSettings> & { bot_token?: string; emby_api_key?: string }) =>
    request<{ settings: AppSettings; credential?: CredentialInfo; bot?: BotState; emby?: { apiKeySet: boolean; apiKeyHint: string | null } }>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /* ------------------------------ Emby 入库 ------------------------------ */
  embyStatus: () => request<EmbyStatus>("/emby/status"),
  /** 测试连接：可带界面上尚未保存的地址与密钥 */
  embyTest: (input: { url?: string; apiKey?: string } = {}) =>
    request<EmbyProbeResult>("/emby/test", { method: "POST", body: JSON.stringify(input) }),
  /** 让 Emby 立刻全库扫描 */
  embyRefresh: () =>
    request<{ ok: boolean; status: number | null; error: string | null }>("/emby/refresh", { method: "POST" }),
  /** 手动补推路径（相对路径按下载目录解析） */
  embyNotify: (path: string) =>
    request<{ ok: boolean; record: EmbyNotifyRecord }>("/emby/notify", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  /* ------------------------------ 缓存 ------------------------------ */
  cacheStatus: () => request<CacheStats>("/cache/status"),
  /** 按上限立即清理（忽略「最近 10 分钟不动」的保护） */
  cacheTrim: () => request<CacheActionResult>("/cache/trim", { method: "POST" }),
  /** 一键清空 covers 与 frames */
  cacheClear: () => request<CacheActionResult>("/cache/clear", { method: "POST" }),

  botState: () => request<{ bot: BotState }>("/bot"),
  botRestart: () => request<{ ok: boolean }>("/bot/restart", { method: "POST" }),
  /** 用 Bot API 的 getMe 验 token：通不通一次就知道，不必等机器人自己连 */
  botTest: (input: { token?: string; proxyUrl?: string } = {}) =>
    request<BotTestResult>("/bot/test", { method: "POST", body: JSON.stringify(input) }),

  /* ------------------------------ 网络与代理 ------------------------------ */
  proxyStatus: () => request<ProxyStatus>("/network"),
  /** 测常用站点能否连通；带上界面上尚未保存的地址 */
  proxyTest: (proxyUrl?: string) =>
    request<NetProbeReport>("/network/test", { method: "POST", body: JSON.stringify({ proxyUrl }) }),

  /* ------------------------------ 工具链 ------------------------------ */
  ffmpegStatus: (refresh = false) =>
    request<FfmpegStatus>(`/ffmpeg${refresh ? "?refresh=1" : ""}`),

  authState: () => request<AuthState>("/auth/state"),
  authRetry: () =>
    request<{ ok: boolean; auth: AuthState }>("/auth/retry", { method: "POST" }),
  /** 彻底重置登录状态：清掉本地 session 与备份，用于「必须重新扫码」的场景 */
  authReset: () => request<{ ok: boolean; auth: AuthState }>("/auth/reset", { method: "POST" }),
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

  /* ------------------------------ 日志 ------------------------------ */
  logs: (params: { level?: string; q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.level) qs.set("level", params.level);
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<{
      items: LogEntry[];
      total: number;
      limit: number;
      offset: number;
      counts: Record<LogLevel, number>;
      fileSize: number;
    }>(`/logs?${qs}`);
  },
  logsClear: () => request<{ ok: boolean }>("/logs", { method: "DELETE" }),
  logsReload: () => request<{ ok: boolean; loaded: number }>("/logs/reload", { method: "POST" }),

  /* ------------------------------ 元数据 ------------------------------ */
  /** 文件夹列表：一个文件夹一条记录，展开后是里面的每个视频 */
  metadataItems: (params: { q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<{ items: MetadataFolderItem[]; total: number; limit: number; offset: number }>(
      `/metadata/items?${qs}`,
    );
  },
  /** 手动添加的媒体来源 */
  metadataSources: () => request<{ items: MetadataSource[] }>("/metadata/sources"),
  addMetadataSource: (path: string, title?: string) =>
    request<{ ok: boolean; source: { id: number; path: string; kind: "dir" | "file"; title: string | null } }>(
      "/metadata/sources",
      { method: "POST", body: JSON.stringify({ path, title }) },
    ),
  removeMetadataSource: (id: number) =>
    request<{ ok: boolean }>(`/metadata/sources/${id}`, { method: "DELETE" }),
  /** 服务端目录浏览：给「手动添加」对话框挑文件 / 目录 */
  metadataBrowse: (path?: string) =>
    request<BrowseResult>(`/metadata/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** 一键生成元数据：单集 NFO + tvshow.nfo + 缺封面时随机截帧 */
  generateMetadata: (key: string) =>
    request<{ ok: boolean; nfoCount: number; coverCount: number; files: number }>("/metadata/generate", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  metadataDetail: (key: string) => request<MetadataDetail>(`/metadata/detail?key=${encodeURIComponent(key)}`),
  metadataTools: (refresh = false) =>
    request<{ ffmpeg: FfmpegInfo; sharp: boolean; settings: { ffmpeg_path: string } }>(
      `/metadata/tools/status${refresh ? "?refresh=1" : ""}`,
    ),
  saveMetaFields: (key: string, kind: "episode" | "show", fields: NfoFields) =>
    request<{ ok: boolean; nfo: string; fields: NfoFields }>("/metadata/meta", {
      method: "PUT",
      body: JSON.stringify({ key, kind, fields }),
    }),
  readNfo: (key: string, kind: "episode" | "show") =>
    request<{ exists: boolean; file: string; content: string }>(
      `/metadata/nfo?key=${encodeURIComponent(key)}&kind=${kind}`,
    ),
  saveNfoRaw: (key: string, kind: "episode" | "show", content: string) =>
    request<{ ok: boolean }>("/metadata/nfo", {
      method: "PUT",
      body: JSON.stringify({ key, kind, content }),
    }),
  deleteImage: (key: string, scope: ImageScope, name: ImageName) =>
    request<{ ok: boolean; removed: boolean }>(
      `/metadata/image?key=${encodeURIComponent(key)}&scope=${scope}&name=${name}`,
      { method: "DELETE" },
    ),
  copyImage: (
    key: string,
    input: {
      fromScope: ImageScope;
      fromName: ImageName;
      toScope: ImageScope;
      toName: ImageName;
      fit?: string;
      crop?: CropRect | null;
    },
  ) =>
    request<{ ok: boolean; url: string }>("/metadata/image/copy", {
      method: "POST",
      body: JSON.stringify({ key, ...input }),
    }),
  useCoverImage: (
    key: string,
    input: { file: string; scope: ImageScope; name: ImageName; fit?: string; crop?: CropRect | null },
  ) =>
    request<{ ok: boolean; url: string }>("/metadata/image/from-cover", {
      method: "POST",
      body: JSON.stringify({ key, ...input }),
    }),
  captureFrame: (
    key: string,
    input: { at: number; scope: ImageScope; name: ImageName; fit?: string; crop?: CropRect | null },
  ) =>
    request<{ ok: boolean; at: number; url: string }>("/metadata/frame", {
      method: "POST",
      body: JSON.stringify({ key, ...input }),
    }),
  /** 取某一时间点的原始画面，供「框选画面」预览 */
  framePreview: (key: string, at: number) =>
    request<{ ok: boolean; at: number; width: number | null; height: number | null; url: string }>(
      "/metadata/frame/preview",
      { method: "POST", body: JSON.stringify({ key, at }) },
    ),
  frameCandidates: (key: string, count = 8) =>
    request<{ items: FrameCandidate[]; duration: number }>("/metadata/frames", {
      method: "POST",
      body: JSON.stringify({ key, count }),
    }),
  /** 上传图片：直接以二进制 body 提交，服务端按规格缩放写入（默认留黑边，不裁图） */
  uploadImage: async (
    key: string,
    scope: ImageScope,
    name: ImageName,
    file: File,
    opts: { fit?: string; crop?: CropRect | null } = {},
  ) => {
    const params = new URLSearchParams({
      key,
      scope,
      name,
      fit: opts.fit ?? "contain",
    });
    if (opts.crop) {
      const { x, y, width, height } = opts.crop;
      params.set("crop", [x, y, width, height].map((n) => n.toFixed(6)).join(","));
    }
    const res = await fetch(`/api/metadata/image?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as { url?: string; error?: string }) : {};
    if (!res.ok) throw new ApiError(res.status, data.error || `上传失败 (${res.status})`);
    return data as { url: string };
  },
};
