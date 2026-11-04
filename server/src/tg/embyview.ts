import { Readable } from "node:stream";
import type { Response } from "express";
import { getEmbyApiKey, getSettings } from "../db";
import { logger } from "../logger";
import { normalizeEmbyUrl } from "./embypath";

/**
 * Emby 媒体库浏览。
 *
 * 与 embyapi.ts（入库通知）分开：
 *   - 入库通知要求「已开启通知」才工作，这里只要地址 + API Key 就能看库，
 *     否则用户明明配好了连接，却因为没开通知而看不到自己的媒体库。
 *   - 这里的接口是「读」的：媒体库列表、条目、详情、海报、视频流。
 *
 * 所有请求都由服务端代理，不把 API Key 送到浏览器：
 *   - 图片：<img> 不能带自定义头，代理才能带上 Token；
 *   - 视频：Emby 的地址常是容器内网地址，浏览器未必直连得到；
 *     代理同时透传 Range，播放器才能拖动进度条。
 */

export interface EmbyServerConfig {
  baseUrl: string;
  apiKey: string;
}

/** 列表 / 详情请求的超时；流代理不设超时，一集看一个多小时很正常 */
const REQUEST_TIMEOUT_MS = 12_000;

/** 只要地址与 Key 齐了就能读媒体库，不要求「入库通知」开关打开 */
export function getEmbyServerConfig(): EmbyServerConfig | null {
  let settings;
  try {
    settings = getSettings();
  } catch {
    return null;
  }
  const baseUrl = normalizeEmbyUrl(settings.emby_url);
  const apiKey = getEmbyApiKey();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

function authHeaders(config: EmbyServerConfig): Record<string, string> {
  // 两个表头都给，兼容新旧版本 Emby
  return {
    "X-Emby-Token": config.apiKey,
    "X-MediaBrowser-Token": config.apiKey,
  };
}

async function apiGet<T>(config: EmbyServerConfig, pathname: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}${pathname}`, {
      headers: { Accept: "application/json", ...authHeaders(config) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const snippet = await res
        .text()
        .then((text) => text.replace(/\s+/g, " ").slice(0, 160))
        .catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error("Emby 拒绝了 API Key（401），请到设置页重新填写");
      }
      throw new Error(`Emby 返回 HTTP ${res.status}${snippet ? `：${snippet}` : ""}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`连接 Emby 超时（${REQUEST_TIMEOUT_MS / 1000} 秒），检查地址与网络`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 用户 ------------------------------ */

let cachedUser: { baseUrl: string; id: string } | null = null;

interface EmbyUser {
  Id: string;
  Name?: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
}

/**
 * Emby 的媒体库接口都要带 UserId（要算已看状态、隐藏项）。
 * 这里取管理员优先，其次第一个没被禁用的用户；地址变了就重查。
 */
export async function resolveUserId(config: EmbyServerConfig): Promise<string> {
  if (cachedUser && cachedUser.baseUrl === config.baseUrl) return cachedUser.id;
  const users = await apiGet<EmbyUser[]>(config, "/Users");
  const pick =
    users.find((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled) ??
    users.find((u) => !u.Policy?.IsDisabled) ??
    users[0];
  if (!pick?.Id) throw new Error("Emby 上找不到可用用户，请检查 API Key 权限");
  cachedUser = { baseUrl: config.baseUrl, id: pick.Id };
  return pick.Id;
}

/* ------------------------------ 媒体库 ------------------------------ */

export interface EmbyLibraryView {
  id: string;
  name: string;
  /** movies / tvshows / music / homevideos …，可能为空 */
  collectionType: string | null;
}

interface RawView {
  Id: string;
  Name: string;
  CollectionType?: string;
}

export async function listLibraries(config: EmbyServerConfig): Promise<EmbyLibraryView[]> {
  const userId = await resolveUserId(config);
  const data = await apiGet<{ Items?: RawView[] }>(config, `/Users/${userId}/Views`);
  return (data.Items ?? []).map((item) => ({
    id: item.Id,
    name: item.Name,
    collectionType: item.CollectionType ?? null,
  }));
}

/* ------------------------------ 条目 ------------------------------ */

export interface EmbyMediaCard {
  id: string;
  name: string;
  type: string;
  year: number | null;
  /** 社区评分（0~10），没有就 null */
  rating: number | null;
  officialRating: string | null;
  /** 时长（分钟） */
  runtimeMinutes: number | null;
  imageTag: string | null;
  played: boolean;
  /** 已看进度（秒），0 表示没看过 */
  positionSeconds: number;
  overview: string | null;
  seriesName: string | null;
  season: number | null;
  episode: number | null;
  /** 容器格式（mp4 / mkv / …） */
  container: string | null;
  /** 视频高度，用来显示 1080P 这类 */
  height: number | null;
}

interface RawItem {
  Id: string;
  Name: string;
  Type?: string;
  ProductionYear?: number;
  CommunityRating?: number;
  OfficialRating?: string;
  RunTimeTicks?: number;
  ImageTags?: Record<string, string>;
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number };
  Overview?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  MediaSources?: Array<{
    Container?: string;
    MediaStreams?: Array<{ Type?: string; Height?: number }>;
  }>;
}

function ticksToMinutes(ticks: number | undefined): number | null {
  if (!ticks || ticks <= 0) return null;
  return Math.round(ticks / 10_000_000 / 60);
}

/** Emby 的 item → 界面卡片。纯映射，便于自检 */
export function toCard(item: RawItem): EmbyMediaCard {
  const source = item.MediaSources?.[0];
  const videoStream = source?.MediaStreams?.find((s) => s.Type === "Video");
  const position = item.UserData?.PlaybackPositionTicks ?? 0;
  return {
    id: item.Id,
    name: item.Name,
    type: item.Type ?? "Video",
    year: item.ProductionYear ?? null,
    rating: typeof item.CommunityRating === "number" ? Math.round(item.CommunityRating * 10) / 10 : null,
    officialRating: item.OfficialRating ?? null,
    runtimeMinutes: ticksToMinutes(item.RunTimeTicks),
    imageTag: item.ImageTags?.Primary ?? null,
    played: Boolean(item.UserData?.Played),
    positionSeconds: position > 0 ? Math.round(position / 10_000_000) : 0,
    overview: item.Overview || null,
    seriesName: item.SeriesName || null,
    season: typeof item.ParentIndexNumber === "number" ? item.ParentIndexNumber : null,
    episode: typeof item.IndexNumber === "number" ? item.IndexNumber : null,
    container: source?.Container ?? null,
    height: videoStream?.Height ?? null,
  };
}

const CARD_FIELDS = [
  "ProductionYear",
  "CommunityRating",
  "OfficialRating",
  "RunTimeTicks",
  "Overview",
  "MediaSources",
  "SeriesName",
  "ParentIndexNumber",
  "IndexNumber",
  "UserData",
  "DateCreated",
].join(",");

export interface QueryItemsInput {
  /** 空表示全部库 */
  libraryId?: string;
  search?: string;
  start?: number;
  limit?: number;
  /** 进来的是库还是某个剧集（剧集要看分集） */
  parentId?: string;
  /** 默认电影 + 剧集；看分集时传 Episode */
  types?: string;
  sortBy?: string;
  sortOrder?: "Ascending" | "Descending";
}

export interface QueryItemsResult {
  items: EmbyMediaCard[];
  total: number;
  start: number;
}

export async function queryItems(
  config: EmbyServerConfig,
  input: QueryItemsInput = {},
): Promise<QueryItemsResult> {
  const userId = await resolveUserId(config);
  const start = Math.max(0, Math.round(input.start ?? 0));
  const limit = Math.min(200, Math.max(1, Math.round(input.limit ?? 60)));
  const params = new URLSearchParams({
    Recursive: "true",
    IncludeItemTypes: input.types || "Movie,Series,Video,MusicVideo",
    Fields: CARD_FIELDS,
    SortBy: input.sortBy || "SortName",
    SortOrder: input.sortOrder || "Ascending",
    ImageTypeLimit: "1",
    EnableImageTypes: "Primary",
    StartIndex: String(start),
    Limit: String(limit),
    // 传了搜索词就别再按库过滤，用户找片时不希望被库边界挡住
    EnableTotalRecordCount: "true",
  });
  if (input.libraryId) params.set("ParentId", input.libraryId);
  if (input.parentId) params.set("ParentId", input.parentId);
  if (input.search?.trim()) params.set("SearchTerm", input.search.trim());
  // 分集要按季 / 集号排，否则 E02 会跑到 E10 后面
  if (input.types?.includes("Episode")) params.set("SortBy", input.sortBy || "ParentIndexNumber,IndexNumber");

  const data = await apiGet<{ Items?: RawItem[]; TotalRecordCount?: number }>(
    config,
    `/Users/${userId}/Items?${params.toString()}`,
  );
  const items = (data.Items ?? []).map(toCard);
  return { items, total: data.TotalRecordCount ?? items.length, start };
}

/** 单条详情（海报墙点开用），比列表多查一次拿最新的已看进度 */
export async function getItem(config: EmbyServerConfig, id: string): Promise<EmbyMediaCard | null> {
  const userId = await resolveUserId(config);
  const item = await apiGet<RawItem>(config, `/Users/${userId}/Items/${encodeURIComponent(id)}`);
  if (!item?.Id) return null;
  return toCard(item);
}

/* ------------------------------ 播放 ------------------------------ */

export interface PlaybackSource {
  itemId: string;
  mediaSourceId: string | null;
  container: string | null;
  /** 给前端拼 /api/emby/stream/:id */
  url: string;
}

/**
 * 取可直接播放的媒体源。
 *
 * 用 PlaybackInfo 而不是猜路径：Emby 会告诉我们这一条有几个版本、
 * MediaSourceId 是哪个。拿不到就退化成「默认源」，stream 接口仍然能用。
 */
export async function getPlaybackSource(config: EmbyServerConfig, itemId: string): Promise<PlaybackSource> {
  const userId = await resolveUserId(config);
  let mediaSourceId: string | null = null;
  let container: string | null = null;
  try {
    const info = await apiGet<{
      MediaSources?: Array<{ Id?: string; Container?: string; SupportsDirectPlay?: boolean }>;
    }>(config, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo?UserId=${userId}`);
    const source = info.MediaSources?.find((s) => s.SupportsDirectPlay !== false) ?? info.MediaSources?.[0];
    mediaSourceId = source?.Id ?? null;
    container = source?.Container ?? null;
  } catch (err) {
    // PlaybackInfo 在某些老版本 / 受限 Key 上要 POST，失败也不影响直连播放
    logger.debug({ err, itemId }, "取 PlaybackInfo 失败，回退到默认媒体源");
  }
  const query = mediaSourceId ? `?source=${encodeURIComponent(mediaSourceId)}` : "";
  return { itemId, mediaSourceId, container, url: `/api/emby/stream/${encodeURIComponent(itemId)}${query}` };
}

/** 视频流代理：透传 Range / Content-Range，播放器才能 seek */
export async function pipeVideoStream(
  config: EmbyServerConfig,
  itemId: string,
  mediaSourceId: string | null,
  range: string | undefined,
  res: Response,
): Promise<void> {
  const params = new URLSearchParams({ Static: "true" });
  if (mediaSourceId) params.set("MediaSourceId", mediaSourceId);
  const headers: Record<string, string> = { ...authHeaders(config) };
  if (range) headers.Range = range;

  const upstream = await fetch(
    `${config.baseUrl}/Videos/${encodeURIComponent(itemId)}/stream?${params.toString()}`,
    { headers },
  );

  if (!upstream.ok && upstream.status !== 206) {
    const snippet = await upstream
      .text()
      .then((text) => text.replace(/\s+/g, " ").slice(0, 200))
      .catch(() => "");
    logger.warn({ itemId, status: upstream.status, snippet }, "Emby 视频流请求失败");
    res.status(502).json({
      ok: false,
      error:
        upstream.status === 401 || upstream.status === 403
          ? "Emby 拒绝了播放请求，请检查 API Key"
          : `Emby 无法提供该视频流（HTTP ${upstream.status}）${snippet ? `：${snippet}` : ""}`,
    });
    return;
  }

  res.status(upstream.status);
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!upstream.headers.get("accept-ranges")) res.setHeader("accept-ranges", "bytes");
  if (!upstream.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
  // 客户端拖进度条 / 关页面时上游要跟着断，否则 ffmpeg 转码会一直挂着
  res.on("close", () => nodeStream.destroy());
  nodeStream.on("error", (err) => {
    logger.debug({ err, itemId }, "视频流传输中断");
    res.destroy();
  });
  nodeStream.pipe(res);
}

/* ------------------------------ 图片 ------------------------------ */

interface CachedImage {
  body: Buffer;
  contentType: string;
  at: number;
}

const imageCache = new Map<string, CachedImage>();
const IMAGE_CACHE_MAX = 160;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_TTL_MS = 30 * 60 * 1000;

/** 海报代理：带缓存，避免滚动列表时每张图都去敲 Emby */
export async function fetchItemImage(
  config: EmbyServerConfig,
  itemId: string,
  options: { type?: string; tag?: string | null; maxWidth?: number } = {},
): Promise<{ body: Buffer; contentType: string } | null> {
  const type = options.type || "Primary";
  const maxWidth = Math.min(1200, Math.max(80, Math.round(options.maxWidth ?? 360)));
  const key = `${config.baseUrl}|${itemId}|${type}|${options.tag ?? ""}|${maxWidth}`;
  const hit = imageCache.get(key);
  if (hit && Date.now() - hit.at < IMAGE_TTL_MS) return { body: hit.body, contentType: hit.contentType };

  const params = new URLSearchParams({ maxWidth: String(maxWidth), quality: "90" });
  if (options.tag) params.set("tag", options.tag);
  const res = await fetch(
    `${config.baseUrl}/Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(type)}?${params.toString()}`,
    { headers: authHeaders(config) },
  );
  if (!res.ok) {
    if (res.status !== 404) logger.debug({ itemId, type, status: res.status }, "Emby 图片获取失败");
    return null;
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > IMAGE_MAX_BYTES) return { body: buffer, contentType };

  // 简单 FIFO 淘汰：够用，且不会让内存随库大小无限长
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest) imageCache.delete(oldest);
  }
  imageCache.set(key, { body: buffer, contentType, at: Date.now() });
  return { body: buffer, contentType };
}

/** 设置变更（换地址 / 换 Key）后清掉用户与图片缓存 */
export function resetEmbyViewCache(): void {
  cachedUser = null;
  imageCache.clear();
}
