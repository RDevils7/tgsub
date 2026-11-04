import { parsePlatformLink } from "../platform/detect";
import { ORIGIN_LABEL } from "./origin";

/**
 * NFO 里的追溯信息：原始文件名与来源。
 *
 * 下载落盘时文件名会被改成「剧名 S01E01.mp4」，改名 / 合并之后原来的
 * Telegram 文件名、平台原始名就找不回来了；来源（哪个频道 / 哪个平台）也
 * 只存在数据库里，NFO 被 Emby 或第三方工具重写后同样会丢。
 * 生成 NFO 时把这两项一起写进去，之后无论怎么重建都能对上原始记录。
 *
 * 纯函数：不 import db / env，自检可以直接调。
 */

export interface NfoTrace {
  /** 下载时的原始文件名（不是落盘后的「剧名 S01E01.mp4」） */
  originalFileName: string;
  /** 人能看懂的来源：Telegram · 频道名 / B站 / 网页 / m3u8 / 外部目录 */
  sourceLabel: string;
  /** 原链接；已由 <uniqueid> 记录，这里留作兜底 */
  sourceUrl: string | null;
}

export interface TraceRow {
  file_name?: string | null;
  save_name?: string | null;
  source?: string | null;
  source_url?: string | null;
  channel_title?: string | null;
}

export function nfoTraceOf(row: TraceRow | null | undefined, fallbackFileName: string): NfoTrace {
  const originalFileName = String(row?.file_name || row?.save_name || fallbackFileName || "").trim();
  const source = String(row?.source ?? "").toLowerCase();
  const sourceUrl = String(row?.source_url ?? "").trim() || null;
  const channel = String(row?.channel_title ?? "").trim();

  let sourceLabel: string;
  if (!row) {
    sourceLabel = ORIGIN_LABEL.manual;
  } else if (source === "telegram") {
    sourceLabel = channel ? `${ORIGIN_LABEL.telegram} · ${channel}` : ORIGIN_LABEL.telegram;
  } else if (source === "m3u8") {
    sourceLabel = ORIGIN_LABEL.m3u8;
  } else if (source === "platform") {
    const hit = sourceUrl ? parsePlatformLink(sourceUrl) : null;
    sourceLabel = hit ? ORIGIN_LABEL[hit.platform] : channel || ORIGIN_LABEL.other;
  } else {
    sourceLabel = ORIGIN_LABEL.other;
  }

  return { originalFileName, sourceLabel, sourceUrl };
}
