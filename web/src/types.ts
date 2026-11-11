export type MatchMode = "contains" | "word" | "regex";
export type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "stopped"
  | "done"
  | "failed"
  | "skipped";

export interface Channel {
  id: number;
  tg_id: string | null;
  username: string | null;
  title: string;
  enabled: number;
  last_scanned_id: number;
  last_scan_at: number | null;
  last_error: string | null;
  created_at: number;
  download_count?: number;
  done_count?: number;
}

export interface Subscription {
  id: number;
  name: string;
  keywords: string;
  match_mode: MatchMode;
  channel_ids: string;
  enabled: number;
  created_at: number;
}

export interface DownloadItem {
  id: number;
  channel_id: number;
  channel_title: string;
  message_id: number;
  grouped_id: string | null;
  file_name: string;
  file_size: number;
  mime_type: string | null;
  media_kind: string | null;
  status: DownloadStatus;
  progress: number;
  /** 已下载字节数 */
  downloaded_bytes: number;
  error: string | null;
  file_path: string | null;
  matched_keyword: string | null;
  subscription_id: number | null;
  created_at: number;
  /** 开始下载的时刻（排队中为 null） */
  started_at: number | null;
  finished_at: number | null;
  /** 实时速度（字节/秒），仅下载中的任务由后端补充 */
  speed_bps?: number | null;
  /** 预计剩余秒数，速度未知时为 null */
  eta_seconds?: number | null;
  /** 按剧集解析出的目标文件夹 */
  save_dir: string | null;
  /** 按剧集解析出的目标文件名 */
  save_name: string | null;
  /** 实际使用的网络线路：direct=直连 / proxy=代理 / auto=尚未确定 */
  net_route: string | null;
  /** 线路切换说明（直连失败改用代理时显示） */
  route_note: string | null;
}

/** 按链接/指定消息直接下载的回执 */
export interface DirectResult {
  ok: boolean;
  channelId: number;
  channelTitle: string;
  messageId: number;
  messageIds: number[];
  files: number;
  queued: number;
  skipped: number;
  existing: number;
  title: string | null;
  saveDir: string | null;
  link: string;
  autoAdded: boolean;
}

/* ------------------------------ 手动下载记录 ------------------------------ */

export type ManualKind = "telegram" | "platform" | "web";
export type ManualStatus = "ok" | "existing" | "empty" | "error" | "cancel";

export interface ManualHistoryItem {
  id: number;
  link: string;
  kind: ManualKind;
  platform: string | null;
  status: ManualStatus;
  title: string | null;
  note: string | null;
  queued: number;
  existing: number;
  skipped: number;
  save_dir: string | null;
  error: string | null;
  created_at: number;
}

export interface ManualHistoryResponse {
  items: ManualHistoryItem[];
  total: number;
  /** 各状态的条数（不受筛选影响，全库统计） */
  summary: Record<string, number>;
}

export type MessageLogKind = "hit" | "filtered" | "miss" | "empty";
export interface MessageLog {
  id: number;
  channel_id: number;
  channel_title: string;
  channel_username: string | null;
  message_id: number;
  grouped_id: string | null;
  kind: MessageLogKind;
  matched_keyword: string | null;
  subscription_id: number | null;
  subscription_name: string | null;
  media_kind: string | null;
  file_name: string | null;
  file_size: number;
  file_count: number;
  /** 消息内文件清单（JSON）：一条消息里的视频/图片全部记在这一条上 */
  file_names: string | null;
  /** 完整正文（excerpt 只截了 400 字，预览用这个） */
  full_text: string | null;
  excerpt: string | null;
  run_id: number | null;
  created_at: number;
  /** 最近一次被扫到的时间 */
  last_seen_at: number;
  /** 被扫到的累计次数（同一消息重复扫描只累加次数，不重复堆行） */
  seen_count: number;
}

/** 监控历史悬停预览里的一张封面图 */
export interface CoverImage {
  file: string;
  /** 第几张（1 起） */
  index: number;
  url: string;
}

export interface MessagePreview {
  item: MessageLog;
  /** download = 下载时真正用过的那几张；telegram = 悬停时从消息里取的缩略图 */
  source: "download" | "telegram" | "none";
  covers: CoverImage[];
  note: string | null;
}

