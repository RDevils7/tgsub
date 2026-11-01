import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { db, getSettings } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { Download } from "../types";
import { sanitizeSegment } from "../utils";
import { decodeMeta, encodeMeta, EmbyMeta } from "../tg/emby";
import { queueEmbyUpdate } from "../tg/embyapi";
import { listCovers } from "../tg/covers";
import { autoCoversFromVideo } from "../tg/autocover";
import {
  captureCandidates,
  captureFrame,
  captureStill,
  ffmpegInfo,
  normalizeCrop,
  probeVideo,
  type CropRect,
  type FitMode,
} from "../tg/ffmpeg";
import { loadSharp } from "../tg/sharp";
import {
  addSource,
  collectFolders,
  deriveEpisodeInfo,
  findDownloadByPath,
  isAllowedPath,
  isVideoFile,
  listSources,
  removeSource,
  type MediaFileEntry,
} from "../tg/mediatree";
import {
  applyFields,
  buildNfo,
  fieldsFromNfo,
  parseNfo,
  readText,
  validateNfo,
  writeTextAtomic,
  type NfoFields,
} from "../tg/nfo";
import { asyncHandler, assert, clampInt, HttpError } from "../lib/http";

/**
 * 元数据管理。
 *
 * 以「路径」而不是数据库 ID 作为定位方式：
 *  - 项目下载的文件：路径来自 downloads.file_path
 *  - 手动选中的文件/目录：路径来自 media_sources 表
 * 两者共用同一套编辑逻辑（改 NFO、换封面、ffmpeg 截帧）。
 *
 * 层级：
 *  - 文件夹 = 一条记录，首级显示剧集信息（tvshow.nfo + 剧集封面）
 *  - 文件   = 子级记录，显示单集信息（单集 nfo + 单集封面）
 */

export const metadataRouter = Router();

const stmtGet = db.prepare<[number], Download>("SELECT * FROM downloads WHERE id = ?");
const stmtUpdateMeta = db.prepare<[string, number]>("UPDATE downloads SET emby_json = ? WHERE id = ?");

const framesRoot = path.join(env.dataDir, "frames");
const coversRoot = path.join(env.dataDir, "covers");

/* ------------------------------ 路径编码 ------------------------------ */

/** 绝对路径 → URL 安全的短标识（base64url），避免路径里的分隔符与中文进 URL */
export function encodePath(target: string): string {
  return Buffer.from(path.resolve(target), "utf8").toString("base64url");
}

export function decodePath(key: string): string {
  try {
    const decoded = Buffer.from(key, "base64url").toString("utf8");
    if (!decoded) throw new Error("empty");
    return decoded;
  } catch {
    throw new HttpError(400, "无效的路径标识", "BAD_PATH_KEY");
  }
}

/* ------------------------------ 目标解析 ------------------------------ */

interface Target {
  kind: "file" | "folder";
  /** 目标绝对路径 */
  path: string;
  /** 所在目录 */
  dir: string;
  /** 文件名（不含扩展名），仅 file 目标有 */
  base: string | null;
  /** 视频绝对路径，仅 file 目标有 */
  video: string | null;
  /** 关联的下载记录（手动选择的文件没有） */
  download: Download | null;
}

function resolveTarget(key: string): Target {
  const abs = decodePath(key);
  const resolved = path.resolve(abs);
  assert(isAllowedPath(resolved), 403, "该路径不在允许操作的范围内");
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  assert(stat, 404, "文件或目录不存在");

  if (stat.isDirectory()) {
    return {
      kind: "folder",
      path: resolved,
      dir: resolved,
      base: null,
      video: null,
      download: null,
    };
  }
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  return {
    kind: "file",
    path: resolved,
    dir,
    base,
    video: resolved,
    download: findDownloadByPath(resolved) ?? null,
  };
}

/* ------------------------------ 图片规格 ------------------------------ */

type ImageName = "poster" | "landscape" | "fanart" | "thumb" | "banner";
type ImageScope = "series" | "episode";

const IMAGE_SPECS: Record<ImageName, { width: number; height: number; label: string; hint: string }> = {
  poster: { width: 1000, height: 1500, label: "海报 poster", hint: "竖版 2:3，Emby 列表页主图" },
  landscape: { width: 1920, height: 1080, label: "横版 landscape", hint: "16:9，剧集页顶部横幅" },
  fanart: { width: 1920, height: 1080, label: "背景 fanart", hint: "16:9，详情页背景" },
  thumb: { width: 1280, height: 720, label: "缩略图 thumb", hint: "16:9，播放列表缩略" },
  banner: { width: 1000, height: 185, label: "横幅 banner", hint: "窄长条 1000×185" },
};

const IMAGE_NAMES = Object.keys(IMAGE_SPECS) as ImageName[];

/** 缩放方式：默认留黑边（比例不对时保住整张图），其次裁剪铺满 / 拉伸变形 */
const DEFAULT_FIT: FitMode = "contain";

function normalizeFit(value: unknown, fallback: FitMode = DEFAULT_FIT): FitMode {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "cover" || text === "contain" || text === "stretch" ? (text as FitMode) : fallback;
}

