export type MatchMode = "contains" | "word" | "regex";

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

export type DownloadStatus =
  | "queued"
  | "downloading"
  /** 用户手动暂停（继续后从头下载，gramjs 不支持断点续传） */
  | "paused"
  /** 用户手动停止 */
  | "stopped"
  | "done"
  | "failed"
  | "skipped";

export interface Download {
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
  /** 按正文剧集解析出的目标文件夹（相对下载根目录） */
  save_dir: string | null;
  /** 按正文剧集解析出的目标文件名 */
  save_name: string | null;
  /** Emby 元信息（剧名/季/集/简介/标签等），下载完成后据此生成 nfo 与封面 */
  emby_json: string | null;
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

/** 一条消息的监控记录（相册整组算一条） */
export interface MessageLog {
  id: number;
  channel_id: number;
  channel_title: string;
  channel_username: string | null;
  message_id: number;
  grouped_id: string | null;
  /** hit=命中并入队, filtered=命中但被大小限制过滤, miss=未命中, empty=无文本无媒体 */
  kind: string;
  matched_keyword: string | null;
  subscription_id: number | null;
  subscription_name: string | null;
  media_kind: string | null;
  file_name: string | null;
  file_size: number;
  file_count: number;
  /** 消息内文件清单 JSON：[{kind,name,size}] */
  file_names: string | null;
  /** 完整正文（列表用的 excerpt 只截了 400 字） */
  full_text: string | null;
  excerpt: string | null;
  run_id: number | null;
  created_at: number;
  last_seen_at: number;
  seen_count: number;
}

/** builtin = 用内置官方客户端凭证（无需申请）；custom = 用户自备 api_id/api_hash */
export type CredentialMode = "builtin" | "custom";

export interface AppSettings {
  credential_mode: CredentialMode;
  /** 内置凭证选择：desktop | builtin */
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
  /** 为 Emby 生成 nfo / 封面；开启时消息里的图片只留 N 张当封面 */
  emby_meta: boolean;
  /** 每条消息保留几张图片做封面（poster / landscape / fanart） */
  cover_images: number;
  /** 正文里认不出剧名时，一条链接建一个文件夹，文件夹名取正文内容 */
  fallback_folder: boolean;
  /** 消息里没有可用图片时，用 ffmpeg 随机截帧自动生成横版/竖版封面 */
  auto_cover_frames: boolean;
  /** 启用 Telegram 机器人：给机器人发消息即可控制本程序 */
  bot_enabled: boolean;
  /** 允许操作机器人的 Telegram 用户 ID（逗号分隔）；留空则一律拒绝并回复对方 ID */
  bot_allow_users: string;
  /** 扫描发现新内容时主动推送摘要 */
  bot_notify: boolean;
  /** ffmpeg 可执行文件路径；留空则自动查找（内置 npm 包 → PATH） */
  ffmpeg_path: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  credential_mode: "builtin",
  builtin_app: "builtin",
  api_id: "",
  api_hash: "",
  proxy_url: "",
  scan_interval_minutes: 15,
  initial_scan_messages: 40,
  batch_size: 100,
  concurrency: 3,
  min_file_size: 0,
  max_file_size: 0,
  auto_scan: true,
  file_template: "{date}/{channel}/{name}",
  emby_meta: true,
  cover_images: 3,
  fallback_folder: true,
  auto_cover_frames: true,
  bot_enabled: false,
  bot_allow_users: "",
  bot_notify: true,
  ffmpeg_path: "",
};