export interface ScanRun {
  id: number;
  channel_id: number;
  channel_title: string;
  scanned: number;
  matched: number;
  status: "ok" | "error" | "running";
  message: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface Stats {
  totals: {
    total: number;
    done: number;
    failed: number;
    queued: number;
    downloading: number;
    skipped: number;
    bytes: number;
    channels: number;
    enabledChannels: number;
    subscriptions: number;
  };
  today: { downloads: number; bytes: number };
  recentRuns: ScanRun[];
  recentDownloads: DownloadItem[];
}

export interface AuthState {
  configured: boolean;
  connected: boolean;
  authorized: boolean;
  me: { id: string; username: string | null; firstName: string | null } | null;
  pendingCode: boolean;
  error: string | null;
  /** 最近一次验证通过并落库的时间 */
  sessionSavedAt: number | null;
  sessionState: "ok" | "dead" | "none";
  sessionPersisted: boolean;
  /** 判死时的原始错误码（如 AUTH_KEY_UNREGISTERED） */
  sessionErrorCode: string | null;
  /** true=只是连接撞车，点「重试连接」即可恢复；false=服务器已作废，必须重新扫码 */
  sessionRecoverable: boolean;
  /** true=失效原因高度指向 Telegram 风控处置（会话被重置/账号被限制），应先去申诉而不是反复重登 */
  riskSuspect: boolean;
}

/* ------------------------------ 日志 ------------------------------ */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  /** 毫秒时间戳 */
  time: number;
  iso: string;
  level: LogLevel;
  msg: string;
  /** 除 level/msg/time 之外的附加字段 */
  fields: Record<string, unknown>;
}

export interface ScanState {
  scanning: boolean;
  lastScanAt: number | null;
  intervalMinutes: number;
  autoScan: boolean;
  nextRunAt: number | null;
  queue: { active: number; waiting: number };
  auth: AuthState;
}

export type CredentialMode = "builtin" | "custom";

export interface AppSettings {
  credential_mode: CredentialMode;
  builtin_app: string;
  api_id: string;
  api_hash: string;
  proxy_url: string;
  scan_interval_minutes: number;
  initial_scan_messages: number;
  batch_size: number;
  concurrency: number;
  min_file_size: number;
  max_file_size: number;
  auto_scan: boolean;
  file_template: string;
  /** 为 Emby 生成 nfo / 缩略图 / 封面；开启时消息里的图片不再下载 */
  emby_meta: boolean;
  /** @deprecated 1.0.2 起封面改为视频截帧，此字段不再参与逻辑，仅为兼容保留 */
  cover_images: number;
  /** 认不出剧名时：一条链接一个文件夹，名字取正文 */
  fallback_folder: boolean;
  /** 下载完成后从视频随机截帧，生成每集缩略图与剧集目录封面 */
  auto_cover_frames: boolean;
  /** 下载完成后通知 Emby 入库（POST /Library/Media/Updated） */
  emby_notify: boolean;
  /** Emby 服务地址，例如 http://192.168.1.10:8096 */
  emby_url: string;
  /** 路径映射，每行「本机路径=Emby 路径」 */
  emby_path_map: string;
  /** Telegram 机器人开关与白名单（token 单独管理，不在这里返回） */
  bot_enabled: boolean;
  bot_allow_users: string;
  bot_notify: boolean;
  /** ffmpeg 可执行文件路径，留空则自动查找 */
  ffmpeg_path: string;
  /** 缓存目录（covers + frames）上限，单位 MB；0 = 不限制也不自动清理 */
  cache_limit_mb: number;
  /** 第三方平台（B站 / 小红书 / YouTube）下载开关 */
  platform_enabled: boolean;
  /** yt-dlp 路径，留空自动查找（镜像内置 → PATH） */
  ytdlp_path: string;
  /** 清晰度上限：best / 1080 / 720 / 480 */
  platform_quality: string;
  /** 旧字段（1.3.2 起由下面 5 个分来源目录取代），仅用于兼容老后端 */
  platform_dir: string;
  /** 分来源落盘子目录（相对下载根，可多级；留空 = 直接放下载根下） */
  dir_telegram: string;
  dir_bilibili: string;
  dir_xiaohongshu: string;
  dir_youtube: string;
  dir_m3u8: string;
  /** 第三方视频也写 nfo + 封面 */
  platform_meta: boolean;
  /** 只给 yt-dlp 用的代理；下 YouTube 通常必须填 */
  platform_proxy: string;
  /** 国内平台（B站 / 小红书）是否也走这条代理，默认关 */
  platform_proxy_domestic: boolean;
  /** 定时检查 yt-dlp 新版本 */
  ytdlp_auto_update: boolean;
  /** 检查间隔（小时） */
  ytdlp_check_hours: number;
  /** 网页 / m3u8 下载用的代理；留空则回落环境变量 */
  m3u8_proxy: string;
  /** 网页 / m3u8 下载的线路策略：auto=直连优先 / always=强制代理 / off=只直连 */
  m3u8_proxy_mode: "auto" | "always" | "off";
  /** 是否启用 AI 功能（补全 NFO / 智能命名 / 日志诊断等） */
  ai_enabled: boolean;
  /** AI 服务地址（OpenAI 兼容协议），例如 https://api.openai.com/v1、https://api.deepseek.com/v1 */
  ai_base_url: string;
  /** 使用的模型名，例如 gpt-4o-mini、deepseek-chat、qwen-max */
  ai_model: string;
  /** AI 智能命名兜底：正则识别不出剧名但消息有视频时，用 AI 再试一次 */
  ai_naming: boolean;
  has_session?: boolean;
}

