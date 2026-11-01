import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { db, getSettings } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { Download } from "../types";
import { sanitizeSegment } from "../utils";
import { decodeMeta, encodeMeta, EmbyMeta } from "../tg/emby";
import { listCovers } from "../tg/covers";
import { captureCandidates, captureFrame, ffmpegInfo, probeVideo, type FitMode } from "../tg/ffmpeg";
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
import { asyncHandler, assert, clampInt, parseId } from "../lib/http";

/**
 * 元数据管理：查看/编辑已下载视频的 NFO 与 Emby 图片，可用 ffmpeg 从视频里截帧当封面。
 *
 * 约定：
 *  - 「剧集级」图片放在剧集目录（poster.jpg / landscape.jpg / fanart.jpg / thumb.jpg / banner.jpg）
 *  - 「单集级」图片加文件名前缀（美人局S01E04-poster.jpg …），Emby 会优先用它
 *  - NFO 编辑采用「定位 + 局部替换」，只改目标标签，用户手写的其它内容不动
 */

export const metadataRouter = Router();

const stmtGet = db.prepare<[number], Download>("SELECT * FROM downloads WHERE id = ?");
const stmtUpdateMeta = db.prepare<[string, number]>("UPDATE downloads SET emby_json = ? WHERE id = ?");

const downloadRoot = path.resolve(env.downloadDir) + path.sep;
const framesRoot = path.join(env.dataDir, "frames");
const coversRoot = path.join(env.dataDir, "covers");

interface Target {
  video: string;
  dir: string;
  base: string;
}

function resolveTarget(row: Download): Target {
  assert(row.file_path, 400, "该任务没有落盘文件（可能还没下载完成）");
  const video = path.resolve(row.file_path);
  assert(video.startsWith(downloadRoot), 403, "文件不在下载目录内");
  return { video, dir: path.dirname(video), base: path.basename(video, path.extname(video)) };
}

/* ------------------------------ 图片规格 ------------------------------ */

type ImageName = "poster" | "landscape" | "fanart" | "thumb" | "banner";

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

function isImageName(value: unknown): value is ImageName {
  return typeof value === "string" && (IMAGE_NAMES as string[]).includes(value);
}

function normalizeScope(value: unknown): "series" | "episode" {
  return value === "episode" ? "episode" : "series";
}

function imagePath(target: Target, scope: "series" | "episode", name: ImageName): string {
  const file = scope === "episode" ? `${sanitizeSegment(target.base, 120)}-${name}.jpg` : `${name}.jpg`;
  return path.join(target.dir, file);
}

const IMAGE_FILE_RE = /^[\w\-. ()（）[\]]+\.(jpe?g|png|webp)$/i;

/** 列出一个目录里已经存在的图片（排除临时封面 .art-*） */
async function listImageFiles(dir: string): Promise<string[]> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => !n.startsWith(".") && IMAGE_FILE_RE.test(n))
    .filter((n) => /\.(jpe?g|png|webp)$/i.test(n))
    .sort();
}

type SharpLike = {
  (input: string | Buffer): {
    metadata(): Promise<{ width?: number; height?: number }>;
    resize(opts: { width: number; height: number; fit: string; position?: string; background?: string }): {
      jpeg(opts: { quality: number }): { toFile(target: string): Promise<unknown> };
    };
  };
};

let sharpCache: SharpLike | null | undefined;

async function loadSharp(): Promise<SharpLike | null> {
  if (sharpCache !== undefined) return sharpCache;
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpLike } & SharpLike;
    sharpCache = (mod.default ?? mod) as SharpLike;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
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

async function saveBuffer(buffer: Buffer, dest: string, spec: { width: number; height: number }, fit: FitMode) {
  const sharp = await loadSharp();
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  if (!sharp) {
    await fs.promises.writeFile(dest, buffer);
    return;
  }
  const fitMode = fit === "stretch" ? "fill" : fit;
  await sharp(buffer)
    .resize({ width: spec.width, height: spec.height, fit: fitMode, position: "attention", background: "#000000" })
    .jpeg({ quality: 92 })
    .toFile(dest);
}