/** 裁剪框：上传接口用 query 传 "x,y,w,h"，其它接口用 JSON 对象 */
function parseCropParam(value: unknown): CropRect | null {
  if (typeof value === "string" && value.trim()) {
    const parts = value.split(",").map((v) => Number(v.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return normalizeCrop({ x: parts[0], y: parts[1], width: parts[2], height: parts[3] });
  }
  return normalizeCrop(value);
}

function isImageName(value: unknown): value is ImageName {
  return typeof value === "string" && (IMAGE_NAMES as string[]).includes(value);
}

function normalizeScope(value: unknown): ImageScope {
  return value === "episode" ? "episode" : "series";
}

/** 封面落盘路径：剧集封面放目录里，单集封面带文件名前缀 */
function imagePath(target: Target, scope: ImageScope, name: ImageName): string {
  if (scope === "episode") {
    const base = sanitizeSegment(target.base ?? path.basename(target.dir), 120);
    return path.join(target.dir, `${base}-${name}.jpg`);
  }
  return path.join(target.dir, `${name}.jpg`);
}

const IMAGE_FILE_RE = /^[\w\-. ()（）[\]]+\.(jpe?g|png|webp)$/i;

async function listImageFiles(dir: string): Promise<string[]> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => !n.startsWith(".") && IMAGE_FILE_RE.test(n))
    .filter((n) => /\.(jpe?g|png|webp)$/i.test(n))
    .sort();
}

