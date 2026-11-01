import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { env } from "../env";

/**
 * 结构化日志的内存环形缓冲 + 落盘。
 *
 * 为什么两处都要：
 * - 落盘（data/logs/app.log）：容器重启后日志还在，NAS 上能直接翻历史；
 * - 内存缓冲：页面查询不用反复读磁盘，且能按级别/关键词过滤后再分页。
 *
 * 日志本体由 pino 写出（logger.ts 通过 multistream 同时投到 stdout 和文件），
 * 这里只负责「读回来 + 提供查询」。
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** pino 的数字级别 → 名称 */
function levelName(level: unknown): LogLevel {
  const n = typeof level === "number" ? level : Number(level);
  for (const [name, value] of Object.entries(LEVEL_ORDER)) {
    if (value === n) return name as LogLevel;
  }
  return "info";
}

export interface LogEntry {
  /** 毫秒时间戳 */
  time: number;
  /** ISO 时间串 */
  iso: string;
  level: LogLevel;
  msg: string;
  /** 除 level/msg/time 之外的附加字段 */
  fields: Record<string, unknown>;
}

/** 内存里保留的条数上限 */
const MEMORY_LIMIT = 2000;
/** 单次从文件读取的最大字节数（只看尾部） */
const READ_TAIL_BYTES = 512 * 1024;
/** 日志文件超过这个大小就轮转（保留一份历史） */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

let buffer: LogEntry[] = [];
let seq = 0;

export function logFilePath(): string {
  return path.join(env.dataDir, "logs", "app.log");
}

export function logDirPath(): string {
  return path.join(env.dataDir, "logs");
}

/**
 * 解析一行 pino JSON 日志。
 * 解析不了就整行塞进 msg，保证页面不会因为一条脏数据丢整段。
 */
function parseLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "level" || k === "msg" || k === "time" || k === "app") continue;
      fields[k] = v;
    }
    const rawTime = obj.time;
    const time =
      typeof rawTime === "number"
        ? rawTime
        : typeof rawTime === "string"
          ? Date.parse(rawTime)
          : Date.now();
    return {
      time: Number.isFinite(time) ? time : Date.now(),
      iso: new Date(Number.isFinite(time) ? time : Date.now()).toISOString(),
      level: levelName(obj.level),
      msg: typeof obj.msg === "string" ? obj.msg : "",
      fields,
    };
  } catch {
    const now = Date.now();
    return { time: now, iso: new Date(now).toISOString(), level: "info", msg: trimmed, fields: {} };
  }
}

function push(entry: LogEntry): void {
  seq += 1;
  buffer.push(entry);
  if (buffer.length > MEMORY_LIMIT) {
    buffer.splice(0, buffer.length - MEMORY_LIMIT);
  }
}

/**
 * 从日志文件尾部读取历史条目，灌进内存缓冲。
 *
 * 只在启动时调用一次：容器重启后，之前那次的日志还能在页面上看到。
 * 读整个文件会拖慢启动，所以只读尾部一段。
 */
export function hydrateFromFile(): number {
  const file = logFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return 0;
  }
  const readBytes = Math.min(stat.size, READ_TAIL_BYTES);
  if (readBytes <= 0) return 0;

  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    // 头部那行可能是被截断的半个 JSON，解析失败会被当作普通文本，不影响其它行
    let loaded = 0;
    for (const line of lines) {
      const entry = parseLine(line);
      if (!entry) continue;
      push(entry);
      loaded += 1;
    }
    return loaded;
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface LogQuery {
  /** 最低级别（含） */
  level?: LogLevel | "all";
  /** 关键词：匹配 msg 或附加字段的字符串形式 */
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  items: LogEntry[];
  total: number;
  limit: number;
  offset: number;
  /** 各级别在当前过滤条件下的条数 */
  counts: Record<LogLevel, number>;
  /** 文件大小（字节） */
  fileSize: number;
}

export function queryLogs(query: LogQuery = {}): LogQueryResult {
  const level = query.level && query.level !== "all" ? query.level : null;
  const minLevel = level ? LEVEL_ORDER[level] : 0;
  const keyword = (query.keyword || "").trim().toLowerCase();

  const matched: LogEntry[] = [];
  const counts: Record<LogLevel, number> = {
    trace: 0,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
  };

  for (const entry of buffer) {
    if (LEVEL_ORDER[entry.level] < minLevel) continue;
    counts[entry.level] += 1;
    if (!keyword) {
      matched.push(entry);
      continue;
    }
    const haystack = `${entry.msg} ${JSON.stringify(entry.fields)}`.toLowerCase();
    if (haystack.includes(keyword)) matched.push(entry);
  }

  // 时间倒序：新的在前
  matched.reverse();

  const total = matched.length;
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);

  let fileSize = 0;
  try {
    fileSize = fs.statSync(logFilePath()).size;
  } catch {
    /* 文件还没建出来 */
  }

  return {
    items: matched.slice(offset, offset + limit),
    total,
    limit,
    offset,
    counts,
    fileSize,
  };
}

/** 清空内存缓冲（磁盘文件由调用方决定是否清） */
export function clearMemory(): void {
  buffer = [];
}

/** 磁盘日志文件清空 */
export function truncateFile(): void {
  const file = logFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * 自定义日志流：写入文件的同时把结构化条目塞进内存缓冲。
 *
 * 不用 pino.destination 是因为它只管写盘，拿不到解析后的条目；
 * 自己写 Writable 可以一份数据两处用，且同步写盘 —— 容器被 kill 时日志不丢。
 */
export function createLogStream(): NodeJS.WritableStream {
  const dir = logDirPath();
  const file = logFilePath();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }

  let pending = "";
  let written = 0;
  try {
    written = fs.statSync(file).size;
  } catch {
    written = 0;
  }

  return new Writable({
    write(chunk: Buffer | string, _enc: BufferEncoding, callback: (err?: Error | null) => void) {
      const text = chunk.toString("utf8");
      try {
        // 轮转：超过上限就把当前文件改名，重新开一个
        if (written > 0 && written + Buffer.byteLength(text) > MAX_FILE_BYTES) {
          try {
            fs.renameSync(file, `${file}.1`);
          } catch {
            /* ignore */
          }
          written = 0;
        }
        fs.appendFileSync(file, text, "utf8");
        written += Buffer.byteLength(text);
      } catch {
        /* 磁盘写失败也不能影响主流程 */
      }
      pending += text;
      const lines = pending.split("\n");
      // 最后一段可能还没写完，留到下一批
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) push(entry);
      }
      callback();
    },
  });
}