/* ------------------------------ 路径与 NFO ------------------------------ */

function nfoPaths(target: Target) {
  const base = sanitizeSegment(target.base, 120);
  return {
    episode: path.join(target.dir, `${base}.nfo`),
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

    const where = ["status = 'done'", "file_path IS NOT NULL", "media_kind = 'video'"];
    const params: unknown[] = [];
    if (q) {
      where.push("(file_name LIKE ? OR save_name LIKE ? OR channel_title LIKE ? OR save_dir LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const rows = db
      .prepare(`SELECT * FROM downloads ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Download[];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM downloads ${whereSql}`).get(...params) as { n: number }).n;

    // 同一剧集目录会被多集命中，readdir 结果按目录缓存
    const dirCache = new Map<string, string[]>();
    const readDir = async (dir: string) => {
      if (!dirCache.has(dir)) dirCache.set(dir, await fs.promises.readdir(dir).catch(() => [] as string[]));
      return dirCache.get(dir) as string[];
    };

    const items = await Promise.all(
      rows.map(async (row) => {
        const meta = decodeMeta(row.emby_json);
        let dir = "";
        let nfoExists = false;
        let showNfoExists = false;
        let posterExists = false;
        let imageCount = 0;
        let videoExists = false;

        if (row.file_path) {
          const video = path.resolve(row.file_path);
          if (video.startsWith(downloadRoot)) {
            dir = path.dirname(video);
            const base = path.basename(video, path.extname(video));
            const files = await readDir(dir);
            videoExists = files.includes(path.basename(video));
            nfoExists = files.includes(`${sanitizeSegment(base, 120)}.nfo`);
            showNfoExists = files.includes("tvshow.nfo");
            posterExists = files.includes("poster.jpg") || files.includes("poster.png");
            imageCount = files.filter((n) => IMAGE_FILE_RE.test(n) && !n.startsWith(".")).length;
          }
        }

        return {
          id: row.id,
          file_name: row.file_name,
          save_name: row.save_name,
          save_dir: row.save_dir,
          channel_title: row.channel_title,
          message_id: row.message_id,
          file_size: row.file_size,
          finished_at: row.finished_at,
          series: meta?.series ?? null,
          season: meta?.season ?? null,
          episode: meta?.episode ?? null,
          title: meta ? (meta.episode !== null ? `${meta.series} S${String(meta.season).padStart(2, "0")}E${String(meta.episode).padStart(2, "0")}` : meta.series) : row.file_name,
          videoExists,
          nfoExists,
          showNfoExists,
          posterExists,
          imageCount,
          posterUrl: posterExists ? `/api/metadata/${row.id}/image/series/poster` : null,
        };
      }),
    );

    res.json({ items, total, limit, offset });
  }),
);

/* ------------------------------ 详情 ------------------------------ */

metadataRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");

    let target: Target | null = null;
    let pathError: string | null = null;
    try {
      target = resolveTarget(row);
    } catch (err) {
      pathError = (err as Error).message;
    }

    const ffmpeg = await ffmpegInfo();

    if (!target) {
      res.json({
        item: row,
        pathError,
        paths: null,
        video: null,
        nfo: { episode: null, show: null },
        images: [],
        extras: [],
        fields: { episode: fieldsFromEmby(row), show: fieldsFromEmby(row) },
        meta: decodeMeta(row.emby_json),
        ffmpeg,
        covers: [],
      });
      return;
    }

    const nfoFile = nfoPaths(target);
    const episodeRaw = await readText(nfoFile.episode);
    const showRaw = await readText(nfoFile.show);
    const episodeParsed = episodeRaw ? parseNfo(episodeRaw) : null;
    const showParsed = showRaw ? parseNfo(showRaw) : null;

    const episodeFields = episodeRaw ? fieldsFromNfo(episodeParsed) : fieldsFromEmby(row);
    const showFields = showRaw ? fieldsFromNfo(showParsed) : fieldsFromEmby(row);

    const images: Array<Record<string, unknown>> = [];
    for (const scope of ["series", "episode"] as const) {
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
          url: `/api/metadata/${row.id}/image/${scope}/${name}?v=${st.updatedAt}`,
        });
      }
    }

    // 目录里的其它图片（logo、clearlogo 等手放进去的）
    const known = new Set(images.map((img) => img.file as string));
    const allFiles = await listImageFiles(target.dir);
    const extras = allFiles
      .filter((n) => !known.has(n))
      .map((n) => ({ file: n, url: `/api/metadata/${row.id}/file/${encodeURIComponent(n)}` }));

    const videoStat = await statFile(target.video);
    const probe = videoStat ? await probeVideo(target.video) : null;

    const covers = await listCovers(row.channel_id, row.message_id).catch(() => []);

    res.json({
      item: row,
      pathError: null,
      paths: { dir: target.dir, video: target.video, base: target.base, dirName: path.basename(target.dir) },
      video: videoStat ? { exists: true, size: videoStat.size, probe } : { exists: false, size: 0, probe: null },
      nfo: {
        episode: {
          exists: Boolean(episodeRaw),
          file: path.basename(nfoFile.episode),
          path: nfoFile.episode,
          size: episodeRaw ? Buffer.byteLength(episodeRaw) : 0,
          nested: Boolean(episodeParsed?.children.some((c) => c.nested)),
          editable: !episodeRaw || !episodeParsed?.children.some((c) => c.nested),
        },
        show: {
          exists: Boolean(showRaw),
          file: path.basename(nfoFile.show),
          path: nfoFile.show,
          size: showRaw ? Buffer.byteLength(showRaw) : 0,
          nested: Boolean(showParsed?.children.some((c) => c.nested)),
          editable: !showRaw || !showParsed?.children.some((c) => c.nested),
        },
      },
      images,
      extras,
      fields: { episode: episodeFields, show: showFields },
      meta: decodeMeta(row.emby_json),
      ffmpeg,
      covers,
    });
  }),
);

/* ------------------------------ 保存字段 ------------------------------ */

metadataRouter.put(
  "/:id/meta",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    const kind = req.body?.kind === "show" ? "show" : "episode";

    const currentRaw = await readText(nfoPaths(target)[kind]);
    const currentParsed = currentRaw ? parseNfo(currentRaw) : null;
    const base = currentRaw ? fieldsFromNfo(currentParsed) : fieldsFromEmby(row);
    const fields = cleanFields(req.body?.fields, base);
    assert(fields.showtitle || fields.title, 400, "剧名/标题不能为空");

    let next: string;
    if (currentRaw && currentParsed) {
      next = applyFields(currentParsed, fields);
    } else {
      next = buildNfo(kind, fields);
    }

    const problem = validateNfo(next, kind);
    assert(!problem, 500, `生成的 NFO 不合法：${problem}`);

    await writeTextAtomic(nfoPaths(target)[kind], next);
    const meta = kind === "episode" ? syncEmbyJson(row, fields) : null;

    logger.info({ id, kind }, "已保存元数据");
    res.json({ ok: true, nfo: next, fields, meta });
  }),
);

/* ------------------------------ NFO 原文 ------------------------------ */

metadataRouter.get(
  "/:id/nfo/:kind",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    const kind = req.params.kind === "show" ? "show" : "episode";
    const raw = await readText(nfoPaths(target)[kind]);
    res.json({
      exists: raw !== null,
      file: path.basename(nfoPaths(target)[kind]),
      content: raw ?? buildNfo(kind, fieldsFromEmby(row)),
    });
  }),
);

