import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { AppSettings } from "../types";
import { Badge, Button, Toggle, useToast } from "./ui";
import CollapsibleCard from "./CollapsibleCard";
import EmbyNotifyPanel, { type EmbyNotifyState } from "./EmbyNotifyPanel";
import FfmpegStatusPanel from "./FfmpegStatusPanel";
import { IconAlert, IconSpark, IconTv } from "./icons";

/**
 * Emby 媒体库设置（设置页里的一张卡片）。
 *
 * 内容原来单独占一页，后来收进设置页；1.3.17 起再把三块合成**一张**可折叠卡片：
 * 只有一个标题栏、一个展开箭头、一个汇总状态徽章，展开后三节用分隔线排开。
 *   1. 生成什么（nfo / 封面 / 落盘结构）
 *   2. 怎么通知 Emby（入库通知，自带草稿与保存）
 *   3. Emby 端还需要做什么（说明）
 */

type Draft = Pick<AppSettings, "emby_meta" | "fallback_folder" | "auto_cover_frames" | "ffmpeg_path">;

type SectionTint = "violet" | "emerald" | "amber";

const SECTION_TINT: Record<SectionTint, string> = {
  violet: "border-violet-500/20 bg-violet-500/10 text-violet-300",
  emerald: "border-emerald-500/20 bg-emerald-500/10 text-ok",
  amber: "border-amber-500/20 bg-amber-500/10 text-warn",
};

