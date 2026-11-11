import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings } from "../types";
import { Badge, Button, Field, Toggle, useToast } from "./ui";
import CollapsibleCard from "./CollapsibleCard";
import { IconEye, IconEyeOff, IconSpark } from "./icons";

/**
 * AI 功能设置（设置页里的一张卡片）。
 *
 * 只负责「把 key / 地址 / 模型存好、能测通」，不在这里接任何具体功能——
 * 补全 NFO、智能命名、日志诊断等都只调 server/src/ai/client.ts 的 callAI*，
 * 本卡片只保证那套 client 能拿到正确的配置。
 *
 * key 走和 Emby Key 相同的加密落盘 + 掩码机制：界面只看到「已保存 ••••1234」，
 * 永远不回明文；留空保存 = 不改动，单独「清除密钥」才清掉。
 */

type Draft = Pick<AppSettings, "ai_enabled" | "ai_base_url" | "ai_model" | "ai_naming">;

export default function AiSettingsPanel() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; error?: string } | null>(
    null,
  );
  const [keySet, setKeySet] = useState(false);
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [res, status] = await Promise.all([api.settings(), api.aiStatus()]);
      setDraft({
        ai_enabled: res.settings.ai_enabled,
        ai_base_url: res.settings.ai_base_url,
        ai_model: res.settings.ai_model,
        ai_naming: res.settings.ai_naming,
      });
      setKeySet(status.apiKeySet);
      setKeyHint(status.apiKeyHint);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const body: Partial<AppSettings> & { ai_api_key?: string } = {
        ai_enabled: draft.ai_enabled,
        ai_base_url: draft.ai_base_url,
        ai_model: draft.ai_model,
        ai_naming: draft.ai_naming,
      };
      // 只有填了新 key 才带上；留空 = 不改（保留已存的）
      if (apiKey.trim()) body.ai_api_key = apiKey.trim();
      const res = await api.saveSettings(body);
      setKeySet(res.ai?.apiKeySet ?? true);
      setKeyHint(res.ai?.apiKeyHint ?? null);
      setApiKey("");
      toast.push("AI 设置已保存", "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    try {
      const res = await api.saveSettings({ ai_api_key: "" });
      setKeySet(res.ai?.apiKeySet ?? false);
      setKeyHint(res.ai?.apiKeyHint ?? null);
      setApiKey("");
      toast.push("AI API Key 已清除", "success");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.aiTest();
      setTestResult(res);
      if (res.ok) toast.push(`连通成功（${res.latencyMs}ms）`, "success");
      else toast.push(res.error || "连通测试失败", "error");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setTesting(false);
    }
  };

  const summary = draft?.ai_enabled && keySet
    ? { label: "已启用", tone: "border-emerald-500/20 bg-emerald-500/10 text-ok", dot: "bg-emerald-400" }
    : draft?.ai_enabled
      ? { label: "未配密钥", tone: "border-amber-500/20 bg-amber-500/10 text-warn", dot: "bg-amber-400" }
      : { label: "已关闭", tone: "border-white/10 bg-white/[0.04] text-slate-400", dot: "bg-slate-500" };

  return (
    <CollapsibleCard
      id="ai"
      tint="fuchsia"
      icon={<IconSpark className="h-4 w-4" />}
      title="AI 功能"
      desc="接入任意 OpenAI 兼容服务（DeepSeek / 通义 / 智谱 / Ollama …），为媒体库补全简介、智能命名、日志诊断等"
      defaultOpen={false}
      extra={
        <Badge className={summary.tone}>
          <span className={`h-1.5 w-1.5 rounded-full ${summary.dot}`} />
          {summary.label}
        </Badge>
      }
    >
      <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] pt-4">
        {/* 1. 开关 */}
        <section className="pb-5">
          <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <div className="pr-4">
              <p className="text-[13px] text-slate-200">启用 AI 功能</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                关闭后所有 AI 调用直接跳过，不消耗任何额度；具体功能（如补全 NFO）各自还有独立开关
              </p>
            </div>
            <Toggle checked={draft?.ai_enabled ?? false} onChange={(next) => patch("ai_enabled", next)} />
          </div>
        </section>

        {/* 2. 服务地址与模型 */}
        <section className="py-5">
          <p className="mb-3 text-[12px] font-semibold text-slate-300">服务地址与模型</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="API Base URL"
              hint="OpenAI 兼容协议的地址，留末尾不含 /v1 也行。例：https://api.deepseek.com/v1、http://localhost:11434/v1"
            >
              <input
                className="field font-mono text-[12.5px]"
                placeholder="https://api.openai.com/v1"
                value={draft?.ai_base_url ?? ""}
                onChange={(e) => patch("ai_base_url", e.target.value)}
              />
            </Field>
            <Field label="模型名" hint="例如 gpt-4o-mini、deepseek-chat、qwen-max">
              <input
                className="field font-mono text-[12.5px]"
                placeholder="gpt-4o-mini"
                value={draft?.ai_model ?? ""}
                onChange={(e) => patch("ai_model", e.target.value)}
              />
            </Field>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <div>
              <p className="text-[13px] text-slate-200">AI 智能命名兜底</p>
              <p className="text-[11.5px] text-slate-500">
                下载时若正则识别不出剧名但消息有视频，用 AI 再试一次。仅在「正则彻底失败」时触发，不会每条都调
              </p>
            </div>
            <Toggle checked={draft?.ai_naming ?? false} onChange={(next) => patch("ai_naming", next)} />
          </div>
        </section>

        {/* 3. API Key */}
        <section className="py-5">
          <Field
            label="AI API Key"
            hint={
              keySet
                ? `已保存 ${keyHint}，此处留空表示不修改`
                : "密钥加密落盘，界面只显示末四位；也可通过环境变量 AI_API_KEY 注入，不在界面填写"
            }
          >
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                className="field pr-10 font-mono text-[12.5px]"
                placeholder={keySet ? "留空保持不变" : "粘贴 AI 服务 API Key"}
                value={apiKey}
                autoComplete="new-password"
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition hover:text-slate-300"
                aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              >
                {showKey ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => void save()} loading={saving} disabled={!draft}>
              保存设置
            </Button>
            {keySet && (
              <Button variant="ghost" size="sm" onClick={() => void clearKey()} loading={saving}>
                清除密钥
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void test()} loading={testing}>
              测试连接
            </Button>
            {testResult && (
              <span
                className={`text-[11.5px] ${testResult.ok ? "text-ok" : "text-err"}`}
              >
                {testResult.ok
                  ? `连通成功 · ${testResult.latencyMs}ms`
                  : `失败${testResult.error ? `：${testResult.error}` : ""}`}
              </span>
            )}
          </div>
        </section>

        <p className="pt-4 text-[11px] leading-relaxed text-slate-500">
          AI 请求不经过 Telegram / m3u8 的代理设置，直接打到上面的 Base URL；如需走代理可在运行环境注入
          <code className="text-slate-400"> HTTPS_PROXY</code> 等变量。视频内容（字幕 / 封面）默认不上传，保护隐私。
        </p>
      </div>
    </CollapsibleCard>
  );
}
