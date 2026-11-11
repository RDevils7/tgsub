import { Router } from "express";
import { asyncHandler, assert } from "../lib/http";
import { resolveAiConfig, testAiConnection, isAiEnabled, callAIJson } from "../ai/client";
import { getAiKeyHint } from "../db";
import { queryLogs, type LogEntry } from "../lib/logstore";

export const aiRouter = Router();

/** 当前 AI 配置概览（key 只回掩码，绝不回明文） */
aiRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const cfg = resolveAiConfig();
    const hint = getAiKeyHint();
    res.json({
      enabled: cfg.enabled,
      configured: hint.set,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKeySet: hint.set,
      apiKeyHint: hint.hint,
    });
  }),
);

/** 发一句极短请求验证连通性；未启用 / 未配 key 直接 400 */
aiRouter.post(
  "/test",
  asyncHandler(async (_req, res) => {
    assert(isAiEnabled(), 400, "AI 未启用或未配置 API Key（设置页 → AI 功能）");
    const result = await testAiConnection();
    res.json(result);
  }),
);

/**
 * 日志智能诊断（功能 C）。
 *
 * 读内存缓冲里最近的 warn/error/fatal 日志，交给 AI 归纳「可能的原因 + 修复建议」。
 * 不读磁盘、不发送任何敏感正文（只发级别、消息、关键字段），纯文本 LLM。
 * 也可由前端把筛选后的日志贴进来（body.logs），方便针对某次故障诊断。
 */
aiRouter.post(
  "/diagnose",
  asyncHandler(async (req, res) => {
    assert(isAiEnabled(), 400, "AI 未启用或未配置 API Key（设置页 → AI 功能）");

    let entries: LogEntry[];
    const incoming = Array.isArray(req.body?.logs) ? (req.body.logs as LogEntry[]) : null;
    if (incoming && incoming.length > 0) {
      entries = incoming.slice(0, 300);
    } else {
      const level = typeof req.body?.level === "string" ? (req.body.level as never) : "warn";
      const limit = Math.min(Math.max(Number(req.body?.limit) || 250, 1), 500);
      entries = queryLogs({ level, limit }).items;
    }
    if (entries.length === 0) {
      res.json({ ok: true, empty: true, summary: "最近没有可供诊断的警告或错误日志。", issues: [], actions: [] });
      return;
    }

    const lines = entries
      .map((e) => {
        const fields = Object.entries(e.fields)
          .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
          .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 80) : v}`)
          .join(" ");
        return `[${e.level}] ${e.msg}${fields ? ` | ${fields}` : ""}`;
      })
      .join("\n");

    const system =
      "你是 tgsub（Telegram 媒体下载器）的运维助手。下面是它最近的一段日志，" +
      "级别包含 warn/error/fatal。请归纳出最可能的问题，并给出可操作的修复建议。" +
      "常见故障：403/502/503/504（网络或被限流）、Could not find the input entity（Telegram 会话失效，需重新登录）、" +
      "EROFS/EACCES（媒体目录没写权限）、下载失败重试。只输出 JSON：" +
      '{ "summary": string, "issues": [{"level": string, "topic": string, "cause": string, "fix": string}], "actions": string[] }。';
    const data = await callAIJson<{
      summary?: string;
      issues?: Array<{ level?: string; topic?: string; cause?: string; fix?: string }>;
      actions?: string[];
    }>(system, `日志：\n${lines}`, { maxTokens: 800, temperature: 0.2 });

    const issues = Array.isArray(data.issues)
      ? data.issues
          .map((it) => ({
            level: typeof it.level === "string" ? it.level : "info",
            topic: typeof it.topic === "string" ? it.topic : "未知问题",
            cause: typeof it.cause === "string" ? it.cause : "",
            fix: typeof it.fix === "string" ? it.fix : "",
          }))
          .slice(0, 12)
      : [];
    res.json({
      ok: true,
      empty: false,
      summary: typeof data.summary === "string" ? data.summary : "AI 未返回摘要。",
      issues,
      actions: Array.isArray(data.actions) ? data.actions.filter((a) => typeof a === "string").slice(0, 10) : [],
    });
  }),
);
