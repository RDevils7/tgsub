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
  MediaLibraryResponse,
  MediaSeriesResponse,
  CacheActionResult,
  CacheStats,
  BotTestResult,
  FfmpegStatus,
  PlatformId,
  PlatformEnqueueResponse,
  PlatformProbe,
  PlatformStatus,
  YtdlpInfo,
  EngineUpdateResult,
  EngineUpdateState,
  NetProbeReport,
  ProxyStatus,
  MetadataDetail,
  MetadataFolderItem,
  MetadataOriginGroup,
  MetadataSource,
  MetadataDeletePlan,
  MetadataDeleteResult,
  MetadataExcludedItem,
  MetaRenameResult,
  MetadataTransferResponse,
  RenamePlanPreview,
  RenameExecuteResult,
  ManualHistoryResponse,
  ManualKind,
  ManualStatus,
  DeleteMode,
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
  SessionState,
  OverviewReport,
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

/**
 * 会话令牌的兜底存放。
 *
 * 正常情况靠 httpOnly cookie，浏览器会自动带上。但有些环境根本存不住 cookie：
 * 隐私设置拦掉、嵌在沙箱 iframe（opaque origin）里、或者反向代理把 Set-Cookie 吞了 ——
 * 表现为「点登录没反应，一直回登录页」。这时登录接口会在响应体里给一个 token，
 * 前端存下来、每个请求放进 `X-Tgsub-Session` 头，服务端两种凭据都认。
 */
const TOKEN_KEY = "tgsub.session";

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    // 无痕 / 沙箱环境里 localStorage 会抛错，退化成「本次页面内有效」
    return "";
  }
}

let sessionToken = readToken();

export function setSessionToken(token: string): void {
  sessionToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 存不住就只在内存里用，刷新后重新登录 */
  }
}

