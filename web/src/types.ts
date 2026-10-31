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
  /** 为 Emby 生成 nfo / 封面；开启时图片只留 cover_images 张 */
  emby_meta: boolean;
  cover_images: number;
  /** Telegram 机器人开关与白名单（token 单独管理，不在这里返回） */
  bot_enabled: boolean;
  bot_allow_users: string;
  bot_notify: boolean;
  has_session?: boolean;
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
  bot?: BotState;
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
