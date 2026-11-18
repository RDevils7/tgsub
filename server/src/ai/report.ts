import fs from "node:fs";
import path from "node:path";
import { db, getSettings, getSessionMeta } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { callAIJson, isAiEnabled } from "./client";
import { queryLogs, type LogEntry } from "../lib/logstore";
import { downloader } from "../tg/downloader";
import { getBotState } from "../tg/bot";
import { ffmpegInfo, hwCapability } from "../tg/ffmpeg";
import { ytdlpInfo } from "../platform/ytdlp";
import { APP_VERSION } from "../version";

/**
 * AI 故障报告（功能 C 增强）。
 *
 * 目标：出问题时，由内置 AI 根据「日志 + 运行/容器状态」自动整理一份**问题报告**，
 * 报告是结构化的，其他智能体可以直接拿去定位与修改代码，而不是让人再翻日志。
 *
 * 组成：
 *   1) collectDiagnosticBundle() —— 采集非敏感的运行状态与最近告警/错误日志
 *   2) detectSignals()           —— 规则先判一遍「有哪些明显异常」
 *   3) generateProblemReport()   —— 交 AI 归纳根因与修复建议，渲染 Markdown 并落盘
 *
 * 报告写到 DATA_DIR/reports/ 下（Markdown + latest.json），既可在界面看，
 * 也可被外部智能体直接读取。
 */

/* ------------------------------------------------------------------ */
/* 采集                                                                */
/* ------------------------------------------------------------------ */

export interface DiagnosticBundle {
  generatedAt: string;
  app: {
    version: string;
    uptimeSec: number;
    node: string;
    platform: string;
    pid: number;
    memRssMB: number;
    memHeapUsedMB: number;
  };
  settings: Record<string, unknown>;
  telegram: {
    sessionState: string;
    sessionError: string | null;
    sessionSavedAt: number | null;
    bot: { enabled: boolean; running: boolean; username: string | null; tokenSet: boolean; error: string | null };
  };
  queue: { active: number; waiting: number; failedRecent24h: number };
  tools: {
    ffmpeg: { available: boolean; version: string | null; error: string | null };
    hw: { available: boolean; accel: string | null; label: string | null; reason: string | null };
    ytdlp: { available: boolean; version: string | null; error: string | null };
  };
  disk: Record<string, { freeMB: number; totalMB: number } | null>;
  channels: Array<{ title: string; lastError: string; lastScanAt: number | null }>;
  recentFailures: Array<{ id: number; name: string; error: string | null; at: number | null }>;
  logs: { warns: string[]; errors: string[] };
  signals: string[];
}