async function imageSize(file: string): Promise<{ width: number | null; height: number | null }> {
  const sharp = await loadSharp();
  if (!sharp) return { width: null, height: null };
  try {
    const meta = await sharp(file).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

async function statFile(file: string) {
  const st = await fs.promises.stat(file).catch(() => null);
  return st && st.isFile() ? { size: st.size, updatedAt: Math.round(st.mtimeMs) } : null;
}

/**
 * 写一张封面图：先按框选范围裁（如果框了），再缩放到规格尺寸。
 * 没框选时按 fit 处理（默认留黑边），保证比例不符也不丢画面。
 */
async function renderImage(
  input: string | Buffer,
  dest: string,
  spec: { width: number; height: number },
  fit: FitMode,
  crop?: CropRect | null,
): Promise<void> {
  const sharp = await loadSharp();
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  if (!sharp) {
    if (Buffer.isBuffer(input)) await fs.promises.writeFile(dest, input);
    else await fs.promises.copyFile(input, dest);
    return;
  }

  let image = sharp(input);
  if (crop) {
    const meta = await image.metadata().catch(() => ({ width: 0, height: 0 }));
    const raw = meta.width ?? 0;
    const rawHeight = meta.height ?? 0;
    if (raw > 0 && rawHeight > 0) {
      const left = Math.min(raw - 1, Math.max(0, Math.round(crop.x * raw)));
      const top = Math.min(rawHeight - 1, Math.max(0, Math.round(crop.y * rawHeight)));
      const width = Math.max(1, Math.min(raw - left, Math.round(crop.width * raw)));
      const height = Math.max(1, Math.min(rawHeight - top, Math.round(crop.height * rawHeight)));
      image = image.extract({ left, top, width, height });
    }
  }

  const fitMode = crop ? "cover" : fit === "stretch" ? "fill" : fit;
  await image
    .resize({ width: spec.width, height: spec.height, fit: fitMode, position: "attention", background: "#000000" })
    .jpeg({ quality: 92 })
    .toFile(dest);
}

/* ------------------------------ 路径与 NFO ------------------------------ */

function nfoPaths(target: Target): { episode: string | null; show: string } {
  const base = target.base ? sanitizeSegment(target.base, 120) : null;
  return {
    episode: base ? path.join(target.dir, `${base}.nfo`) : null,
    show: path.join(target.dir, "tvshow.nfo"),
  };
}

function parseDate(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const ts = Date.parse(text.length <= 10 ? `${text}T00:00:00` : text);
  return Number.isFinite(ts) ? ts : null;
}

function isoDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 表单值回写到 downloads.emby_json，保证以后重新生成 NFO 时与手改一致 */
function syncEmbyJson(row: Download, fields: NfoFields): EmbyMeta {
  const old = decodeMeta(row.emby_json);
  const series =
    (fields.showtitle || fields.originaltitle || fields.title || old?.series || row.save_dir || "未命名").trim();
  const season = Number(fields.season) || old?.season || 1;
  const episode = fields.episode.trim() ? Number(fields.episode) : (old?.episode ?? null);
  const airedAt = parseDate(fields.premiered || fields.aired) ?? old?.airedAt ?? row.finished_at ?? Date.now();
  const meta: EmbyMeta = {
    series,
    season: Number.isFinite(season) && season > 0 ? Math.round(season) : 1,
    episode: Number.isFinite(episode as number) ? (episode as number) : null,
    firstLine: old?.firstLine ?? "",
    plot: fields.plot,
    tags: fields.tags.length ? fields.tags : (old?.tags ?? []),
    studio: fields.studio || old?.studio || null,
    link: old?.link ?? null,
    airedAt,
    messageId: row.message_id,
    kind: "video",
  };
  stmtUpdateMeta.run(encodeMeta(meta), row.id);
  return meta;
}

function fieldsFromEmby(row: Download): NfoFields {
  const meta = decodeMeta(row.emby_json);
  if (!meta) return fieldsFromNfo(null);
  const tag = meta.episode !== null ? `S${String(meta.season || 1).padStart(2, "0")}E${String(meta.episode).padStart(2, "0")}` : "";
  return {
    title: meta.episode !== null ? `${meta.series} ${tag}` : meta.series,
    originaltitle: meta.series,
    showtitle: meta.series,
    season: meta.episode !== null ? String(meta.season || 1) : "",
    episode: meta.episode !== null ? String(meta.episode) : "",
    year: String(new Date(meta.airedAt || Date.now()).getFullYear()),
    aired: isoDate(meta.airedAt || Date.now()),
    premiered: isoDate(meta.airedAt || Date.now()),
    plot: meta.plot,
    outline: meta.plot.replace(/\s+/g, " ").slice(0, 200),
    studio: meta.studio ?? "",
    rating: "",
    tags: meta.tags ?? [],
    genres: [],
  };
}

/** 手动选择的文件没有下载记录，剧集信息从文件名 / 目录名推导 */
function fieldsFromFile(target: Target): NfoFields {
  const row = target.download;
  if (row) {
    const meta = decodeMeta(row.emby_json);
    if (meta) return fieldsFromEmby(row);
  }
  const dirName = path.basename(target.dir);
  const info = deriveEpisodeInfo(path.basename(target.path), dirName);
  const tag =
    info.season !== null && info.episode !== null
      ? `S${String(info.season).padStart(2, "0")}E${String(info.episode).padStart(2, "0")}`
      : info.episode !== null
        ? `E${String(info.episode).padStart(2, "0")}`
        : "";
  return {
    title: info.episode !== null ? `${info.series} ${tag}`.trim() : info.series,
    originaltitle: info.series,
    showtitle: info.series,
    season: info.season !== null ? String(info.season) : "",
    episode: info.episode !== null ? String(info.episode) : "",
    year: String(new Date().getFullYear()),
    aired: isoDate(Date.now()),
    premiered: isoDate(Date.now()),
    plot: "",
    outline: "",
    studio: row?.channel_title ?? "",
    rating: "",
    tags: [],
    genres: [],
  };
}

const MAX_TEXT = 8000;

function cleanFields(input: unknown, fallback: NfoFields): NfoFields {
  const body = (input ?? {}) as Record<string, unknown>;
  const str = (key: keyof NfoFields, max = 200): string => {
    const raw = body[key as string];
    if (typeof raw !== "string") return String(fallback[key] ?? "");
    return raw.trim().slice(0, max);
  };
  const list = (key: "tags" | "genres"): string[] => {
    const raw = body[key];
    if (Array.isArray(raw)) {
      return raw
        .map((v) => String(v).trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 30);
    }
    if (typeof raw === "string") {
      return raw
        .split(/[,，;；\n]/)
        .map((v) => v.trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 30);
    }
    return fallback[key];
  };

  return {
    title: str("title"),
    originaltitle: str("originaltitle"),
    showtitle: str("showtitle"),
    season: str("season", 6).replace(/[^\d]/g, ""),
    episode: str("episode", 8).replace(/[^\d]/g, ""),
    year: str("year", 6).replace(/[^\d]/g, ""),
    aired: str("aired", 32),
    premiered: str("premiered", 32),
    plot: str("plot", MAX_TEXT),
    outline: str("outline", 400),
    studio: str("studio", 120),
    rating: str("rating", 8),
    tags: list("tags"),
    genres: list("genres"),
  };
}

/* ------------------------------ 列表 ------------------------------ */

metadataRouter.get(
  "/items",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const limit = clampInt(req.query.limit, 1, 500, 30);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

    const folders = collectFolders();
    const filtered = q
      ? folders.filter(
          (folder) =>
            folder.name.toLowerCase().includes(q.toLowerCase()) ||
            folder.files.some((file) => file.name.toLowerCase().includes(q.toLowerCase())),
        )
      : folders;
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    const dirCache = new Map<string, string[]>();
    const readDir = async (dir: string) => {
      if (!dirCache.has(dir)) dirCache.set(dir, await fs.promises.readdir(dir).catch(() => [] as string[]));
      return dirCache.get(dir) as string[];
    };

    const items = await Promise.all(
      page.map(async (folder) => {
        const names = await readDir(folder.dir);
        const showNfo = names.includes("tvshow.nfo");
        const poster = names.includes("poster.jpg") || names.includes("poster.png");
        const imageCount = names.filter((n) => IMAGE_FILE_RE.test(n) && !n.startsWith(".")).length;
        return {
          key: encodePath(folder.dir),
          dir: folder.dir,
          name: folder.name,
          fileCount: folder.fileCount,
          totalSize: folder.totalSize,
          source: folder.source,
          /** 贡献该文件夹的手动来源（删除按钮据此回溯移除来源） */
          sourceIds: folder.sourceIds,
          sourcePaths: folder.sourcePaths,
          nfoExists: showNfo,
          posterExists: poster,
          imageCount,
          posterUrl: poster ? `/api/metadata/image?key=${encodePath(folder.dir)}&scope=series&name=poster` : null,
          files: folder.files.map((file) => ({
            key: encodePath(file.path),
            path: file.path,
            name: file.name,
            size: file.size,
            series: file.series,
            season: file.season,
            episode: file.episode,
            title:
              file.episode !== null
                ? `${file.series} ${file.season !== null ? `S${String(file.season).padStart(2, "0")}` : ""}E${String(file.episode).padStart(2, "0")}`
                : file.series,
            nfoExists: names.includes(`${sanitizeSegment(file.base, 120)}.nfo`),
            source: file.source,
            downloadId: file.downloadId,
            channelTitle: file.channelTitle,
          })),
        };
      }),
    );

    res.json({ items, total, limit, offset });
  }),
);