/* ------------------------------ 第三方平台 ------------------------------ */

export type PlatformId = "bilibili" | "xiaohongshu" | "youtube";

export interface YtdlpInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  source: "custom" | "local" | "bundled" | "path" | null;
  error: string | null;
}

export interface EngineUpdateState {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  /** 下次自动检查的绝对时间；关掉自动更新时为 null */
  nextCheckAt: number | null;
  updatedAt: number | null;
  lastError: string | null;
  busy: boolean;
  /** 0–1；-1 表示正在检查 */
  progress: number;
  autoUpdate: boolean;
  checkHours: number;
}

export interface PlatformCookieState {
  set: boolean;
  hint: string | null;
  count?: number;
  missing?: string[];
  savedAt?: number | null;
}

export interface PlatformInfo {
  id: PlatformId;
  label: string;
  cookieSet: boolean;
  cookieHint: string | null;
  cookieCount: number;
  cookieMissing: string[];
  cookieSavedAt: number | null;
}

export interface PlatformStatus {
  enabled: boolean;
  quality: string;
  /** 每个平台自己的落盘目录（相对下载根），键是平台 id */
  dirs: Record<string, string>;
  /** 上面那些目录解析成的绝对路径 */
  roots: Record<string, string>;
  meta: boolean;
  proxy: string;
  /** 国内平台是否也走代理（默认 false：B站直连，避免 567） */
  proxyDomestic: boolean;
  ytdlp: YtdlpInfo;
  update: EngineUpdateState;
  platforms: PlatformInfo[];
}

export interface EngineUpdateResult {
  ok: boolean;
  updated: boolean;
  from: string | null;
  to: string | null;
  error: string | null;
  ytdlp: YtdlpInfo;
  update: EngineUpdateState;
}

export interface PlatformPlaylistEntry {
  id: string;
  title: string;
  url: string;
  uploader: string;
  duration: number | null;
  thumbnail: string | null;
}

export interface PlatformPlaylist {
  count: number;
  /** 超过 200 条只读了前 200 条 */
  capped: boolean;
  entries: PlatformPlaylistEntry[];
}

export interface PlatformProbe {
  platform: PlatformId;
  id: string;
  title: string;
  uploader: string;
  duration: number | null;
  thumbnail: string | null;
  description: string;
  uploadedAt: number | null;
  webpageUrl: string;
  filesize: number | null;
  viewCount: number | null;
  likeCount: number | null;
  /** 分区 / 分类，会写成 Emby 的 genre */
  categories: string[];
  /** 合集 / 多P 才有 */
  playlist: PlatformPlaylist | null;
}

export interface PlatformTask {
  platform: PlatformId;
  url: string;
  id: string | null;
  title: string;
  uploader: string;
  duration: number | null;
  taskId: number | null;
  existing: boolean;
  saveDir: string;
  filesize: number | null;
}