metadataRouter.put(
  "/:id/nfo",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    const kind = req.body?.kind === "show" ? "show" : "episode";
    const content = String(req.body?.content ?? "");

    const problem = validateNfo(content, kind);
    assert(!problem, 400, problem ?? "内容不合法");

    await writeTextAtomic(nfoPaths(target)[kind], content.endsWith("\n") ? content : `${content}\n`);

    // 顺手把能识别出来的字段同步进 emby_json，保持生成器与手改一致
    if (kind === "episode") {
      const parsed = parseNfo(content);
      if (parsed) syncEmbyJson(row, fieldsFromNfo(parsed));
    }

    logger.info({ id, kind }, "已保存 NFO 原文");
    res.json({ ok: true });
  }),
);

/* ------------------------------ 图片读写 ------------------------------ */

metadataRouter.get(
  "/:id/image/:scope/:name",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    assert(isImageName(req.params.name), 400, "未知图片类型");
    const target = resolveTarget(row);
    const file = imagePath(target, normalizeScope(req.params.scope), req.params.name);
    assert(fs.existsSync(file), 404, "图片不存在");
    res.setHeader("Cache-Control", "no-cache");
    res.type("image/jpeg");
    res.sendFile(file);
  }),
);

metadataRouter.delete(
  "/:id/image/:scope/:name",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    assert(isImageName(req.params.name), 400, "未知图片类型");
    const target = resolveTarget(row);
    const file = imagePath(target, normalizeScope(req.params.scope), req.params.name);
    const existed = fs.existsSync(file);
    await fs.promises.unlink(file).catch(() => undefined);
    res.json({ ok: true, removed: existed });
  }),
);

/** 上传图片：body 直接是二进制图片，?scope=&name=&fit= */
metadataRouter.post(
  "/:id/image",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "30mb" }),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const name = String(req.query.name ?? "");
    assert(isImageName(name), 400, "未知图片类型");
    const buffer = req.body as Buffer;
    assert(Buffer.isBuffer(buffer) && buffer.length > 0, 400, "没有收到图片数据");

    const target = resolveTarget(row);
    const scope = normalizeScope(req.query.scope);
    const fit = normalizeFit(req.query.fit);
    const file = imagePath(target, scope, name as ImageName);
    await saveBuffer(buffer, file, IMAGE_SPECS[name], fit);
    await fs.promises.unlink(`${file}.tmp`).catch(() => undefined);

    logger.info({ id, name, scope, bytes: buffer.length }, "已上传封面图");
    res.json({ ok: true, url: `/api/metadata/${id}/image/${scope}/${name}?v=${Date.now()}` });
  }),
);

/** 复制目录内已有图片到另一个槽位（含单集/剧集两个层级） */
metadataRouter.post(
  "/:id/image/copy",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    const fromScope = normalizeScope(req.body?.fromScope);
    const fromName = req.body?.fromName;
    const toScope = normalizeScope(req.body?.toScope);
    const toName = req.body?.toName;
    assert(isImageName(fromName) && isImageName(toName), 400, "未知图片类型");
    const src = imagePath(target, fromScope, fromName);
    assert(fs.existsSync(src), 404, "源图片不存在");
    const dest = imagePath(target, toScope, toName);
    await writeImageFile(src, dest, IMAGE_SPECS[toName], normalizeFit(req.body?.fit));
    res.json({ ok: true, url: `/api/metadata/${id}/image/${toScope}/${toName}?v=${Date.now()}` });
  }),
);

async function writeImageFile(
  src: string,
  dest: string,
  spec: { width: number; height: number },
  fit: FitMode,
): Promise<void> {
  const sharp = await loadSharp();
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  if (!sharp) {
    await fs.promises.copyFile(src, dest);
    return;
  }
  const fitMode = fit === "stretch" ? "fill" : fit;
  await sharp(src)
    .resize({ width: spec.width, height: spec.height, fit: fitMode, position: "attention", background: "#000000" })
    .jpeg({ quality: 92 })
    .toFile(dest);
}