export function clearSessionToken(): void {
  sessionToken = "";
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (sessionToken) headers.set("X-Tgsub-Session", sessionToken);
  const res = await fetch(`/api${path}`, { credentials: "same-origin", ...init, headers });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; code?: string };
    // 会话过期或被清掉时，任何一次接口调用都会拿到 401。
    // 抛个全局事件让外层切回登录页，好过每个页面各写一遍错误处理。
    if (res.status === 401 && (payload.code === "LOGIN_REQUIRED" || payload.code === "SETUP_REQUIRED")) {
      clearSessionToken();
      window.dispatchEvent(new CustomEvent("tgsub:unauthorized"));
    }
    throw new ApiError(res.status, payload.error || `请求失败 (${res.status})`, payload.code);
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean; uptime: number }>("/health"),
  /** 概览页聚合状态：运行时 / 存储 / 工具链 / 服务，一次拿全 */
  overview: (refresh = false) =>
    request<OverviewReport>(`/overview${refresh ? "?refresh=1" : ""}`),
  /** 忽略 / 恢复概览提醒；服务端会同时清掉 30 秒报告缓存 */
  overviewIgnore: (id: string, label?: string, text?: string) =>
    request<{ ok: boolean; id: string }>("/overview/issues/ignore", {
      method: "POST",
      body: JSON.stringify({ id, label, text }),
    }),
  overviewRestore: (id: string) =>
    request<{ ok: boolean; id: string }>("/overview/issues/restore", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  overviewRestoreAll: () =>
    request<{ ok: boolean; count: number }>("/overview/issues/restore-all", { method: "POST" }),

  /* ------------------------------ 管理界面登录 ------------------------------ */
  /** 一次问清三种状态：未初始化 / 未登录 / 已登录 */
  sessionState: () => request<SessionState>("/session/state"),
  /** 首次初始化账号，成功后服务端直接下发 cookie */
  sessionSetup: (payload: { username: string; password: string; confirm: string }) =>
    request<{ ok: boolean; username: string; token?: string }>("/session/setup", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  sessionLogin: (payload: { username: string; password: string; remember: boolean }) =>
    request<{ ok: boolean; username: string; token?: string }>("/session/login", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  sessionLogout: () => request<{ ok: boolean }>("/session/logout", { method: "POST" }),
  /** 改用户名 / 密码：要验当前密码，成功后其它设备全部掉线 */
  sessionUpdateAccount: (payload: {
    currentPassword: string;
    username?: string;
    newPassword?: string;
    confirm?: string;
  }) =>
    request<{ ok: boolean; username: string }>("/session/account", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  sessionLogoutOthers: () => request<{ ok: boolean; removed: number }>("/session/logout-others", { method: "POST" }),

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
  saveSettings: (
    patch: Partial<AppSettings> & {
      bot_token?: string;
      emby_api_key?: string;
      platform_cookie_bilibili?: string;
      platform_cookie_xiaohongshu?: string;
      platform_cookie_youtube?: string;
    },
  ) =>
    request<{ settings: AppSettings; credential?: CredentialInfo; bot?: BotState; emby?: { apiKeySet: boolean; apiKeyHint: string | null } }>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /* ------------------------------ 第三方平台 ------------------------------ */
  platformStatus: () => request<PlatformStatus>("/platform/status"),
  /** 只解析不下载 */
  platformProbe: (url: string) =>
    request<{ platform: PlatformId; label: string; probe: PlatformProbe }>("/platform/probe", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  /**
   * 解析并入队。
   * 合集 / 多P 且没给 mode 时不会下载，先回 needsChoice，由界面弹窗让用户选。
   */
  platformTask: (url: string, mode?: "one" | "all") =>
    request<PlatformEnqueueResponse>("/platform/task", {
      method: "POST",
      body: JSON.stringify({ url, mode }),
    }),
  /** 用选择令牌入队（机器人按钮走这条；界面有原链接时直接用 url） */
  platformTaskByToken: (token: string, mode: "one" | "all") =>
    request<PlatformEnqueueResponse>("/platform/task", {
      method: "POST",
      body: JSON.stringify({ token, mode }),
    }),
  platformRefresh: () => request<{ ytdlp: YtdlpInfo; update: EngineUpdateState }>("/platform/refresh", {
    method: "POST",
  }),
  /** 立即检查 yt-dlp 新版本，有就下载并切换 */
  platformUpdate: () => request<EngineUpdateResult>("/platform/update", { method: "POST" }),

  /* ------------------------------ 手动下载记录 ------------------------------ */

  /** 手动下载页底部的提交记录（服务端在提交时自动写，这里只读） */
  manualHistory: (params: { limit?: number; offset?: number; status?: string; kind?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.status) qs.set("status", params.status);
    if (params.kind) qs.set("kind", params.kind);
    if (params.q) qs.set("q", params.q);
    const query = qs.toString();
    return request<ManualHistoryResponse>(`/manual/history${query ? `?${query}` : ""}`);
  },
  /** 客户端补记（合集弹窗点「取消」时用；正常提交由服务端记，别再调一次） */
  manualRecord: (payload: {
    link: string;
    kind: ManualKind;
    status: ManualStatus;
    platform?: string | null;
    title?: string | null;
    note?: string | null;
    error?: string | null;
  }) => request<{ ok: boolean }>("/manual/history", { method: "POST", body: JSON.stringify(payload) }),
  manualClear: (scope: "all" | "error" | "older" = "all") =>
    request<{ ok: boolean; count: number }>(`/manual/history?scope=${scope}`, { method: "DELETE" }),
  manualDelete: (id: number) =>
    request<{ ok: boolean }>(`/manual/history/${id}`, { method: "DELETE" }),

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

  /* ------------------------------ 本地媒体库 ------------------------------ */
  /** 列目录里的剧集；不传 dir 就是下载根。hevc=true 表示这台浏览器要强制尝试 HEVC */
  mediaLibrary: (dir?: string, hevc = false) => {
    const query = [dir ? `dir=${encodeURIComponent(dir)}` : "", hevc ? "hevc=1" : ""].filter(Boolean).join("&");
    return request<MediaLibraryResponse>(`/media/library${query ? `?${query}` : ""}`);
  },
  /** 一部剧的详情 + 全部分集 */
  mediaSeries: (dir: string, hevc = false) =>
    request<MediaSeriesResponse>(`/media/series?dir=${encodeURIComponent(dir)}${hevc ? "&hevc=1" : ""}`),

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
  metadataItems: (params: {
    q?: string;
    limit?: number;
    offset?: number;
    origin?: string;
    /** 排列方式：name / updated / size / episodes */
    sort?: string;
    /** asc / desc */
    order?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.origin) qs.set("origin", params.origin);
    if (params.sort) qs.set("sort", params.sort);
    if (params.order) qs.set("order", params.order);
    return request<{
      items: MetadataFolderItem[];
      total: number;
      limit: number;
      offset: number;
      /** 各来源分区的条目数（按筛选前的全量统计） */
      origins: MetadataOriginGroup[];
    }>(`/metadata/items?${qs}`);
  },
  /** 批量移动 / 复制：keys 可以是剧集目录，也可以是单个视频 */
  transferMetadata: (keys: string[], action: "move" | "copy", dest: string) =>
    request<MetadataTransferResponse>("/metadata/transfer", {
      method: "POST",
      body: JSON.stringify({ keys, action, dest }),
    }),
  /** 手动添加的媒体来源 */
  metadataSources: () => request<{ items: MetadataSource[] }>("/metadata/sources"),
  addMetadataSource: (path: string, title?: string) =>
    request<{ ok: boolean; source: { id: number; path: string; kind: "dir" | "file"; title: string | null } }>(
      "/metadata/sources",
      { method: "POST", body: JSON.stringify({ path, title }) },
    ),
  removeMetadataSource: (id: number) =>
    request<{ ok: boolean }>(`/metadata/sources/${id}`, { method: "DELETE" }),
  /** 删除预览：把会删哪些文件摊开给用户看 */
  previewMetadataDelete: (key: string, mode: DeleteMode) =>
    request<MetadataDeletePlan>(
      `/metadata/delete/preview?key=${encodeURIComponent(key)}&mode=${mode}`,
    ),
  /** 执行删除：purge = 连磁盘文件一起删，unlink = 只从列表移除 */
  deleteMetadata: (key: string, mode: DeleteMode) =>
    request<MetadataDeleteResult>("/metadata/delete", {
      method: "POST",
      body: JSON.stringify({ key, mode }),
    }),
  /** 被隐藏的条目（仅从列表移除） */
  metadataExcluded: () => request<{ items: MetadataExcludedItem[] }>("/metadata/excluded"),
  /** 取消隐藏，恢复显示 */
  restoreMetadataExcluded: (path: string) =>
    request<{ ok: boolean }>("/metadata/excluded/restore", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /** 隐藏条目（仅从列表移除，磁盘文件保留，刷新后也不再出现） */
  hideMetadata: (key: string) =>
    request<{ ok: boolean; path: string; kind: "file" | "folder" }>("/metadata/excluded", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  /** 批量隐藏勾选的条目 */
  hideMetadataBatch: (keys: string[]) =>
    request<{ ok: boolean; hidden: number; failed: string[] }>("/metadata/excluded/batch", {
      method: "POST",
      body: JSON.stringify({ keys }),
    }),
  /** 剧集改名预览：目录与每一集的新文件名，改之前先看一遍 */
  previewRenameSeries: (key: string, title: string) =>
    request<{ ok: boolean; dryRun: true; plan: RenamePlanPreview; count: number }>(
      "/metadata/rename-series",
      { method: "POST", body: JSON.stringify({ key, title, dryRun: true }) },
    ),
  /** 剧集改名执行：目录名 + 每集文件名一起改，集号重排成连续 */
  renameSeries: (key: string, title: string) =>
    request<RenameExecuteResult>("/metadata/rename-series", {
      method: "POST",
      body: JSON.stringify({ key, title }),
    }),
  /** 合并预览：把散在不同文件夹里的视频并成一部剧；order 为用户确认过的顺序 */
  previewMerge: (keys: string[], title: string, dir?: string, order?: string[]) =>
    request<{ ok: boolean; dryRun: true; plan: RenamePlanPreview; count: number; merged: number }>(
      "/metadata/merge",
      { method: "POST", body: JSON.stringify({ keys, title, dir, order, dryRun: true }) },
    ),
  /** 合并执行 */
  mergeSeries: (keys: string[], title: string, dir?: string, order?: string[]) =>
    request<RenameExecuteResult>("/metadata/merge", {
      method: "POST",
      body: JSON.stringify({ keys, title, dir, order }),
    }),
  /** 目标目录的剧集信息：移动时「一键更新为当前剧集信息」的默认剧名 */
  metadataSeriesInfo: (dir: string) =>
    request<{ ok: boolean; dir: string; title: string; hasNfo: boolean; videoCount: number }>(
      `/metadata/series-info?dir=${encodeURIComponent(dir)}`,
    ),
  /** 服务端目录浏览：给「手动添加」对话框挑文件 / 目录 */
  metadataBrowse: (path?: string) =>
    request<BrowseResult>(`/metadata/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  /** 一键生成 NFO：单集 NFO + tvshow.nfo（优先用下载记录里的信息补全） */
  generateNfo: (key: string) =>
    request<{ ok: boolean; nfoCount: number; files: number }>("/metadata/generate/nfo", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  /** 一键生成图片：缺封面时用 ffmpeg 随机截帧生成横版/竖版封面 */
  generateImages: (key: string) =>
    request<{ ok: boolean; coverCount: number; files: number }>("/metadata/generate/images", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  metadataDetail: (key: string) => request<MetadataDetail>(`/metadata/detail?key=${encodeURIComponent(key)}`),
  metadataTools: (refresh = false) =>
    request<{ ffmpeg: FfmpegInfo; sharp: boolean; settings: { ffmpeg_path: string } }>(
      `/metadata/tools/status${refresh ? "?refresh=1" : ""}`,
    ),
  saveMetaFields: (key: string, kind: "episode" | "show", fields: NfoFields, renameFiles = false) =>
    request<{ ok: boolean; nfo: string; fields: NfoFields; rename: MetaRenameResult | null }>("/metadata/meta", {
      method: "PUT",
      body: JSON.stringify({ key, kind, fields, renameFiles }),
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