/** 合集 / 多P 的二次选择项 */
export interface PlatformChoiceInfo {
  token: string;
  platform: PlatformId;
  url: string;
  title: string;
  count: number;
  capped: boolean;
  firstTitle: string;
  firstUploader: string;
  firstDuration: number | null;
  firstFilesize: number | null;
}

export interface PlatformChoiceResponse {
  needsChoice: true;
  choice: PlatformChoiceInfo;
}

export interface PlatformTaskResponse {
  needsChoice: false;
  platform: PlatformId;
  label: string;
  url: string;
  playlist: { count: number; mode: "one" | "all"; capped: boolean } | null;
  queued: number;
  existing: number;
  tasks: PlatformTask[];
}

export type PlatformEnqueueResponse = PlatformChoiceResponse | PlatformTaskResponse;

/* ------------------------------ 缓存 ------------------------------ */

export interface CacheUsage {
  bytes: number;
  files: number;
  groups: number;
}

export interface CacheStats {
  covers: CacheUsage;
  frames: CacheUsage;
  total: CacheUsage;
  limitMb: number;
  /** 超出上限的字节数；没超为 0 */
  overBytes: number;
  lastTrimAt: number | null;
  lastTrimFreed: number;
  lastTrimReason: "auto" | "manual" | "clear" | null;
}

export interface CacheActionResult {
  freed: number;
  removedGroups: number;
  removedFiles: number;
  remaining: number;
  triggered: boolean;
  stats: CacheStats;
  message: string;
}

export interface BotState {
  enabled: boolean;
  running: boolean;
  username: string | null;
  userId: string | null;
  error: string | null;
  startedAt: number | null;
  allowCount: number;
  tokenSet: boolean;
  tokenHint: string | null;
}

export interface CredentialInfo {
  mode: CredentialMode;
  label: string;
  apiId: string | null;
}

export interface SettingsResponse {
  settings: AppSettings;
  credential?: CredentialInfo;
  paths: { dataDir: string; downloadDir: string; dbFile: string };
  /** 后端版本号（与镜像标签、/api/health 一致） */
  version?: string;
  bot?: BotState;
  /** Emby API Key 只回掩码 */
  emby?: { apiKeySet: boolean; apiKeyHint: string | null };
  /** AI API Key 只回掩码 */
  ai?: { apiKeySet: boolean; apiKeyHint: string | null };
}

/* ------------------------------ 网络与代理 ------------------------------ */

export type ProxyScheme = "socks4" | "socks5" | "socks5h" | "http" | "https";

export interface ProxyStatus {
  /** 设置里保存的原始地址 */
  proxyUrl: string;
  proxy: { scheme: ProxyScheme; host: string; port: number; hasAuth: boolean } | null;
  /** 填了但解析不出来时的说明 */
  problem: string | null;
  /** HTTP(S) 代理无法用于 Telegram 的 MTProto 连接 */
  telegramUnsupported: boolean;
  schemes: Array<{ value: ProxyScheme; label: string; hint: string }>;
  sites: Array<{ id: string; label: string; note: string; url: string }>;
}

export interface NetProbeResult {
  id: string;
  label: string;
  note: string;
  url: string;
  ok: boolean;
  status: number | null;
  ms: number | null;
  error: string | null;
  viaProxy: boolean;
}

export interface NetProbeReport {
  at: number;
  elapsedMs: number;
  viaProxy: boolean;
  proxy: { scheme: ProxyScheme; host: string; port: number } | null;
  results: NetProbeResult[];
}

export interface BotIdentity {
  ok: boolean;
  id: string | null;
  username: string | null;
  name: string | null;
  ms: number | null;
  error: string | null;
}

export interface BotTestResult {
  ok: boolean;
  identity: BotIdentity | null;
  viaProxy: boolean;
  error?: string;
}

export interface FfmpegStatus {
  ffmpeg: FfmpegInfo;
  /** 当前实际生效的来源（设置 / 环境变量 / 内置 / PATH） */
  sourceLabel: string | null;
  /** 设置里填写、尚未生效的路径 */
  configuredPath: string;
}

/* ------------------------------ Emby 入库 ------------------------------ */

/** 一条入库通知记录（服务端内存里保留最近 30 条） */
export interface EmbyNotifyRecord {
  at: number;
  /** 映射后提交给 Emby 的路径 */
  paths: string[];
  ok: boolean;
  status: number | null;
  error: string | null;
  /** true = 下载完成自动触发，false = 手动补推 / 重新生成元数据 */
  auto: boolean;
}