/* ------------------------------ 手动来源 ------------------------------ */

metadataRouter.get(
  "/sources",
  asyncHandler(async (_req, res) => {
    // 一个上级目录会按剧集文件夹拆成多条，展开数量告诉用户他将看到什么
    const folders = collectFolders();
    const items = listSources().map((source) => {
      const matched = folders.filter((f) => f.sourceIds.includes(source.id));
      return {
        id: source.id,
        path: source.path,
        kind: source.kind,
        title: source.title,
        created_at: source.created_at,
        key: encodePath(source.path),
        /** 这个来源展开成几个剧集文件夹 */
        folderCount: matched.length,
        /** 展开后的剧集文件夹名 */
        folderNames: matched.map((f) => f.name),
        /** 覆盖的视频数 */
        fileCount: matched.reduce((sum, f) => sum + f.fileCount, 0),
      };
    });
    res.json({ items });
  }),
);

/** 添加手动来源：一个视频文件，或一个视频目录 */
metadataRouter.post(
  "/sources",
  asyncHandler(async (req, res) => {
    const raw = String(req.body?.path ?? "").trim();
    assert(raw, 400, "请填写文件或目录路径");
    const abs = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      assert(false, 404, "路径不存在");
    }
    let kind: "dir" | "file";
    if (stat.isDirectory()) kind = "dir";
    else {
      assert(isVideoFile(abs), 400, "只支持添加视频文件或视频目录");
      kind = "file";
    }
    const title = String(req.body?.title ?? "").trim() || path.basename(abs);
    const row = addSource(abs, kind, title);
    logger.info({ path: abs, kind }, "已添加手动媒体来源");
    res.json({ ok: true, source: { id: row.id, path: row.path, kind: row.kind, title: row.title } });
  }),
);

metadataRouter.delete(
  "/sources/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    assert(Number.isInteger(id) && id > 0, 400, "无效的 ID");
    const removed = removeSource(id);
    assert(removed, 404, "来源不存在");
    res.json({ ok: true });
  }),
);

/** 服务端目录浏览：给「手动添加」对话框挑文件 / 目录用 */
metadataRouter.get(
  "/browse",
  asyncHandler(async (req, res) => {
    const raw = String(req.query.path ?? "").trim();
    const dir = raw ? path.resolve(raw) : path.resolve(env.downloadDir);
    assert(fs.existsSync(dir), 404, "目录不存在");
    const stat = await fs.promises.stat(dir);
    assert(stat.isDirectory(), 400, "不是一个目录");

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const dirs: Array<{ name: string; path: string }> = [];
    const files: Array<{ name: string; path: string; size: number }> = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: full });
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        const st = await fs.promises.stat(full).catch(() => null);
        files.push({ name: entry.name, path: full, size: st?.size ?? 0 });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    const parent = path.dirname(dir);
    res.json({
      path: dir,
      parent: parent === dir ? null : parent,
      dirs: dirs.slice(0, 500),
      files: files.slice(0, 500),
      home: path.resolve(env.downloadDir),
    });
  }),
);

/* ------------------------------ 详情 ------------------------------ */

