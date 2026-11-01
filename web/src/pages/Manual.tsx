import { useState } from "react";
import { api } from "../api";
import type { DirectResult } from "../types";
import { Badge, Button, StatusDot, useToast } from "../components/ui";
import { IconDownload, IconLink, IconSend, IconSpark, IconVideo } from "../components/icons";

interface Entry {
  key: string;
  link: string;
  status: "pending" | "running" | "ok" | "error";
  result?: DirectResult;
  error?: string;
}

const EXAMPLES = [
  "https://t.me/频道用户名/12345",
  "https://t.me/c/1234567890/678   （私有频道，前面带 c/）",
];

/** 从粘贴的内容里拆出所有链接：一行一个、空格分隔、混合文字都能认 */
function splitLinks(raw: string): string[] {
  const found = raw.match(/(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/\S+/gi) ?? [];
  const cleaned = found.map((s) => s.replace(/[，,。；;、）)】]+$/, "").trim());
  return [...new Set(cleaned.filter(Boolean))];
}

export default function Manual() {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  const links = splitLinks(input);

  const start = async () => {
    if (!links.length) {
      toast.push("没找到 Telegram 链接，示例：https://t.me/频道名/123", "error");
      return;
    }
    setRunning(true);
    const initial: Entry[] = links.map((link) => ({ key: link, link, status: "pending" }));
    setEntries(initial);

    let queued = 0;
    for (let i = 0; i < initial.length; i += 1) {
      const entry = initial[i];
      setEntries((prev) => prev.map((e) => (e.key === entry.key ? { ...e, status: "running" } : e)));
      try {
        const { item } = await api.downloadLink({ link: entry.link });
        queued += item.queued;
        setEntries((prev) =>
          prev.map((e) => (e.key === entry.key ? { ...e, status: "ok", result: item } : e)),
        );
      } catch (err) {
        setEntries((prev) =>
          prev.map((e) => (e.key === entry.key ? { ...e, status: "error", error: (err as Error).message } : e)),
        );
      }
    }

    setRunning(false);
    toast.push(queued > 0 ? `已入队 ${queued} 个文件，去「下载记录」看进度` : "解析完成，没有新的下载任务", queued > 0 ? "success" : "info");
  };

  const okCount = entries.filter((e) => e.status === "ok").length;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border border-brand-500/25 bg-brand-500/10 text-brand-300">
              <IconLink className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-[13.5px] font-medium text-slate-100">粘贴 Telegram 消息链接</h3>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">
                不判断订阅关键词，直接把这条消息里的文件（含相册整组）加入下载队列。
                命名规则、封面与 Emby 元信息跟自动扫描完全一致。
              </p>
            </div>
          </div>
          <Badge className="!bg-white/[0.04] !text-slate-400 !border-white/[0.08]">
            <IconVideo className="h-3 w-3" /> 支持相册整组
          </Badge>
        </div>

        <div className="mt-3">
          <textarea
            className="field min-h-[104px] resize-y font-mono text-[12px] leading-relaxed"
            placeholder={"每行一个链接，例如：\nhttps://t.me/asc2256/10500"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void start();
            }}
            spellCheck={false}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">
              已识别 <span className="text-slate-300">{links.length}</span> 个链接
              {links.length > 0 && <span className="text-slate-600"> · Ctrl+Enter 直接开始</span>}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setInput("")}
                disabled={!input || running}
              >
                清空
              </Button>
              <Button onClick={() => void start()} loading={running} disabled={links.length === 0}>
                <IconSend className="h-3.5 w-3.5" />
                开始下载
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-white/[0.06] bg-black/20 p-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 flex items-center gap-1 text-[10.5px] tracking-wide text-slate-500">
              <IconSpark className="h-3 w-3" /> 链接格式
            </p>
            <ul className="space-y-0.5">
              {EXAMPLES.map((example) => (
                <li key={example} className="font-mono text-[10.5px] leading-relaxed text-slate-400">
                  {example}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-[10.5px] tracking-wide text-slate-500">说明</p>
            <ul className="space-y-0.5 break-words text-[10.5px] leading-relaxed text-slate-400">
              <li>· 公开频道用 https://t.me/用户名/消息ID</li>
              <li>· 私有频道用 https://t.me/c/频道ID/消息ID（手机端「复制链接」就是这个格式）</li>
              <li>· 未添加过的频道会自动加入列表，但保持停用，不参与定时扫描</li>
            </ul>
          </div>
        </div>
      </div>

      {entries.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5 text-[11.5px] text-slate-500">
            <span>
              本次解析 {entries.length} 个链接 · 成功 {okCount}
            </span>
            <a className="text-brand-300 hover:text-brand-200" href="#/downloads">
              去下载记录看进度 →
            </a>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {entries.map((entry) => (
              <div key={entry.key} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-300" title={entry.link}>
                    {entry.link}
                  </p>
                  {entry.status === "pending" && (
                    <Badge className="border-white/10 bg-white/5 text-slate-400">
                      <StatusDot className="bg-slate-500" /> 等待
                    </Badge>
                  )}
                  {entry.status === "running" && (
                    <Badge className="border-brand-500/25 bg-brand-500/10 text-brand-300">
                      <StatusDot className="bg-brand-400" /> 解析中
                    </Badge>
                  )}
                  {entry.status === "ok" && entry.result && (
                    <Badge
                      className={
                        entry.result.queued > 0
                          ? "border-emerald-500/20 bg-emerald-500/10 text-ok"
                          : "border-white/10 bg-white/5 text-slate-400"
                      }
                    >
                      <StatusDot className={entry.result.queued > 0 ? "bg-emerald-400" : "bg-slate-500"} />
                      {entry.result.queued > 0
                        ? "已入队"
                        : entry.result.existing > 0
                          ? "已存在"
                          : "已跳过"}
                    </Badge>
                  )}
                  {entry.status === "error" && (
                    <Badge className="border-rose-500/20 bg-rose-500/10 text-err">
                      <StatusDot className="bg-rose-400" /> 失败
                    </Badge>
                  )}
                </div>

                {entry.result && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    <span className="text-slate-300">{entry.result.channelTitle}</span>
                    <span className="text-slate-700">·</span>
                    <span className="font-mono">#{entry.result.messageId}</span>
                    <span className="text-slate-700">·</span>
                    <span>{entry.result.files} 个文件</span>
                    {entry.result.queued > 0 && (
                      <>
                        <span className="text-slate-700">·</span>
                        <span className="text-ok">入队 {entry.result.queued}</span>
                      </>
                    )}
                    {entry.result.existing > 0 && (
                      <>
                        <span className="text-slate-700">·</span>
                        <span>已下载过 {entry.result.existing}</span>
                      </>
                    )}
                    {entry.result.skipped > 0 && (
                      <>
                        <span className="text-slate-700">·</span>
                        <span className="text-warn/80">跳过 {entry.result.skipped}</span>
                      </>
                    )}
                    {entry.result.saveDir && (
                      <>
                        <span className="text-slate-700">·</span>
                        <span className="truncate font-mono text-[10.5px] text-slate-400" title={entry.result.saveDir}>
                          {entry.result.saveDir}/
                        </span>
                      </>
                    )}
                  </div>
                )}

                {entry.result?.title && (
                  <p className="mt-1 truncate text-[11px] text-slate-400" title={entry.result.title}>
                    📄 {entry.result.title}
                  </p>
                )}
                {entry.result?.autoAdded && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    ℹ️ 该频道已加入频道列表并保持停用，需要定时扫描可在「频道」页面启用
                  </p>
                )}
                {entry.error && <p className="mt-1.5 text-[11px] leading-relaxed text-err/80">{entry.error}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {entries.length === 0 && (
        <div className="card flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-slate-500">
            <IconDownload className="h-5 w-5" />
          </span>
          <p className="text-[13px] text-slate-300">还没有提交链接</p>
          <p className="max-w-md text-[11.5px] leading-relaxed text-slate-500">
            在上面粘贴链接后点「开始下载」。也可以用手机把链接发给 Telegram 机器人，同样会立即开始下载。
          </p>
        </div>
      )}
    </div>
  );
}