/** 卡内小节标题：比卡片标题矮一级，不带自己的折叠箭头 */
function SectionHead({
  tint,
  icon,
  title,
  desc,
}: {
  tint: SectionTint;
  icon: ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${SECTION_TINT[tint]}`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold text-slate-100">{title}</h3>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500">{desc}</p>
      </div>
    </div>
  );
}

export default function EmbySettingsPanel() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notifyState, setNotifyState] = useState<EmbyNotifyState | null>(null);
  /** 卡片收起时入库面板不挂载，徽章仍要显示真实状态，所以外层自己兜一份 */
  const [notifyFallback, setNotifyFallback] = useState<{ enabled: boolean; configured: boolean } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  /** 改完 ffmpeg 路径保存后，让状态面板重新检测（用 key 强制重建） */
  const [ffmpegToken, setFfmpegToken] = useState(0);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [res, embyStatus] = await Promise.all([api.settings(), api.embyStatus()]);
      setDraft({
        emby_meta: res.settings.emby_meta,
        fallback_folder: res.settings.fallback_folder,
        auto_cover_frames: res.settings.auto_cover_frames,
        ffmpeg_path: res.settings.ffmpeg_path,
      });
      setNotifyFallback({
        enabled: !!res.settings.emby_notify,
        configured: !!embyStatus.configured,
      });
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleNotifyState = useCallback((next: EmbyNotifyState) => setNotifyState(next), []);

  const patch = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.saveSettings(draft as never);
      toast.push("Emby 媒体信息设置已保存", "success");
      setFfmpegToken((n) => n + 1);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  // 整张卡只有一个状态徽章：两项都开且入库配置齐全才算「已启用」
  const metaOn = !!draft?.emby_meta;
  const notifyOn = notifyState?.enabled ?? notifyFallback?.enabled ?? false;
  const notifyReady = notifyState?.configured ?? notifyFallback?.configured ?? false;
  const summary =
    metaOn && notifyOn && notifyReady
      ? { label: "已启用", tone: "border-emerald-500/20 bg-emerald-500/10 text-ok", dot: "bg-emerald-400" }
      : metaOn || notifyOn
        ? { label: "部分启用", tone: "border-amber-500/20 bg-amber-500/10 text-warn", dot: "bg-amber-400" }
        : { label: "已关闭", tone: "border-white/10 bg-white/[0.04] text-slate-400", dot: "bg-slate-500" };
  const notifyLabel =
    notifyState?.label ?? (!notifyOn ? "未启用" : notifyReady ? "已启用" : "配置不完整");
  const summaryTitle = `媒体信息：${metaOn ? "已开启" : "已关闭"} · 入库通知：${notifyLabel}`;

  return (
    <CollapsibleCard
      id="emby"
      tint="violet"
      icon={<IconSpark className="h-4 w-4" />}
      title="Emby 媒体信息与入库通知"
      desc="生成 nfo / 封面、下载完成通知 Emby 增量扫描，以及 Emby 端要打开的设置"
      defaultOpen={false}
      extra={
        <Badge className={summary.tone} title={summaryTitle}>
          <span className={`h-1.5 w-1.5 rounded-full ${summary.dot}`} />
          {summary.label}
        </Badge>
      }
    >
      <div className="divide-y divide-white/[0.06] border-t border-white/[0.06] pt-4">
        {/* 1. 生成什么 */}
        <section className="pb-5">
          <SectionHead
            tint="violet"
            icon={<IconSpark className="h-3.5 w-3.5" />}
            title="1 · 生成什么"
            desc="边下边写 nfo 与封面，Emby 扫描即出海报、简介与集数"
          />

          <div className="mt-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <div className="pr-4">
              <p className="text-[13px] text-slate-200">生成 Emby 媒体信息</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                每集写入「剧名S01E04.nfo」与缩略图，剧集目录写入 tvshow.nfo 与取自第一集的 poster / landscape / fanart；开启后消息里的图片不再下载
              </p>
            </div>
            <Toggle checked={draft?.emby_meta ?? false} onChange={(next) => patch("emby_meta", next)} />
          </div>

          <div className="mt-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <div className="pr-4">
              <p className="text-[13px] text-slate-200">认不出标题时一链接一文件夹</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                正文里没有《剧名》这类标题的视频，单独建一个文件夹，名字取正文首行；关掉则退回按频道建的模板路径
              </p>
            </div>
            <Toggle
              checked={draft?.fallback_folder ?? false}
              onChange={(next) => patch("fallback_folder", next)}
            />
          </div>

          <div className="mt-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <div className="pr-4">
              <p className="text-[13px] text-slate-200">自动生成封面与缩略图</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                每集下载完成后生成这一集的缩略图（
                <code className="text-slate-400">剧名S01E04-thumb.jpg</code>）；剧集目录的 poster / landscape / fanart
                取自第一集。<span className="text-slate-400">第三方平台优先用官方封面，官方图太小或拿不到才截帧</span>；
                比例不符时画面完整保留，空出来的边用同一张图的模糊版填满。
              </p>
            </div>
            <Toggle
              checked={draft?.auto_cover_frames ?? false}
              onChange={(next) => patch("auto_cover_frames", next)}
            />
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500">ffmpeg 路径</span>
              <input
                className="field font-mono text-[12.5px]"
                placeholder="留空自动查找，例如 C:/ffmpeg/bin/ffmpeg.exe"
                value={draft?.ffmpeg_path ?? ""}
                onChange={(e) => patch("ffmpeg_path", e.target.value)}
              />
              <span className="mt-1 block text-[10.5px] text-slate-600">
                用于截帧与生成封面；留空自动使用内置二进制或系统 PATH 里的 ffmpeg
              </span>
            </label>
            <FfmpegStatusPanel key={ffmpegToken} configuredPath={draft?.ffmpeg_path ?? ""} />
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">落盘结构</p>
              <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-400">{`美人局/
  美人局S01E01.mp4
  美人局S01E01.nfo
  美人局S01E01-thumb.jpg    ← 每集各自的截图
  美人局S01E02.mp4
  美人局S01E02-thumb.jpg
  tvshow.nfo
  poster.jpg  landscape.jpg  fanart.jpg   ← 取自第一集`}</pre>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button variant="primary" size="sm" onClick={() => void save()} loading={saving} disabled={!draft}>
              保存设置
            </Button>
          </div>
        </section>

        {/* 2. 入库通知：服务地址、API Key、路径映射与推送流水（自己管自己的保存） */}
        <section className="py-5">
          <SectionHead
            tint="emerald"
            icon={<IconTv className="h-3.5 w-3.5" />}
            title="2 · 入库通知"
            desc="每集下载完成后把路径提交给 Emby 的 /Library/Media/Updated 接口，Emby 立刻增量扫描，不用等定时任务也不用手动点扫描"
          />
          <div className="mt-3">
            <EmbyNotifyPanel embedded onState={handleNotifyState} />
          </div>
        </section>

        {/* 3. Emby 端还要做什么 */}
        <section className="pt-5">
          <SectionHead
            tint="amber"
            icon={<IconAlert className="h-3.5 w-3.5" />}
            title="3 · Emby 端还要做三件事"
            desc="少了这几步，nfo 和封面写对了 Emby 也不会用"
          />

          <ol className="mt-3 space-y-2">
            {[
              "媒体库类型选「电影」或「电视节目」，指向下载目录；路径要和容器里看到的一致（不一样就填上面的「路径映射」）。",
              "媒体库 → 高级 → 勾选「优先使用本地元数据 / 启用 NFO」，否则 Emby 会先联网刮削再读 nfo，把标题简介盖掉。",
              "同一媒体库里如果有真实剧集，建议给下载目录单独建一个库，避免 tgsub 生成的 tvshow.nfo 干扰其它剧的集数识别。",
            ].map((text, index) => (
              <li key={text} className="flex gap-2 text-[11.5px] leading-relaxed text-slate-400">
                <span className="shrink-0 font-mono text-slate-500">{index + 1}.</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>

          <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            上面填好地址与 API Key 后，「Emby 媒体库」页就能直接浏览、播放这些内容；入库通知只负责「告诉 Emby 有新文件」，不会替你改媒体库配置。
          </p>
        </section>
      </div>
    </CollapsibleCard>
  );
}
