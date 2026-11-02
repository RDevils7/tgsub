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
  /** 任务来源：telegram = 频道媒体，platform = B站/抖音/小红书（yt-dlp） */
  source: string;
  /** 第三方任务的原链接 */
  source_url: string | null;
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
  /** 为 Emby 生成 nfo / 缩略图 / 封面；开启时消息里的图片不再下载 */
  emby_meta: boolean;
  /**
   * @deprecated 1.0.2 起封面改为「从视频随机截帧」，消息里的图片不再下载。
   * 字段保留只为兼容老库与接口返回，不再参与任何逻辑。
   */
  cover_images: number;
  /** 正文里认不出剧名时，一条链接建一个文件夹，文件夹名取正文内容 */
  fallback_folder: boolean;
  /** 下载完成后用 ffmpeg 从视频随机截帧，生成每集缩略图与剧集目录封面 */
  auto_cover_frames: boolean;
  /** 下载完成后通知 Emby 入库（POST /Library/Media/Updated），Emby 上立刻能看到新集 */
  emby_notify: boolean;
  /** Emby 服务地址，例如 http://192.168.1.10:8096；末尾的 /emby 可填可省 */
  emby_url: string;
  /**
   * 路径映射：每行一条「本机路径=Emby 路径」。
   * 容器里下载到 /downloads，而 Emby 看到的是 /volume1/media/tgsub，
   * 不映射的话 Emby 会说「路径不存在」而拒绝入库。
   */
  emby_path_map: string;
  /** 启用 Telegram 机器人：给机器人发消息即可控制本程序 */
  bot_enabled: boolean;
  /** 允许操作机器人的 Telegram 用户 ID（逗号分隔）；留空则一律拒绝并回复对方 ID */
  bot_allow_users: string;
  /** 扫描发现新内容时主动推送摘要 */
  bot_notify: boolean;
  /** ffmpeg 可执行文件路径；留空则自动查找（内置 npm 包 → PATH） */
  ffmpeg_path: string;
  /**
   * 缓存目录（data/covers + data/frames）的上限，单位 MB。
   * 超过后按最后写入时间从旧到新自动清理；0 = 不限制，也不自动清理。
   */
  cache_limit_mb: number;
  /** 启用第三方平台下载（B站 / 抖音 / 小红书），引擎是 yt-dlp */
  platform_enabled: boolean;
  /** yt-dlp 可执行文件路径；留空则自动查找（镜像内置 → PATH） */
  ytdlp_path: string;
  /** 清晰度上限：best / 1080 / 720 / 480 */
  platform_quality: string;
  /** 第三方视频存到下载目录下的哪个子目录，留空表示直接放根目录 */
  platform_dir: string;
  /** 第三方视频也写 .nfo + 截帧封面，供 Emby 识别 */
  platform_meta: boolean;
  /**
   * 只给 yt-dlp 用的代理（Telegram 那条 proxy_url 不动）。
   * 下 B站 / 抖音 / 小红书一般留空；下 YouTube 通常必须填。
   */
  platform_proxy: string;
  /** 定时检查 yt-dlp 新版本，有就自动下载到 data/bin */
  ytdlp_auto_update: boolean;
  /** 多久检查一次（小时），默认 24 */
  ytdlp_check_hours: number;
}

/** 支持的第三方平台 */
export type PlatformId = "bilibili" | "douyin" | "xiaohongshu" | "youtube";

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  bilibili: "B站",
  douyin: "抖音",
  xiaohongshu: "小红书",
  youtube: "YouTube",
};

/** 界面与日志里的统一顺序 */
export const PLATFORM_IDS: PlatformId[] = ["bilibili", "douyin", "xiaohongshu", "youtube"];

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
  emby_notify: false,
  emby_url: "",
  emby_path_map: "",
  bot_enabled: false,
  bot_allow_users: "",
  bot_notify: true,
  ffmpeg_path: "",
  cache_limit_mb: 512,
  platform_enabled: false,
  ytdlp_path: "",
  platform_quality: "1080",
  platform_dir: "第三方",
  platform_meta: true,
  platform_proxy: "",
  ytdlp_auto_update: true,
  ytdlp_check_hours: 24,
};
