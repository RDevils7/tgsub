import { getSettings, getAiApiKey } from "../db";
import { logger } from "../logger";

/**
 * AI 客户端（OpenAI 兼容协议骨架）。
 *
 * 设计目标：一套代码通吃所有 OpenAI 兼容服务——OpenAI、DeepSeek、通义千问、
 * 智谱、OpenRouter，甚至本地 Ollama（base_url 指到 /v1 即可）。后续每个 AI
 * 功能（补全 NFO / 智能命名 / 日志诊断 …）都只是「组装 prompt + 调 callAI*」，
 * 不在各自模块里重复造 HTTP 请求。
 *
 * 优先级：设置里存的 key / base_url / model 优先，env（AI_API_KEY / AI_BASE_URL /
 * AI_MODEL）兜底，方便容器部署时只注入环境变量、不在界面泄露。
 */

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiConfig {
  /** 既启用又配了 key 才算真正可用 */
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export function resolveAiConfig(): AiConfig {
  const s = getSettings();
  const apiKey = getAiApiKey() || process.env.AI_API_KEY || "";
  const baseUrl = (s.ai_base_url || process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = s.ai_model || process.env.AI_MODEL || DEFAULT_MODEL;
  return {
    enabled: s.ai_enabled && Boolean(apiKey),
    baseUrl,
    model,
    apiKey,
  };
}

export function isAiEnabled(): boolean {
  return resolveAiConfig().enabled;
}

export interface CallAiOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 最基础的对话补全调用。非流式，适合短文本 / 结构化输出。
 * 出错会抛出带中文说明的 Error，调用方直接 try/catch 即可。
 */
export async function callAI(messages: AiMessage[], opts: CallAiOptions = {}): Promise<string> {
  const cfg = resolveAiConfig();
  if (!cfg.enabled) throw new Error("AI 未启用或未配置 API Key（设置页 → AI 功能）");

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1024,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI 接口返回 ${res.status}：${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return content.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.name === "AbortError") {
      throw new Error(`AI 请求超时（>${Math.round(timeoutMs / 1000)}s）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 让模型严格输出 JSON，并尽量容错地解析回来。
 * system 里会强调「只输出 JSON、不要 Markdown 代码块」，再兜底剥掉 ```json 围栏
 * 与首尾多余字符，避免某个模型非要加一句"好的，这是结果"。
 */
export async function callAIJson<T = unknown>(
  system: string,
  user: string,
  opts: CallAiOptions = {},
): Promise<T> {
  const messages: AiMessage[] = [
    {
      role: "system",
      content: `${system}\n只输出 JSON，不要任何解释文字，也不要用 Markdown 代码块包裹。`,
    },
    { role: "user", content: user },
  ];
  const raw = await callAI(messages, { ...opts, temperature: opts.temperature ?? 0.2 });
  return parseJsonSafe<T>(raw);
}

/** 尽量从模型输出里抠出合法 JSON 对象（容错：去围栏、截取首个 {...}） */
export function parseJsonSafe<T = unknown>(raw: string): T {
  let text = (raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  if (!text) throw new Error("AI 未返回可解析的 JSON");
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`AI 返回的 JSON 解析失败：${(err as Error).message}`);
  }
}

/** 轻量连通性测试：发一句极短请求，回延迟与是否拿到内容 */
export async function testAiConnection(): Promise<{
  ok: boolean;
  model: string;
  latencyMs: number;
  error?: string;
}> {
  const cfg = resolveAiConfig();
  if (!cfg.apiKey) return { ok: false, model: cfg.model, latencyMs: 0, error: "未配置 API Key" };
  const t0 = Date.now();
  try {
    const out = await callAI([{ role: "user", content: "回复两个字：可用" }], {
      timeoutMs: 15_000,
      maxTokens: 16,
      temperature: 0,
    });
    return { ok: Boolean(out), model: cfg.model, latencyMs: Date.now() - t0 };
  } catch (err) {
    logger.warn({ err }, "AI 连通性测试失败");
    return { ok: false, model: cfg.model, latencyMs: Date.now() - t0, error: (err as Error).message };
  }
}