export interface EmbyStatus {
  enabled: boolean;
  configured: boolean;
  url: string;
  pathMap: string[];
  apiKeySet: boolean;
  apiKeyHint: string | null;
  downloadDir: string;
  lastNotifiedAt: number | null;
  /** 还在攒批、尚未提交的路径数 */
  pending: number;
  history: EmbyNotifyRecord[];
}

export interface EmbyProbeResult {
  ok: boolean;
  serverName: string | null;
  version: string | null;
  error: string | null;
  /** 实际探测用的地址（已补全协议、去掉 /web） */
  url?: string;
}

/* ------------------------------ 本地媒体库 ------------------------------ */

/** 可以切换的库位置（下载根 / 各平台目录 / 手动登记的来源） */
export interface MediaRoot {
  path: string;
  label: string;
  rel: string;
  kind: "root" | "platform" | "source";
}

export interface MediaEpisode {
  path: string;
  name: string;
  title: string;
  /** 本集简介（单集 NFO 的 plot），没有就是空串 */
  plot: string;
  season: number | null;
  episode: number | null;
  size: number;
  updatedAt: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  /** direct = 原生播放（可拖进度条），remux = 服务端换封装，transcode = 显卡转码，unsupported = 播不了 */
  playMode: "direct" | "remux" | "transcode" | "unsupported";
  /** 播放地址（已按 playMode 选好模式） */
  streamUrl: string;
  /** 缩略图地址（下载时生成的图或服务端抽帧，取不到图时为 null） */
  thumbUrl: string | null;
  /** .strm 链接文件：播放走服务端转发，封面由播放器在播放时截取并落在同级目录 */
  isStrm?: boolean;
  /**
   * 这一集本来会被判成「浏览器不支持」，是因为打开了
   * 「我的浏览器能放 HEVC，强制尝试」才变成可播的 —— 界面上标「试播」。
   */
  trial?: boolean;
}

/** 选中目录后批量补齐 strm 单集 NFO 的结果（纯本地写盘） */
export interface MediaStrmNfoResult {
  ok: boolean;
  dir: string;
  /** 扫到的 strm 总数 */
  scanned: number;
  /** 本次新建的 NFO */
  created: number;
  /** 本来就有 NFO */
  existing: number;
  /** 写失败（多数是媒体目录不可写） */
  failed: number;
  /** 撞到扫描上限，还有没扫到的 */
  truncated: boolean;
}

/** AI 补全媒体信息（功能 A）的结果 */
export interface MediaStrmAiNfoResult {
  ok: boolean;
  dir: string;
  /** 扫到的 strm 总数 */
  scanned: number;
  /** 本次用 AI 补全的 NFO（含剧集 NFO） */
  enriched: number;
  /** 本来就有的、或已补过的、跳过的 */
  skipped: number;
  /** 写失败（多数是媒体目录不可写） */
  failed: number;
  /** 撞到扫描上限，还有没扫到的 */
  truncated: boolean;
}

/** 保存 strm 封面的结果 */
export interface MediaPosterResult {
  ok: boolean;
  /** 已有封面且这次没有覆盖 */
  existed: boolean;
  posterCreated: boolean;
  nfoCreated: boolean;
  /** 带新版本号的缩略图地址，可直接替换卡片上的图 */
  thumbUrl: string;
}

export interface MediaSeries {
  dir: string;
  name: string;
  title: string;
  year: number | null;
  overview: string;
  genres: string[];
  rating: number | null;
  episodeCount: number;
  totalSize: number;
  updatedAt: number;
  hasNfo: boolean;
  origin: string;
  firstVideo: string | null;
  posterUrl: string | null;
  landscapeUrl: string | null;
}

export interface MediaLibraryResponse {
  ok: boolean;
  dir: string;
  parent: string | null;
  home: string;
  roots: MediaRoot[];
  /** 这个目录自己就是一部剧（用户已经点进来了） */
  isSeries: boolean;
  /** 服务端的硬件解码能力（没显卡时 available=false，reason 说明原因） */
  hw?: MediaHwInfo;
  series: MediaSeries[];
  loose: MediaEpisode[];
}