function logLine(e: LogEntry): string {
  const fields = Object.entries(e.fields)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 120) : v}`)
    .join(" ");
  return `[${e.level}] ${e.msg}${fields ? ` | ${fields}` : ""}`;
}

async function diskInfo(dir: string): Promise<{ freeMB: number; totalMB: number } | null> {
  try {
    const s = await fs.promises.statfs(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { freeMB: Math.round(free / 1048576), totalMB: Math.round(total / 1048576) };
  } catch {
    return null;
  }
}

function safeSettingSummary() {
  const s = getSettings() as unknown as Record<string, unknown>;
  // 只取与排障相关的非敏感项，绝不带出任何密钥/token/session
  const keys = [
    "auto_scan",
    "scan_interval_minutes",
    "credential_mode",
    "builtin_app",
    "platform_enabled",
    "emby_meta",
    "emby_notify",
    "ai_enabled",
    "ai_model",
    "ai_naming",
    "ai_autodiagnose",
    "hw_accel",
    "dir_m3u8",
    "fallback_folder",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in s) out[k] = s[k];
  // 代理只报是否配置，不报地址
  const proxy = String(s["proxy_url"] ?? "").trim();
  out["proxyConfigured"] = Boolean(proxy);
  return out;
}

/** 采集诊断所需的全部信息（只读、非敏感） */
export async function collectDiagnosticBundle(): Promise<DiagnosticBundle> {
  const settings = safeSettingSummary();
  const meta = getSessionMeta();
  const bot = getBotState();
  const queue = downloader.stats();
  const mem = process.memoryUsage();

  let ffmpeg = { available: false, version: null as string | null, error: "未探测" as string | null };
  let hw = { available: false, accel: null as string | null, label: null as string | null, reason: null as string | null };
  let ytdlp = { available: false, version: null as string | null, error: null as string | null };
  try {
    const info = await ffmpegInfo();
    ffmpeg = { available: info.available, version: info.version, error: info.error };
  } catch (e) {
    ffmpeg.error = (e as Error).message;
  }
  try {
    const cap = await hwCapability();
    hw = {
      available: cap.available,
      accel: (cap as { accel?: string | null }).accel ?? null,
      label: (cap as { label?: string | null }).label ?? null,
      reason: (cap as { reason?: string | null }).reason ?? null,
    };
  } catch (e) {
    hw.reason = (e as Error).message;
  }
  try {
    const info = await ytdlpInfo();
    ytdlp = { available: info.available, version: info.version, error: info.error };
  } catch (e) {
    ytdlp.error = (e as Error).message;
  }

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  let failedRecent24h = 0;
  try {
    failedRecent24h = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE status = 'failed' AND created_at >= ?").get(dayAgo) as {
        n: number;
      }).n,
    );
  } catch {
    /* ignore */
  }

  let channels: DiagnosticBundle["channels"] = [];
  try {
    channels = (
      db
        .prepare(
          "SELECT title, last_error, last_scan_at FROM channels WHERE last_error IS NOT NULL ORDER BY last_scan_at DESC LIMIT 6",
        )
        .all() as Array<{ title: string; last_error: string | null; last_scan_at: number | null }>
    ).map((r) => ({ title: r.title, lastError: r.last_error ?? "", lastScanAt: r.last_scan_at }));
  } catch {
    /* ignore */
  }

  let recentFailures: DiagnosticBundle["recentFailures"] = [];
  try {
    recentFailures = (
      db
        .prepare(
          "SELECT id, save_name, file_name, error, finished_at FROM downloads WHERE status = 'failed' ORDER BY id DESC LIMIT 8",
        )
        .all() as Array<{ id: number; save_name: string | null; file_name: string; error: string | null; finished_at: number | null }>
    ).map((r) => ({ id: r.id, name: r.save_name ?? r.file_name, error: r.error, at: r.finished_at }));
  } catch {
    /* ignore */
  }

  const warnEntries = queryLogs({ level: "warn", limit: 250 }).items;
  const warns = warnEntries.filter((e) => e.level === "warn").slice(0, 120).map(logLine);
  const errors = warnEntries
    .filter((e) => e.level === "error" || e.level === "fatal")
    .slice(0, 80)
    .map(logLine);

  const bundle: DiagnosticBundle = {
    generatedAt: new Date().toISOString(),
    app: {
      version: APP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      pid: process.pid,
      memRssMB: Math.round(mem.rss / 1048576),
      memHeapUsedMB: Math.round(mem.heapUsed / 1048576),
    },
    settings,
    telegram: {
      sessionState: meta.state,
      sessionError: meta.error,
      sessionSavedAt: meta.savedAt,
      bot: {
        enabled: bot.enabled,
        running: bot.running,
        username: bot.username,
        tokenSet: bot.tokenSet,
        error: bot.error,
      },
    },
    queue: { active: queue.active, waiting: queue.waiting, failedRecent24h },
    tools: { ffmpeg, hw, ytdlp },
    disk: {
      dataDir: await diskInfo(env.dataDir),
      downloadDir: await diskInfo(env.downloadDir),
    },
    channels,
    recentFailures,
    logs: { warns, errors },
    signals: [],
  };

  bundle.signals = detectSignals(bundle);
  return bundle;
}

/** 用规则先圈出「明显的异常信号」，既是自动触发的依据，也告诉 AI 从哪里看起 */
export function detectSignals(b: DiagnosticBundle): string[] {
  const s: string[] = [];
  if (b.telegram.sessionState === "dead") {
    s.push(`Telegram 会话失效（${b.telegram.sessionError ?? "未知"}）`);
  }
  if (b.telegram.bot.enabled && !b.telegram.bot.running) {
    s.push(`Telegram 机器人未运行（${b.telegram.bot.error ?? "无错误信息"}）`);
  }
  if (b.telegram.bot.enabled && !b.telegram.bot.tokenSet) s.push("机器人已启用但未配置 Token");
  if (b.logs.errors.length > 0) s.push(`最近有 ${b.logs.errors.length} 条 error/fatal 日志`);
  if (b.queue.failedRecent24h > 0) s.push(`近 24h 有 ${b.queue.failedRecent24h} 个下载失败`);
  if (b.channels.length > 0) s.push(`${b.channels.length} 个频道存在扫描错误`);
  if (b.tools.ffmpeg && !b.tools.ffmpeg.available) s.push("ffmpeg 不可用");
  if (b.tools.ytdlp && !b.tools.ytdlp.available) s.push("yt-dlp 不可用");
  for (const [dir, info] of Object.entries(b.disk)) {
    if (info && info.freeMB < 2048) s.push(`${dir} 剩余空间偏低（${info.freeMB}MB）`);
  }
  return s;
}

/**
 * 自动触发用的「严重信号」：只挑真正需要出报告的情况，
 * 避免「偶发一条下载失败」这种噪音也去调 AI（控制成本）。
 */
export function seriousSignals(b: DiagnosticBundle): string[] {
  const s: string[] = [];
  if (b.telegram.sessionState === "dead") {
    s.push(`Telegram 会话失效（${b.telegram.sessionError ?? "未知"}）`);
  }
  if (b.telegram.bot.enabled && (!b.telegram.bot.running || !b.telegram.bot.tokenSet)) {
    s.push("机器人异常（未运行或未配置 Token）");
  }
  if (b.tools.ffmpeg && !b.tools.ffmpeg.available) s.push("ffmpeg 不可用");
  if (b.tools.ytdlp && !b.tools.ytdlp.available) s.push("yt-dlp 不可用");
  for (const [dir, info] of Object.entries(b.disk)) {
    if (info && info.freeMB < 1024) s.push(`${dir} 剩余空间严重不足（${info.freeMB}MB）`);
  }
  if (b.logs.errors.length >= 5) s.push(`error/fatal 日志突增（${b.logs.errors.length} 条）`);
  if (b.queue.failedRecent24h >= 3) s.push(`近 24h 下载失败较多（${b.queue.failedRecent24h} 个）`);
  return s;
}

/* ------------------------------------------------------------------ */
/* AI 报告                                                             */
/* ------------------------------------------------------------------ */

export interface ProblemReport {
  generatedAt: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  signals: string[];
  symptoms: string[];
  likelyCauses: Array<{ cause: string; evidence: string; confidence: string }>;
  suggestedFixes: Array<{ area: string; file: string; why: string; fix: string }>;
  verification: string[];
  missingInfo: string[];
  markdown: string;
  file: string | null;
}

const APP_MAP_HINT =
  "项目为 tgsub（Node/TypeScript，Express + gramjs）。关键源码：" +
  "server/src/tg/client.ts（Telegram 连接/重连/心跳/会话）、server/src/tg/bot.ts（机器人）、" +
  "server/src/tg/scanner.ts（定时扫描）、server/src/tg/downloader.ts（下载队列）、" +
  "server/src/routes/media.ts（媒体库播放/流式）、server/src/ai/*（AI 功能）、" +
  "server/src/platform/*（B站/小红书/YouTube yt-dlp）。";

function compactBundle(b: DiagnosticBundle): string {
  // 控制体量：日志与列表在上限内，其余原样 JSON
  return JSON.stringify(b, null, 2);
}

function renderMarkdown(r: ProblemReport): string {
  const lines: string[] = [];
  lines.push(`# tgsub 故障报告`);
  lines.push("");
  lines.push(`- 生成时间：${r.generatedAt}`);
  lines.push(`- 严重级别：**${r.severity}**`);
  lines.push(`- 摘要：${r.summary}`);
  lines.push("");
  lines.push(`## 一、命中信号`);
  if (r.signals.length === 0) lines.push("- （无）");
  else for (const s of r.signals) lines.push(`- ${s}`);
  lines.push("");
  lines.push(`## 二、现象 / 证据`);
  if (r.symptoms.length === 0) lines.push("- （无）");
  else for (const s of r.symptoms) lines.push(`- ${s}`);
  lines.push("");
  lines.push(`## 三、可能根因（按可能性排序）`);
  if (r.likelyCauses.length === 0) lines.push("- （AI 未给出）");
  else
    for (const c of r.likelyCauses) {
      lines.push(`- **${c.cause}**（置信度：${c.confidence}）`);
      if (c.evidence) lines.push(`  - 依据：${c.evidence}`);
    }
  lines.push("");
  lines.push(`## 四、建议修复（供其他智能体执行）`);
  if (r.suggestedFixes.length === 0) lines.push("- （AI 未给出）");
  else
    for (const f of r.suggestedFixes) {
      lines.push(`- **${f.area}**${f.file ? ` · \`${f.file}\`` : ""}`);
      if (f.why) lines.push(`  - 原因：${f.why}`);
      if (f.fix) lines.push(`  - 建议：${f.fix}`);
    }
  lines.push("");
  lines.push(`## 五、验证方法`);
  if (r.verification.length === 0) lines.push("- （无）");
  else for (const v of r.verification) lines.push(`- ${v}`);
  lines.push("");
  lines.push(`## 六、需要补充的信息`);
  if (r.missingInfo.length === 0) lines.push("- （无）");
  else for (const m of r.missingInfo) lines.push(`- ${m}`);
  lines.push("");
  return lines.join("\n");
}