metadataRouter.get(
  "/detail",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    const ffmpeg = await ffmpegInfo();
    const paths = nfoPaths(target);

    const showRaw = await readText(paths.show);
    const episodeRaw = paths.episode ? await readText(paths.episode) : null;
    const showParsed = showRaw ? parseNfo(showRaw) : null;
    const episodeParsed = episodeRaw ? parseNfo(episodeRaw) : null;

    const showFields = showRaw ? fieldsFromNfo(showParsed) : fieldsFromNfo(null);
    const episodeFields = episodeRaw
      ? fieldsFromNfo(episodeParsed)
      : target.kind === "file"
        ? fieldsFromFile(target)
        : fieldsFromNfo(null);
    // 剧集级字段兜底：没有 tvshow.nfo 时，用首个文件的推导信息填充
    if (!showRaw && target.kind === "folder") {
      const first = collectFolders().find((f) => f.dir === target.dir)?.files[0];
      if (first) {
        const derived = fieldsFromFile({
          kind: "file",
          path: first.path,
          dir: first.dir,
          base: first.base,
          video: first.path,
          download: null,
        });
        showFields.title = derived.showtitle || derived.originaltitle || first.series;
        showFields.originaltitle = derived.originaltitle || first.series;
        showFields.showtitle = derived.showtitle || first.series;
      }
    }

    const images: Array<Record<string, unknown>> = [];
    const scopes: ImageScope[] = target.kind === "folder" ? ["series"] : ["series", "episode"];
    for (const scope of scopes) {
      for (const name of IMAGE_NAMES) {
        const file = imagePath(target, scope, name);
        const st = await statFile(file);
        if (!st) continue;
        const size = await imageSize(file);
        images.push({
          scope,
          name,
          label: IMAGE_SPECS[name].label,
          file: path.basename(file),
          size: st.size,
          updatedAt: st.updatedAt,
          width: size.width,
          height: size.height,
          url: `/api/metadata/image?key=${encodePath(target.path)}&scope=${scope}&name=${name}&v=${st.updatedAt}`,
        });
      }
    }

    const known = new Set(images.map((img) => img.file as string));
    const allFiles = await listImageFiles(target.dir);
    const extras = allFiles
      .filter((n) => !known.has(n))
      .map((n) => ({
        file: n,
        url: `/api/metadata/extras?key=${encodePath(target.path)}&file=${encodeURIComponent(n)}`,
      }));

    const videoStat = target.video ? await statFile(target.video) : null;
    const probe = videoStat ? await probeVideo(target.video as string) : null;

    const covers =
      target.download ? await listCovers(target.download.channel_id, target.download.message_id).catch(() => []) : [];

    res.json({
      target: {
        kind: target.kind,
        key: encodePath(target.path),
        path: target.path,
        dir: target.dir,
        base: target.base,
        name: path.basename(target.path),
        dirName: path.basename(target.dir),
      },
      paths: {
        dir: target.dir,
        video: target.video,
        base: target.base,
        dirName: path.basename(target.dir),
      },
      video: videoStat ? { exists: true, size: videoStat.size, probe } : { exists: false, size: 0, probe: null },
      nfo: {
        episode: paths.episode
          ? {
              exists: Boolean(episodeRaw),
              file: path.basename(paths.episode),
              path: paths.episode,
              size: episodeRaw ? Buffer.byteLength(episodeRaw) : 0,
              nested: Boolean(episodeParsed?.children.some((c) => c.nested)),
              editable: !episodeRaw || !episodeParsed?.children.some((c) => c.nested),
            }
          : null,
        show: {
          exists: Boolean(showRaw),
          file: path.basename(paths.show),
          path: paths.show,
          size: showRaw ? Buffer.byteLength(showRaw) : 0,
          nested: Boolean(showParsed?.children.some((c) => c.nested)),
          editable: !showRaw || !showParsed?.children.some((c) => c.nested),
        },
      },
      images,
      extras,
      fields: { episode: episodeFields, show: showFields },
      meta: target.download ? decodeMeta(target.download.emby_json) : null,
      ffmpeg,
      covers,
      download: target.download
        ? {
            id: target.download.id,
            channel_title: target.download.channel_title,
            message_id: target.download.message_id,
            file_size: target.download.file_size,
            finished_at: target.download.finished_at,
          }
        : null,
    });
  }),
);

/* ------------------------------ 保存字段 ------------------------------ */

metadataRouter.put(
  "/meta",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    const kind = req.body?.kind === "show" ? "show" : "episode";
    if (kind === "episode") assert(target.kind === "file", 400, "单集元数据需要选择具体的视频文件");

    const file = kind === "show" ? nfoPaths(target).show : nfoPaths(target).episode;
    assert(file, 400, "无效的 NFO 路径");
    const currentRaw = await readText(file);
    const currentParsed = currentRaw ? parseNfo(currentRaw) : null;
    const base = currentRaw
      ? fieldsFromNfo(currentParsed)
      : kind === "show"
        ? fieldsFromNfo(null)
        : fieldsFromFile(target);
    const fields = cleanFields(req.body?.fields, base);
    assert(fields.showtitle || fields.title, 400, "剧名/标题不能为空");

    const next = currentRaw && currentParsed ? applyFields(currentParsed, fields) : buildNfo(kind, fields);
    const problem = validateNfo(next, kind);
    assert(!problem, 500, `生成的 NFO 不合法：${problem}`);

    await writeTextAtomic(file, next);
    const meta = kind === "episode" && target.download ? syncEmbyJson(target.download, fields) : null;

    logger.info({ path: target.path, kind }, "已保存元数据");
    res.json({ ok: true, nfo: next, fields, meta });
  }),
);

/* ------------------------------ NFO 原文 ------------------------------ */

