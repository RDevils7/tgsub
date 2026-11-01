import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import {
  clearMemory,
  hydrateFromFile,
  logFilePath,
  queryLogs,
  truncateFile,
  type LogLevel,
} from "../lib/logstore";
import { asyncHandler } from "../lib/http";

export const logsRouter = Router();

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

function parseLevel(raw: unknown): LogLevel | "all" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "all") return "all";
  return (LEVELS as string[]).includes(value) ? (value as LogLevel) : "all";
}

/**
 * 日志查询：支持级别过滤、关键词搜索、分页。
 * 数据来自内存缓冲（启动时从文件尾部回灌过一次）。
 */
logsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = queryLogs({
      level: parseLevel(req.query.level),
      keyword: typeof req.query.q === "string" ? req.query.q : "",
      limit: req.query.limit ? Number(req.query.limit) : 100,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json(result);
  }),
);

/** 供页面首次进入时统计各��别条数 */
logsRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const result = queryLogs({ limit: 1 });
    res.json({ counts: result.counts, fileSize: result.fileSize });
  }),
);

/** 下载完整日志文件 */
logsRouter.get(
  "/download",
  asyncHandler(async (_req, res) => {
    const file = logFilePath();
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "日志文件不存在" });
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tgsub-${stamp}.log"`,
    );
    fs.createReadStream(file).pipe(res);
  }),
);

/** 清空日志（内存 + 磁盘） */
logsRouter.delete(
  "/",
  asyncHandler(async (_req, res) => {
    clearMemory();
    truncateFile();
    res.json({ ok: true });
  }),
);

/**
 * 重新从磁盘回灌日志。
 * 页面长时间开着、或刚清空过文件时，用它把内存缓冲和磁盘对齐。
 */
logsRouter.post(
  "/reload",
  asyncHandler(async (_req, res) => {
    clearMemory();
    const loaded = hydrateFromFile();
    res.json({ ok: true, loaded });
  }),
);

/** 日志目录里还有哪些文件（轮转的历史文件等） */
logsRouter.get(
  "/files",
  asyncHandler(async (_req, res) => {
    const dir = path.dirname(logFilePath());
    let files: Array<{ name: string; size: number; modifiedAt: number }> = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".log") || name.endsWith(".log.1"))
        .map((name) => {
          const st = fs.statSync(path.join(dir, name));
          return { name, size: st.size, modifiedAt: st.mtimeMs };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
    } catch {
      /* 目录还没建出来 */
    }
    res.json({ items: files });
  }),
);