function reportsDir(): string {
  return path.join(env.dataDir, "reports");
}

function latestJsonPath(): string {
  return path.join(reportsDir(), "latest.json");
}

async function saveReport(r: ProblemReport): Promise<string | null> {
  try {
    const dir = reportsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = r.generatedAt.replace(/[:.]/g, "-");
    const file = path.join(dir, `report-${stamp}.md`);
    await fs.promises.writeFile(file, r.markdown, "utf8");
    await fs.promises.writeFile(latestJsonPath(), JSON.stringify(r, null, 2), "utf8");
    // 只保留最近 30 份
    const files = (await fs.promises.readdir(dir)).filter((f) => f.startsWith("report-") && f.endsWith(".md"));
    if (files.length > 30) {
      files.sort();
      for (const f of files.slice(0, files.length - 30)) {
        await fs.promises.unlink(path.join(dir, f)).catch(() => undefined);
      }
    }
    return file;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "AI 故障报告落盘失败");
    return null;
  }
}

export interface GenerateReportOptions {
  /** 触发原因（自动/手动），写进报告便于追溯 */
  reason?: string;
  /** 复用已采集的 bundle（自动看门狗里避免重复采集） */
  bundle?: DiagnosticBundle;
}

/**
 * 生成问题报告：AI 归纳后渲染 Markdown 并落盘。未启用 AI 时抛出。
 */