/** 显卡转码能力：部署在带核显的 NAS 上时，浏览器解不了的编码交给显卡 */
export interface MediaHwInfo {
  available: boolean;
  accel: "vaapi" | "qsv" | "software" | null;
  /** 界面展示用，例如「VAAPI（/dev/dri/renderD128）」 */
  label: string;
  /** 不可用原因 */
  reason: string | null;
}

export interface MediaSeriesResponse {
  ok: boolean;
  dir: string;
  hw?: MediaHwInfo;
  series: MediaSeries;
  episodes: MediaEpisode[];
}

export type QrStatus = "idle" | "waiting" | "scanned" | "password" | "success" | "error";

export interface QrState {
  active: boolean;
  status: QrStatus;
  url: string | null;
  expiresAt: number | null;
  error: string | null;
  credentialMode: CredentialMode | null;
  appLabel: string | null;
  passwordHint: string | null;
  elapsedMs: number;
  qrDataUrl: string | null;
  auth?: AuthState;
}

/* ------------------------------ 元数据 ------------------------------ */

export type ImageName = "poster" | "landscape" | "fanart" | "thumb" | "banner";
export type ImageScope = "series" | "episode";

/**
 * 元数据页的一条记录 = 一个文件夹（剧集级）。
 * 展开后子级是文件夹里的每个视频文件（单集级）。
 */
/**
 * 媒体归档来源。
 *
 * 由后端按「下载记录 source + 相对下载根的第一段目录」推断，
 * 目录名来自设置里的 5 个下载目录，用户改了目录名这里跟着变。
 */
export type MediaOrigin =
  | "telegram"
  | "bilibili"
  | "xiaohongshu"
  | "youtube"
  | "m3u8"
  | "manual"
  | "mixed"
  | "other";

/** 分区统计：某一来源下有多少个剧集目录 */
export interface MetadataOriginGroup {
  origin: MediaOrigin;
  label: string;
  count: number;
}

export interface MetadataFileItem {
  /** 路径标识（base64url 编码的绝对路径） */
  key: string;
  path: string;
  name: string;
  size: number;
  series: string;
  season: number | null;
  episode: number | null;
  /** 展示用标题：剧名 + SxxExx */
  title: string;
  nfoExists: boolean;
  source: "download" | "manual";
  /** 归档来源，决定它显示在哪个分区 */
  origin: MediaOrigin;
  /** 磁盘上已经找不到这个文件了 */
  missing: boolean;
  /** 最近更新时间（毫秒） */
  updatedAt: number;
  downloadId: number | null;
  channelTitle: string | null;
}

export interface MetadataFolderItem {
  key: string;
  dir: string;
  name: string;
  fileCount: number;
  totalSize: number;
  source: "download" | "manual" | "mixed";
  /** 归档来源：telegram / bilibili / xiaohongshu / youtube / m3u8 / manual / mixed */
  origin: MediaOrigin;
  /** 磁盘上已经找不到这个目录了（只剩数据库记录） */
  missing: boolean;
  /** 最近更新时间（毫秒） */
  updatedAt: number;
  /** 贡献该文件夹的手动来源 id（删除按钮据此回溯移除来源） */
  sourceIds: number[];
  /** 贡献该文件夹的手动来源路径 */
  sourcePaths: string[];
  /** tvshow.nfo 是否存在 */
  nfoExists: boolean;
  /** 剧集封面是否存在 */
  posterExists: boolean;
  imageCount: number;
  posterUrl: string | null;
  files: MetadataFileItem[];
}

/**
 * 改名 / 合并剧集的预览：每一条都是「原文件 → 新文件」。
 *
 * 顺序由后端按集号（或文件名自然序）确定，编号重排成连续的 E01…EN。
 */
export interface RenamePlanItem {
  from: string;
  to: string;
  oldEpisode: number | null;
  newEpisode: number;
}

export interface RenamePlanPreview {
  title: string;
  season: number;
  targetDir: string;
  items: RenamePlanItem[];
  /** 需要提醒但不阻断的问题（集号重复、季号混用等） */
  warnings: string[];
  /** 目标位置已有同名文件 */
  conflicts: string[];
}

