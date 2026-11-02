import { useState } from "react";
import { api } from "../api";
import type { DirectResult, PlatformChoiceInfo, PlatformTaskResponse } from "../types";
import { Badge, Button, Modal, StatusDot, useToast } from "../components/ui";
import { IconDownload, IconLink, IconSend, IconSpark, IconVideo } from "../components/icons";
import { formatBytes, formatDuration } from "../utils";

type LinkKind = "telegram" | "platform";

interface Entry {
  key: string;
  link: string;
  kind: LinkKind;
  status: "pending" | "running" | "choosing" | "ok" | "error" | "cancel";
  result?: DirectResult;
  platform?: PlatformTaskResponse;
  error?: string;
}

const PLATFORM_LABEL: Record<string, string> = {
  bilibili: "B站",
  douyin: "抖音",
  xiaohongshu: "小红书",
  youtube: "YouTube",
};

const EXAMPLES = [
  "https://t.me/频道用户名/12345",
  "https://b23.tv/29inbIp",
  "https://v.douyin.com/dVS6cveLVCw/",
  "https://xhslink.cn/o/8c7hpV57rvQ",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
];

/** 只认这几个平台的域名，避免把任意链接都当第三方任务提交 */
const PLATFORM_HOST_RE =
  /(?:^|\.)(?:bilibili\.com|b23\.tv|bili2233\.cn|douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.com|xhslink\.cn|youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

/**
 * 从分享口令里捞链接。
 *
 * App 里「复制链接」出来的是整段文字，链接被尖括号包着、紧贴中文，
 * 例如「【标题-哔哩哔哩】 <https://b23.tv/29inbIp>」，按空白切词会把
 * 尖括号一起带进来。这里改成按字符集扫，规则和后端 detect.ts 保持一致。
 */
const URL_RE =
  /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>"'“”‘’（）【】《》，。；：、！？…]*)?/gi;

function cleanUrl(raw: string): string {
  return raw
    .trim()
    .replace(/^[<（(“"‘【《]+/, "")
    .replace(/[>）)】》”"’》。，,；;、！!？?…]+$/g, "")
    .replace(/[.:]+$/, "");
}

/** 从粘贴的内容里拆出所有链接：整段分享口令、一行一个、混合文字都能认 */
function splitLinks(raw: string): Array<{ link: string; kind: LinkKind }> {
  const out: Array<{ link: string; kind: LinkKind }> = [];
  const seen = new Set<string>();
  const push = (link: string, kind: LinkKind): void => {
    if (!link || seen.has(link)) return;
    seen.add(link);
    out.push({ link, kind });
  };

  for (const hit of raw.match(URL_RE) ?? []) {
    const cleaned = cleanUrl(hit);
    if (!cleaned) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      continue; // 不是链接，忽略
    }
    if (/^(?:www\.)?(?:t|telegram)\.me$/i.test(url.hostname)) push(withScheme, "telegram");
    else if (PLATFORM_HOST_RE.test(url.hostname)) push(url.toString(), "platform");
  }
  return out;
}

export default function Manual() {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  /** 合集 / 多P 的二选一：弹窗时挂起 await，用户点按钮后 resolve */
  const [ask, setAsk] = useState<{
    link: string;
    choice: PlatformChoiceInfo;
    resolve: (mode: "one" | "all" | "cancel") => void;
  } | null>(null);
  const toast = useToast();

  const links = splitLinks(input);
  const platformLinks = links.filter((l) => l.kind === "platform");

  const askPlaylist = (link: string, choice: PlatformChoiceInfo): Promise<"one" | "all" | "cancel"> =>
    new Promise((resolve) => setAsk({ link, choice, resolve }));

  const decide = (mode: "one" | "all" | "cancel") => {
    const current = ask;
    setAsk(null);
    current?.resolve(mode);
  };

  const start = async () => {
    if (!links.length) {
      toast.push("没找到可识别的链接：支持 Telegram 消息链接与 B站 / 抖音 / 小红书 / YouTube", "error");
      return;
    }
    setRunning(true);
    const initial: Entry[] = links.map((l) => ({ key: l.link, link: l.link, kind: l.kind, status: "pending" }));
    setEntries(initial);

    let queued = 0;
    let platformQueued = 0;
    let platformExisting = 0;
    for (let i = 0; i < initial.length; i += 1) {
      const entry = initial[i];
      setEntries((prev) => prev.map((e) => (e.key === entry.key ? { ...e, status: "running" } : e)));
      try {
        if (entry.kind === "platform") {
          let res = await api.platformTask(entry.link);
          if (res.needsChoice) {
            // 合集 / 多P：先问再下，避免一条链接悄悄拉 200 个视频
            setEntries((prev) => prev.map((e) => (e.key === entry.key ? { ...e, status: "choosing" } : e)));
            const mode = await askPlaylist(entry.link, res.choice);
            if (mode === "cancel") {
              setEntries((prev) =>
                prev.map((e) => (e.key === entry.key ? { ...e, status: "cancel", error: "已取消：合集没有下载" } : e)),
              );
              continue;
            }
            res = await api.platformTask(entry.link, mode);
          }
          if (res.needsChoice) continue;
          platformQueued += res.queued;
          platformExisting += res.existing;
          setEntries((prev) => prev.map((e) => (e.key === entry.key ? { ...e, status: "ok", platform: res } : e)));
        } else {
          const { item } = await api.downloadLink({ link: entry.link });
          queued += item.queued;
          setEntries((prev) =>
            prev.map((e) => (e.key === entry.key ? { ...e, status: "ok", result: item } : e)),
          );
        }
      } catch (err) {
        setEntries((prev) =>
          prev.map((e) => (e.key === entry.key ? { ...e, status: "error", error: (err as Error).message } : e)),
        );
      }
    }

    setRunning(false);
    const parts: string[] = [];
    if (queued > 0) parts.push(`Telegram ${queued} 个文件`);
    if (platformQueued > 0) parts.push(`${platformQueued} 个第三方视频`);
    if (platformExisting > 0) parts.push(`${platformExisting} 个已在队列`);
    toast.push(
      parts.length ? `已入队 ${parts.join("、")}，去「下载记录」看进度` : "解析完成，没有新的下载任务",
      parts.length ? "success" : "info",
    );
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
              <h3 className="text-[13.5px] font-medium text-slate-100">粘贴链接下载</h3>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">
                Telegram 消息链接直接把这条消息里的文件（含相册整组）加入队列；
                B站 / 抖音 / 小红书 / YouTube 交给 yt-dlp 解析后下载。命名、封面与 Emby 元信息跟自动扫描一致。
              </p>
            </div>
          </div>
          <Badge className="!bg-white/[0.04] !text-slate-400 !border-white/[0.08]">
            <IconVideo className="h-3 w-3" /> 相册整组 · 四平台分享口令
          </Badge>
        </div>

        <div className="mt-3">
          <textarea
            className="field min-h-[104px] resize-y font-mono text-[12px] leading-relaxed"
            placeholder={"每行一个链接，或直接粘整段分享口令，例如：\n【标题-哔哩哔哩】 <https://b23.tv/29inbIp>"}
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
              {platformLinks.length > 0 && (
                <span className="text-slate-600">（含第三方 {platformLinks.length} 个）</span>
              )}
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
              <li>· B站 / 抖音 / 小红书 / YouTube 可以直接粘视频链接或短链（b23.tv、v.douyin.com、xhslink.cn、youtu.be）</li>
              <li>· 也可以把 App 里「复制链接」的整段分享口令原样粘进来，说明文字会自动忽略</li>
              <li>· 合集 / 多P 链接会先弹窗问「只下第一个」还是「全部下载」，最多展开 200 个</li>
              <li>· 各平台的 Cookie 在设置 → 第三方平台里填，缺了会影响清晰度和成功率</li>
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
                  {entry.status === "choosing" && (
                    <Badge className="border-amber-500/25 bg-amber-500/10 text-warn">
                      <StatusDot className="bg-amber-400" /> 待选择
                    </Badge>
                  )}
                  {entry.kind === "platform" && (
                    <Badge className="border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-200">
                      {PLATFORM_LABEL[entry.platform?.platform ?? ""] ?? "第三方"}
                    </Badge>
                  )}
                  {entry.status === "ok" && (entry.result || entry.platform) && (
                    <Badge
                      className={
                        (entry.platform ? entry.platform.queued > 0 : (entry.result?.queued ?? 0) > 0)
                          ? "border-emerald-500/20 bg-emerald-500/10 text-ok"
                          : "border-white/10 bg-white/5 text-slate-400"
                      }
                    >
                      <StatusDot
                        className={
                          (entry.platform ? entry.platform.queued > 0 : (entry.result?.queued ?? 0) > 0)
                            ? "bg-emerald-400"
                            : "bg-slate-500"
                        }
                      />
                      {entry.platform
                        ? entry.platform.queued > 0
                          ? entry.platform.playlist
                            ? `已入队 ${entry.platform.queued} 个`
                            : "已入队"
                          : entry.platform.existing > 0
                            ? "已在队列"
                            : "已跳过"
                        : entry.result!.queued > 0
                          ? "已入队"
                          : entry.result!.existing > 0
                            ? "已存在"
                            : "已跳过"}
                    </Badge>
                  )}
                  {entry.status === "error" && (
                    <Badge className="border-rose-500/20 bg-rose-500/10 text-err">
                      <StatusDot className="bg-rose-400" /> 失败
                    </Badge>
                  )}
                  {entry.status === "cancel" && (
                    <Badge className="border-white/10 bg-white/5 text-slate-400">
                      <StatusDot className="bg-slate-500" /> 已取消
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
                {entry.platform && entry.platform.tasks[0] && (
                  <>
                    <p className="mt-1 truncate text-[11.5px] text-slate-300" title={entry.platform.tasks[0].title}>
                      {entry.platform.tasks[0].title}
                      {entry.platform.tasks.length > 1 ? ` 等 ${entry.platform.tasks.length} 个` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                      {entry.platform.tasks[0].uploader && <span>{entry.platform.tasks[0].uploader}</span>}
                      {entry.platform.tasks[0].duration ? (
                        <>
                          <span className="text-slate-700">·</span>
                          <span>{formatDuration(entry.platform.tasks[0].duration)}</span>
                        </>
                      ) : null}
                      {entry.platform.tasks[0].filesize ? (
                        <>
                          <span className="text-slate-700">·</span>
                          <span>{formatBytes(entry.platform.tasks[0].filesize)}</span>
                        </>
                      ) : null}
                      <span className="text-slate-700">·</span>
                      <span
                        className="truncate font-mono text-[10.5px] text-slate-400"
                        title={entry.platform.tasks[0].saveDir}
                      >
                        {entry.platform.tasks[0].saveDir}/
                      </span>
                    </div>
                    {entry.platform.playlist && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        📚 这是个合集，共 {entry.platform.playlist.count} 个视频 ·{" "}
                        {entry.platform.playlist.mode === "all"
                          ? `已整份入队 ${entry.platform.tasks.length} 个`
                          : "只下了第一个"}
                        {entry.platform.playlist.capped ? "（超过 200 个，只取前 200）" : ""}
                      </p>
                    )}
                  </>
                )}
                {entry.error && (
                  <p
                    className={`mt-1.5 text-[11px] leading-relaxed ${
                      entry.status === "cancel" ? "text-slate-500" : "text-err/80"
                    }`}
                  >
                    {entry.error}
                  </p>
                )}
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
            在上面粘贴 Telegram 消息链接或 B站 / 抖音 / 小红书 / YouTube 视频链接后点「开始下载」。
            也可以用手机把链接发给 Telegram 机器人，同样会立即开始下载。
          </p>
        </div>
      )}

      <Modal
        open={Boolean(ask)}
        onClose={() => decide("cancel")}
        title="这条链接是个合集"
        description="要只下这一个，还是整份都下载？选错可以在下载记录里随时停掉。"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => decide("cancel")}>
              取消
            </Button>
            <Button size="sm" variant="ghost" onClick={() => decide("one")}>
              只下第一个
            </Button>
            <Button size="sm" onClick={() => decide("all")}>
              全部下载 {ask?.choice.count ?? 0} 个
            </Button>
          </>
        }
      >
        {ask && (
          <div className="space-y-3">
            <p className="break-words text-[12px] text-slate-500">{ask.link}</p>
            <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
              <p className="text-[12.5px] font-medium text-slate-200">📚 {ask.choice.title}</p>
              <p className="mt-1 text-[11.5px] text-slate-400">
                共 {ask.choice.count} 个视频
                {ask.choice.capped ? "（超过 200 个，只读前 200 个）" : ""}
                {PLATFORM_LABEL[ask.choice.platform] ? ` · ${PLATFORM_LABEL[ask.choice.platform]}` : ""}
              </p>
              {ask.choice.firstTitle && (
                <p className="mt-2 truncate text-[11px] text-slate-500" title={ask.choice.firstTitle}>
                  第一个：{ask.choice.firstTitle}
                  {ask.choice.firstDuration ? ` · ${formatDuration(ask.choice.firstDuration)}` : ""}
                  {ask.choice.firstFilesize ? ` · ${formatBytes(ask.choice.firstFilesize)}` : ""}
                </p>
              )}
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              每个视频会单独建一个目录、单独写一份 Emby 信息；整份下载时如果中途不想继续，可以在「下载记录」里逐条停止。
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