metadataRouter.get(
  "/nfo",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    const kind = req.query.kind === "show" ? "show" : "episode";
    const file = kind === "show" ? nfoPaths(target).show : nfoPaths(target).episode;
    assert(file, 400, "无效的 NFO 路径");
    const raw = await readText(file);
    res.json({
      exists: raw !== null,
      file: path.basename(file),
      content: raw ?? buildNfo(kind, kind === "show" ? fieldsFromNfo(null) : fieldsFromFile(target)),
    });
  }),
);

metadataRouter.put(
  "/nfo",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    const kind = req.body?.kind === "show" ? "show" : "episode";
    if (kind === "episode") assert(target.kind === "file", 400, "单集 NFO 需要选择具体的视频文件");
    const file = kind === "show" ? nfoPaths(target).show : nfoPaths(target).episode;
    assert(file, 400, "无效的 NFO 路径");
    const content = String(req.body?.content ?? "");

    const problem = validateNfo(content, kind);
    assert(!problem, 400, problem ?? "内容不合法");

    await writeTextAtomic(file, content.endsWith("\n") ? content : `${content}\n`);

    if (kind === "episode" && target.download) {
      const parsed = parseNfo(content);
      if (parsed) syncEmbyJson(target.download, fieldsFromNfo(parsed));
    }

    logger.info({ path: target.path, kind }, "已保存 NFO 原文");
    res.json({ ok: true });
  }),
);

/* ------------------------------ 一键生成 ------------------------------ */

/**
 * 一键为选中的文件 / 目录生成元数据：
 *  - 每个视频写一份单集 NFO（剧名、季、集从文件名解析）
 *  - 目录里补一份 tvshow.nfo
 *  - 没有封面时用 ffmpeg 随机截帧生成横版/竖版封面
 */
metadataRouter.post(
  "/generate",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);

    const files: MediaFileEntry[] =
      target.kind === "file"
        ? [
            {
              path: target.path,
              name: path.basename(target.path),
              dir: target.dir,
              base: target.base ?? path.basename(target.path, path.extname(target.path)),
              size: 0,
              series: "",
              season: null,
              episode: null,
              downloadId: target.download?.id ?? null,
              channelTitle: target.download?.channel_title ?? null,
              messageId: target.download?.message_id ?? null,
              source: target.download ? "download" : "manual",
            },
          ]
        : collectFolders()
            .find((f) => f.dir === target.dir)
            ?.files ?? [];

    assert(files.length > 0, 404, "这个目录里没有找到视频文件");

    const dirName = path.basename(target.dir);
    let nfoCount = 0;
    let coverCount = 0;

    for (const file of files) {
      // 项目下载的文件才有下载记录，手动添加的文件没有
      const row = file.downloadId ? stmtGet.get(file.downloadId) : undefined;
      const info = deriveEpisodeInfo(file.name, dirName);
      const fields = fieldsFromFile({
        kind: "file",
        path: file.path,
        dir: file.dir,
        base: file.base,
        video: file.path,
        download: row ?? null,
      });
      fields.showtitle = info.series;
      fields.originaltitle = info.series;
      fields.title =
        info.episode !== null
          ? `${info.series} ${info.season !== null ? `S${String(info.season).padStart(2, "0")}` : ""}E${String(info.episode).padStart(2, "0")}`.trim()
          : info.series;
      fields.season = info.season !== null ? String(info.season) : "";
      fields.episode = info.episode !== null ? String(info.episode) : "";
      if (!fields.plot) fields.plot = fields.outline = "";

      const nfoFile = path.join(file.dir, `${sanitizeSegment(file.base, 120)}.nfo`);
      const existing = await readText(nfoFile);
      const parsed = existing ? parseNfo(existing) : null;
      const next = parsed ? applyFields(parsed, fields) : buildNfo("episode", fields);
      const problem = validateNfo(next, "episode");
      if (!problem) {
        await writeTextAtomic(nfoFile, next);
        nfoCount += 1;
      }

      if (row) syncEmbyJson(row, fields);

      // 每集都要有缩略图；剧集目录的三张封面以第一集为准，
      // 第一集还没下（或封面缺失）时先用当前集顶上，之后第一集下载完成会覆盖
      const poster = path.join(file.dir, "poster.jpg");
      const made = await autoCoversFromVideo(file.path, file.dir, {
        base: file.base,
        isFirst: info.episode === 1 || !fs.existsSync(poster),
      });
      coverCount += made.length;
    }

    // 剧集信息（tvshow.nfo）：没有就按目录名生成一份
    const showFile = path.join(target.dir, "tvshow.nfo");
    if (!fs.existsSync(showFile)) {
      const first = files[0];
      const info = deriveEpisodeInfo(first.name, dirName);
      const fields = {
        ...fieldsFromNfo(null),
        title: info.series,
        originaltitle: info.series,
        showtitle: info.series,
        year: String(new Date().getFullYear()),
        premiered: isoDate(Date.now()),
      };
      const next = buildNfo("show", fields);
      if (!validateNfo(next, "show")) await writeTextAtomic(showFile, next);
    }

    logger.info({ path: target.path, nfoCount, coverCount }, "已生成元数据");
    // 刚重写了 nfo 与封面，让 Emby 重新认一遍这个剧集目录
    queueEmbyUpdate(target.dir, "Modified", false);
    res.json({ ok: true, nfoCount, coverCount, files: files.length });
  }),
);