export interface RenameExecuteResult {
  ok: boolean;
  /** 改完之后目录的路径标识，界面据此跳转 */
  key: string;
  dir: string;
  title: string;
  plan: RenamePlanPreview;
  /** 同步更新了剧名的 NFO 份数 */
  nfoUpdated: number;
  result: {
    moved: number;
    sidecars: number;
    downloads: number;
    emptyDirs: number;
    skipped: string[];
    failed: Array<{ path: string; error: string }>;
  };
}

/** 手动添加的媒体来源 */
export interface MetadataSource {
  id: number;
  path: string;
  kind: "dir" | "file";
  title: string | null;
  created_at: number;
  key: string;
  /** 这个来源展开成几个剧集文件夹 */
  folderCount: number;
  /** 展开后的剧集文件夹名 */
  folderNames: string[];
  /** 覆盖的视频数 */
  fileCount: number;
}

/**
 * 删除模式：
 *   purge  = 连磁盘文件一起删（视频 + NFO + 封面图）
 *   unlink = 只从列表移除，磁盘文件保留
 */
export type DeleteMode = "purge" | "unlink";

export interface MetadataDeleteItem {
  path: string;
  name: string;
  kind: "video" | "nfo" | "image" | "other";
  size: number;
}

/** 删除预览：执行前把「会删什么」摊开给用户看 */
export interface MetadataDeletePlan {
  target: string;
  targetKind: "file" | "folder";
  mode: DeleteMode;
  /** 目标在磁盘上是否还在；false 表示本次只清理数据库记录 */
  targetExists: boolean;
  /** 会被删除的文件 */
  items: MetadataDeleteItem[];
  /** 不会被删除、但列出来让用户知情的其它文件 */
  kept: MetadataDeleteItem[];
  totalSize: number;
  videoCount: number;
  nfoCount: number;
  imageCount: number;
  downloadIds: number[];
  sourceIds: number[];
  warnings: string[];
}

/** 删除结果 */
export interface MetadataDeleteResult {
  ok: boolean;
  mode: DeleteMode;
  /** 目标本来就不在磁盘上：本次只清了记录 */
  targetExists: boolean;
  removedFiles: number;
  removedBytes: number;
  removedVideos: number;
  removedDirs: number;
  removedDownloads: number;
  removedSources: number;
  failed: string[];
}

/** 移动 / 复制的单条结果 */
export interface MetadataTransferResult {
  from: string;
  to: string;
  ok: boolean;
  error?: string;
  /** 同步过来的下载记录数 */
  downloads: number;
  /** 同步过来的来源登记数 */
  sources: number;
}

export interface MetadataTransferResponse {
  ok: boolean;
  action: "move" | "copy";
  dest: string;
  results: MetadataTransferResult[];
  /** 没执行的项目及原因 */
  skipped: Array<{ from: string; reason: string }>;
}

/** 被「仅从列表移除」隐藏的条目 */
export interface MetadataExcludedItem {
  path: string;
  created_at: number;
}

/** 服务端目录浏览结果 */
export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; size: number }>;
  home: string;
}

export interface NfoFields {
  title: string;
  originaltitle: string;
  showtitle: string;
  season: string;
  episode: string;
  year: string;
  aired: string;
  premiered: string;
  plot: string;
  outline: string;
  studio: string;
  rating: string;
  /** 下载时的原始文件名（追溯用，不是落盘名） */
  originalfilename: string;
  /** 来源：Telegram · 频道名 / B站 / 网页 / m3u8 / 外部目录 */
  source: string;
  tags: string[];
  genres: string[];
}

export interface VideoProbe {
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  fps: number | null;
  container: string | null;
  sizeBytes: number | null;
}

export interface FfmpegInfo {
  available: boolean;
  ffmpeg: string | null;
  source: "settings" | "env" | "bundled" | "path" | null;
  version: string | null;
  error: string | null;
}

export interface MetadataImage {
  scope: ImageScope;
  name: ImageName;
  label: string;
  file: string;
  size: number;
  updatedAt: number;
  width: number | null;
  height: number | null;
  url: string;
}

export interface NfoSlotInfo {
  exists: boolean;
  file: string;
  path?: string;
  size: number;
  nested: boolean;
  editable: boolean;
}