export async function generateProblemReport(opts: GenerateReportOptions = {}): Promise<ProblemReport> {
  if (!isAiEnabled()) throw new Error("AI 未启用或未配置 API Key（设置页 → AI 功能）");
  const b = opts.bundle ?? (await collectDiagnosticBundle());
  const reason = opts.reason ?? "手动生成";

  const system =
    "你是 tgsub 的资深故障诊断助手。" +
    APP_MAP_HINT +
    "下面给你一次运行快照：应用/容器状态、Telegram 会话与机器人状态、下载队列、工具链、磁盘、频道扫描错误、最近 warn/error 日志。" +
    "请像给『另一个负责改代码的智能体』写工单一样，基于**真实存在的证据**归纳问题，不要编造日志里没有的内容；" +
    "对不确定的地方在 confidence 里写低置信度，并放进 missingInfo。" +
    "suggestedFixes 要尽量具体到文件与函数/配置，说明为什么改、怎么改。" +
    "只输出 JSON：" +
    '{ "summary": string, "severity": "low"|"medium"|"high"|"critical", "symptoms": string[], ' +
    '"likelyCauses": [{"cause": string, "evidence": string, "confidence": "high"|"medium"|"low"}], ' +
    '"suggestedFixes": [{"area": string, "file": string, "why": string, "fix": string}], ' +
    '"verification": string[], "missingInfo": string[] }。';

  const user = `触发原因：${reason}\n运行快照(JSON)：\n${compactBundle(b)}`;

  let ai: {
    summary?: string;
    severity?: string;
    symptoms?: unknown;
    likelyCauses?: unknown;
    suggestedFixes?: unknown;
    verification?: unknown;
    missingInfo?: unknown;
  };
  try {
    ai = await callAIJson(system, user, { maxTokens: 1600, temperature: 0.2, timeoutMs: 60_000 });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "AI 故障报告生成失败");
    throw err;
  }

  const strArr = (v: unknown, max = 20): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max) : [];

  const severityRaw = String(ai.severity ?? "").toLowerCase();
  const severity: ProblemReport["severity"] =
    severityRaw === "critical" || severityRaw === "high" || severityRaw === "medium" || severityRaw === "low"
      ? (severityRaw as ProblemReport["severity"])
      : b.signals.length > 0
        ? "medium"
        : "low";

  const likelyCauses = (Array.isArray(ai.likelyCauses) ? ai.likelyCauses : [])
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => ({
      cause: String(x.cause ?? "").slice(0, 300),
      evidence: String(x.evidence ?? "").slice(0, 500),
      confidence: String(x.confidence ?? "medium").slice(0, 12),
    }))
    .filter((x) => x.cause)
    .slice(0, 8);

  const suggestedFixes = (Array.isArray(ai.suggestedFixes) ? ai.suggestedFixes : [])
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => ({
      area: String(x.area ?? "").slice(0, 120),
      file: String(x.file ?? "").slice(0, 200),
      why: String(x.why ?? "").slice(0, 500),
      fix: String(x.fix ?? "").slice(0, 800),
    }))
    .filter((x) => x.area || x.fix)
    .slice(0, 10);

  const report: ProblemReport = {
    generatedAt: b.generatedAt,
    severity,
    summary: String(ai.summary ?? "").slice(0, 800) || "AI 未返回摘要。",
    signals: b.signals,
    symptoms: strArr(ai.symptoms, 20),
    likelyCauses,
    suggestedFixes,
    verification: strArr(ai.verification, 15),
    missingInfo: strArr(ai.missingInfo, 15),
    markdown: "",
    file: null,
  };
  report.markdown = renderMarkdown(report);
  report.file = await saveReport(report);
  return report;
}