/* ------------------------------ 图片读写 ------------------------------ */

metadataRouter.get(
  "/image",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    assert(isImageName(req.query.name), 400, "未知图片类型");
    const target = resolveTarget(key);
    const scope = normalizeScope(req.query.scope);
    if (scope === "episode") assert(target.kind === "file", 400, "单集图片需要选择具体的视频文件");
    const file = imagePath(target, scope, req.query.name as ImageName);
    assert(fs.existsSync(file), 404, "图片不存在");
    res.setHeader("Cache-Control", "no-cache");
    res.type("image/jpeg");
    res.sendFile(file);
  }),
);

metadataRouter.delete(
  "/image",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    assert(isImageName(req.query.name), 400, "未知图片类型");
    const target = resolveTarget(key);
    const scope = normalizeScope(req.query.scope);
    if (scope === "episode") assert(target.kind === "file", 400, "单集图片需要选择具体的视频文件");
    const file = imagePath(target, scope, req.query.name as ImageName);
    const existed = fs.existsSync(file);
    await fs.promises.unlink(file).catch(() => undefined);
    res.json({ ok: true, removed: existed });
  }),
);

/** 上传图片：body 直接是二进制图片，?key=&scope=&name=&fit= */
metadataRouter.post(
  "/image",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "30mb" }),
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    assert(isImageName(req.query.name), 400, "未知图片类型");
    const buffer = req.body as Buffer;
    assert(Buffer.isBuffer(buffer) && buffer.length > 0, 400, "没有收到图片数据");

    const target = resolveTarget(key);
    const scope = normalizeScope(req.query.scope);
    if (scope === "episode") assert(target.kind === "file", 400, "单集图片需要选择具体的视频文件");
    const fit = normalizeFit(req.query.fit);
    const crop = parseCropParam(req.query.crop);
    const file = imagePath(target, scope, req.query.name as ImageName);
    await renderImage(buffer, file, IMAGE_SPECS[req.query.name as ImageName], fit, crop);

    logger.info({ path: target.path, name: req.query.name, scope, bytes: buffer.length }, "已上传封面图");
    res.json({ ok: true, url: `/api/metadata/image?key=${encodePath(target.path)}&scope=${scope}&name=${req.query.name}&v=${Date.now()}` });
  }),
);

/** 复制目录内已有图片到另一个槽位（含单集/剧集两个层级） */
metadataRouter.post(
  "/image/copy",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    const fromScope = normalizeScope(req.body?.fromScope);
    const toScope = normalizeScope(req.body?.toScope);
    const fromName = req.body?.fromName;
    const toName = req.body?.toName;
    assert(isImageName(fromName) && isImageName(toName), 400, "未知图片类型");
    if (toScope === "episode") assert(target.kind === "file", 400, "单集图片需要选择具体的视频文件");
    const src = imagePath(target, fromScope, fromName);
    assert(fs.existsSync(src), 404, "源图片不存在");
    const dest = imagePath(target, toScope, toName);
    await renderImage(src, dest, IMAGE_SPECS[toName], normalizeFit(req.body?.fit), parseCropParam(req.body?.crop));
    res.json({ ok: true, url: `/api/metadata/image?key=${encodePath(target.path)}&scope=${toScope}&name=${toName}&v=${Date.now()}` });
  }),
);

/** 用消息里的图片（data/covers 里的缓存）当封面 */
metadataRouter.post(
  "/image/from-cover",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    const file = String(req.body?.file ?? "");
    assert(/^-?\d+-\d+-\d+\.(jpe?g|png|webp)$/i.test(file), 400, "非法的封面文件名");
    const src = path.join(coversRoot, file);
    assert(fs.existsSync(src), 404, "封面缓存不存在");
    const name = req.body?.name;
    assert(isImageName(name), 400, "未知图片类型");
    const scope = normalizeScope(req.body?.scope);
    if (scope === "episode") assert(target.kind === "file", 400, "单集图片需要选择具体的视频文件");
    const dest = imagePath(target, scope, name);
    await renderImage(src, dest, IMAGE_SPECS[name], normalizeFit(req.body?.fit), parseCropParam(req.body?.crop));
    res.json({ ok: true, url: `/api/metadata/image?key=${encodePath(target.path)}&scope=${scope}&name=${name}&v=${Date.now()}` });
  }),
);

/* ------------------------------ ffmpeg 截帧 ------------------------------ */

/** 抽帧缓存目录按目标路径哈希，避免不同文件互相覆盖 */
async function framesDirOf(key: string): Promise<string> {
  const dir = path.join(framesRoot, key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "x");
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

metadataRouter.post(
  "/frames",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    assert(target.kind === "file" && target.video, 400, "请选择一个视频文件");
    assert(fs.existsSync(target.video), 410, "视频文件不在了");

    const probe = await probeVideo(target.video);
    const count = clampInt(req.body?.count, 3, 12, 8);
    const dir = await framesDirOf(key);
    const frames = await captureCandidates(target.video, probe?.duration ?? null, count, dir);
    assert(frames.length > 0, 500, "抽帧失败，请检查视频文件是否完整");

    res.json({
      items: frames.map((frame, index) => ({
        index,
        at: frame.at,
        url: `/api/metadata/frames/${path.basename(frame.file)}?key=${key}&v=${Date.now()}`,
      })),
      duration: probe?.duration ?? 0,
    });
  }),
);