export interface MetadataDetail {
  target: {
    kind: "file" | "folder";
    key: string;
    path: string;
    dir: string;
    base: string | null;
    name: string;
    dirName: string;
    /** 磁盘上找不到这个位置（只剩数据库记录） */
    missing: boolean;
  };
  paths: { dir: string; video: string | null; base: string | null; dirName: string };
  /**
   * 视频信息。
   * source = "first" 表示这是剧集目录下的第一集（剧集封面取自它）。
   */
  video: { exists: boolean; size: number; probe: VideoProbe | null; source: "self" | "first" };
  nfo: { episode: NfoSlotInfo | null; show: NfoSlotInfo };
  images: MetadataImage[];
  extras: Array<{ file: string; url: string }>;
  fields: { episode: NfoFields; show: NfoFields };
  meta: Record<string, unknown> | null;
  ffmpeg: FfmpegInfo;
  covers: Array<{ file: string; index: number }>;
  download: {
    id: number;
    channel_title: string;
    message_id: number;
    file_size: number;
    finished_at: number | null;
  } | null;
}

/** 保存元数据时联动改名的结果（失败不影响 NFO 已保存的事实） */
export interface MetaRenameResult {
  applied: boolean;
  key?: string;
  dir?: string;
  /** 目录本身是否也搬了位置 */
  dirMoved?: boolean;
  moved?: number;
  sidecars?: number;
  nfoUpdated?: number;
  error?: string;
}

export interface FrameCandidate {
  index: number;
  at: number;
  url: string;
}

/** 归一化裁剪框（0~1，相对整帧左上角），由界面框选得出 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 管理界面登录状态（GET /api/session/state） */
export interface SessionState {
  /** 是否已设置管理员账号。false 时前端引导初始化，而不是显示登录框 */
  configured: boolean;
  authenticated: boolean;
  /** 服务端以 AUTH_DISABLED 关闭了登录（逃生模式） */
  authDisabled: boolean;
  username: string | null;
  since: number | null;
  session: { expiresAt: number; createdAt: number } | null;
  /** 当前有效会话数，用于「退出其它设备」文案 */
  devices: number;
}

/* ------------------------------ 概览页聚合状态 ------------------------------ */

/** 与 server/src/system/overviewFormat.ts 保持一致 */
export type ProbeStatus = "ok" | "warn" | "error" | "off";

export interface ToolProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  version: string | null;
  /** 可执行文件 / 模块 / 数据文件的绝对路径 */
  path: string | null;
  source: string | null;
  note: string | null;
  usedBy: string;
}

export interface ServiceProbe {
  id: string;
  label: string;
  status: ProbeStatus;
  value: string;
  note: string | null;
  page: "settings" | "channels" | "downloads" | "logs" | "manual" | "metadata" | null;
  detail?: string[];
  hint?: string | null;
}

/** 概览顶部的一条「留意 / 异常」，带可忽略的稳定 id 与展开详情 */
export interface OverviewIssue {
  id: string;
  level: "warn" | "error";
  label: string;
  text: string;
  detail: string[];
  hint: string | null;
  page: "settings" | "channels" | "downloads" | "logs" | "manual" | "metadata" | null;
  ignoredAt: number | null;
}

export interface StorageDirProbe {
  id: string;
  label: string;
  rel: string;
  absolute: string;
  exists: boolean;
  writable: boolean;
  error: string | null;
}

export interface OverviewReport {
  at: number;
  elapsedMs: number;
  cached: boolean;
  runtime: {
    version: string;
    node: string;
    platform: string;
    arch: string;
    os: string;
    cpus: number;
    totalMemory: number;
    workDir: string;
    pid: number;
    uptime: number;
    startedAt: number;
    timezone: string;
    resolvedTimezone: string;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
    inContainer: boolean;
  };
  storage: {
    dataDir: string;
    downloadDir: string;
    dbFile: string;
    dbSize: number;
    dbTables: number;
    dbRows: number;
    cacheLimitMb: number;
    writable: { data: boolean; downloads: boolean };
    disk: { total: number; free: number; used: number; percent: number; status: ProbeStatus } | null;
    dirs: StorageDirProbe[];
  };
  tools: ToolProbe[];
  services: ServiceProbe[];
  summary: {
    ok: number;
    warn: number;
    error: number;
    off: number;
    /** 计数只算未忽略的项，和顶部标题一致 */
    issues: OverviewIssue[];
    ignored: OverviewIssue[];
    ignoredCount: number;
    overall: ProbeStatus;
  };
}