/** 用消息里的图片（data/covers 里的缓存）当封面 */
metadataRouter.post(
  "/:id/image/from-cover",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    const file = String(req.body?.file ?? "");
    assert(/^-?\d+-\d+-\d+\.(jpe?g|png|webp)$/i.test(file), 400, "非法的封面文件名");
    const src = path.join(coversRoot, file);
    assert(fs.existsSync(src), 404, "封面缓存不存在");
    const name = req.body?.name;
    assert(isImageName(name), 400, "未知图片类型");
    const scope = normalizeScope(req.body?.scope);
    const dest = imagePath(target, scope, name);
    await writeImageFile(src, dest, IMAGE_SPECS[name], normalizeFit(req.body?.fit));
    res.json({ ok: true, url: `/api/metadata/${id}/image/${scope}/${name}?v=${Date.now()}` });
  }),
);

/* ------------------------------ ffmpeg 截帧 ------------------------------ */

async function framesDirOf(id: number): Promise<string> {
  const dir = path.join(framesRoot, String(id));
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/** 抽一组候选帧（5%~90% 均匀），返回可预览的 URL */
metadataRouter.post(
  "/:id/frames",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    assert(fs.existsSync(target.video), 410, "视频文件不在了");

    const probe = await probeVideo(target.video);
    const count = clampInt(req.body?.count, 3, 12, 8);
    const dir = await framesDirOf(id);
    const frames = await captureCandidates(target.video, probe?.duration ?? null, count, dir);
    assert(frames.length > 0, 500, "抽帧失败，请检查视频文件是否完整");

    res.json({
      items: frames.map((frame, index) => ({
        index,
        at: frame.at,
        url: `/api/metadata/${id}/frames/${path.basename(frame.file)}?v=${Date.now()}`,
      })),
      duration: probe?.duration ?? 0,
    });
  }),
);

metadataRouter.get(
  "/:id/frames/:file",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    assert(/^f-\d+\.jpg$/i.test(req.params.file), 400, "非法文件名");
    const file = path.join(framesRoot, String(id), req.params.file);
    assert(fs.existsSync(file), 404, "帧不存在");
    res.setHeader("Cache-Control", "no-cache");
    res.type("image/jpeg");
    res.sendFile(file);
  }),
);

/** 截取指定时间点的一帧，直接写成某张封面 */
metadataRouter.post(
  "/:id/frame",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    assert(fs.existsSync(target.video), 410, "视频文件不在了");

    const name = req.body?.name;
    assert(isImageName(name), 400, "未知图片类型");
    const scope = normalizeScope(req.body?.scope);
    const probe = await probeVideo(target.video);
    const duration = probe?.duration ?? null;
    let at = Number(req.body?.at);
    if (!Number.isFinite(at) || at < 0) at = duration ? duration * 0.25 : 5;
    if (duration && at > duration) at = Math.max(0, duration - 0.5);

    const spec = IMAGE_SPECS[name];
    const dest = imagePath(target, scope, name);
    await captureFrame(target.video, {
      at,
      out: dest,
      width: spec.width,
      height: spec.height,
      fit: normalizeFit(req.body?.fit),
    });

    logger.info({ id, at, name, scope }, "已从视频截帧生成封面");
    res.json({ ok: true, at, url: `/api/metadata/${id}/image/${scope}/${name}?v=${Date.now()}` });
  }),
);

/* ------------------------------ 杂项 ------------------------------ */

/** 目录里的其它图片（logo 等），只允许读下载目录内、图片后缀 */
metadataRouter.get(
  "/:id/file/:file",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    const name = path.basename(req.params.file);
    assert(IMAGE_FILE_RE.test(name), 400, "非法文件名");
    const file = path.join(target.dir, name);
    assert(fs.existsSync(file), 404, "文件不存在");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
  }),
);

/** 视频流，支持 Range，便于在页面上拖进度条选帧 */
metadataRouter.get(
  "/:id/video",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const row = stmtGet.get(id);
    assert(row, 404, "记录不存在");
    const target = resolveTarget(row);
    const st = await fs.promises.stat(target.video).catch(() => null);
    assert(st, 410, "视频文件不在了");

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