/** 读取最近一次报告（没有返回 null） */
export async function readLatestReport(): Promise<ProblemReport | null> {
  try {
    const raw = await fs.promises.readFile(latestJsonPath(), "utf8");
    return JSON.parse(raw) as ProblemReport;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 自动看门狗：有问题时自动出报告                                       */
/* ------------------------------------------------------------------ */

let lastSignature = "";

/**
 * 每 5 分钟巡检一次：若开启了 ai_autodiagnose、AI 可用、且检测到“严重信号”，
 * 就自动生成一份报告。**同一组问题只报一次**（问题消失后复位），避免重复刷额度。
 */
export function startAiDiagnoseWatchdog(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const settings = getSettings();
      if (!settings.ai_autodiagnose || !isAiEnabled()) return;
      const bundle = await collectDiagnosticBundle();
      const serious = seriousSignals(bundle);
      if (serious.length === 0) {
        lastSignature = ""; // 问题已消失，允许下次重新出报告
        return;
      }
      const signature = serious.slice().sort().join(" | ");
      if (signature === lastSignature) return; // 同一事件只报一次
      lastSignature = signature;
      const report = await generateProblemReport({ reason: "自动巡检", bundle });
      logger.warn(
        { severity: report.severity, signals: serious, file: report.file },
        "检测到异常，已自动生成 AI 故障报告",
      );
    } catch (err) {
      logger.debug?.({ err: (err as Error).message }, "AI 自动巡检跳过");
    }
  }, 5 * 60_000);
  timer.unref?.();
  return timer;
}