metadataRouter.get(
  "/frames/:file",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    assert(/^f-\d+\.jpg$/i.test(req.params.file), 400, "非法文件名");
    const file = path.join(await framesDirOf(key), req.params.file);
    assert(fs.existsSync(file), 404, "帧不存在");
    res.setHeader("Cache-Control", "no-cache");
    res.type("image/jpeg");
    res.sendFile(file);
  }),
);

/** 截取指定时间点的一帧，直接写成某张封面 */
metadataRouter.post(
  "/frame",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    assert(target.kind === "file" && target.video, 400, "请选择一个视频文件");
    assert(fs.existsSync(target.video), 410, "视频文件不在了");

    const name = req.body?.name;
    assert(isImageName(name), 400, "未知图片类型");
    const scope = normalizeScope(req.body?.scope);
    if (scope === "episode") assert(target.kind === "file", 400, "单集图片需要选择具体的视频文件");
    const probe = await probeVideo(target.video);
    const duration = probe?.duration ?? null;
    let at = Number(req.body?.at);
    if (!Number.isFinite(at) || at < 0) at = duration ? duration * 0.25 : 5;
    if (duration && at > duration) at = Math.max(0, duration - 0.5);

    const spec = IMAGE_SPECS[name];
    const dest = imagePath(target, scope, name);
    const crop = parseCropParam(req.body?.crop);
    await captureFrame(target.video, {
      at,
      out: dest,
      width: spec.width,
      height: spec.height,
      fit: normalizeFit(req.body?.fit),
      crop,
    });

    logger.info({ path: target.path, at, name, scope }, "已从视频截帧生成封面");
    res.json({ ok: true, at, url: `/api/metadata/image?key=${encodePath(target.path)}&scope=${scope}&name=${name}&v=${Date.now()}` });
  }),
);

/**
 * 取某一时间点的原始画面（保留原比例），给界面上的「框选画面」用。
 */
metadataRouter.post(
  "/frame/preview",
  asyncHandler(async (req, res) => {
    const key = String(req.body?.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    assert(target.kind === "file" && target.video, 400, "请选择一个视频文件");
    assert(fs.existsSync(target.video), 410, "视频文件不在了");

    const probe = await probeVideo(target.video);
    const duration = probe?.duration ?? null;
    let at = Number(req.body?.at);
    if (!Number.isFinite(at) || at < 0) at = duration ? duration * 0.25 : 5;
    if (duration && at > duration) at = Math.max(0, duration - 0.5);

    const dir = await framesDirOf(key);
    const file = path.join(dir, "preview.jpg");
    await captureStill(target.video, at, file, 1280);

    res.json({
      ok: true,
      at,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      url: `/api/metadata/frame/preview?key=${key}&v=${Date.now()}`,
    });
  }),
);

metadataRouter.get(
  "/frame/preview",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    const file = path.join(await framesDirOf(key), "preview.jpg");
    assert(fs.existsSync(file), 404, "预览帧还没生成");
    res.setHeader("Cache-Control", "no-cache");
    res.type("image/jpeg");
    res.sendFile(file);
  }),
);

/* ------------------------------ 杂项 ------------------------------ */

/** 目录里的其它图片（logo 等），只允许读允许范围内的图片后缀 */
metadataRouter.get(
  "/extras",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    const name = path.basename(String(req.query.file ?? ""));
    assert(IMAGE_FILE_RE.test(name), 400, "非法文件名");
    const file = path.join(target.dir, name);
    assert(fs.existsSync(file), 404, "文件不存在");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
  }),
);

/** 视频流，支持 Range，便于在页面上拖进度条选帧 */
metadataRouter.get(
  "/video",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "");
    assert(key, 400, "缺少路径标识");
    const target = resolveTarget(key);
    assert(target.kind === "file" && target.video, 400, "请选择一个视频文件");
    const st = await fs.promises.stat(target.video);
    const range = req.headers.range;
    const total = st.size;
    res.setHeader("Accept-Ranges", "bytes");
    res.type("video/mp4");

    if (!range) {
      res.setHeader("Content-Length", String(total));
      fs.createReadStream(target.video).pipe(res);
      return;
    }
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? Number(match[1]) : 0;
    let end = match && match[2] ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(target.video, { start, end }).pipe(res);
  }),
);

/** ffmpeg 状态：安装/路径不对时界面用它提示 */
metadataRouter.get(
  "/tools/status",
  asyncHandler(async (req, res) => {
    const info = await ffmpegInfo(req.query.refresh === "1");
    res.json({ ffmpeg: info, sharp: Boolean(await loadSharp()), settings: { ffmpeg_path: getSettings().ffmpeg_path } });
  }),
);
