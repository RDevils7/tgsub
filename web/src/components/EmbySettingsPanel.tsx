import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings } from "../types";
import { Badge, Button, Toggle, useToast } from "./ui";
import CollapsibleCard from "./CollapsibleCard";
import EmbyNotifyPanel from "./EmbyNotifyPanel";
import FfmpegStatusPanel from "./FfmpegStatusPanel";
import { IconAlert, IconSpark, IconTv } from "./icons";

/**
 * Emby 媒体库设置（设置页里的一组卡片）。
 *
 * 内容原来单独占一页，现在 Emby 那一页留给「看片」（媒体库海报墙），
 * 生成什么、怎么通知、Emby 端要做什么这些配置统一收到设置页。
 *
 * 三块：
 *   1. 生成什么（nfo / 封面 / 落盘结构）
 *   2. 怎么通知 Emby（入库通知，自带草稿与保存）
 *   3. Emby 端还需要做什么（说明，不可折叠）
 */

type Draft = Pick<AppSettings, "emby_meta" | "fallback_folder" | "auto_cover_frames" | "ffmpeg_path">;

export default function EmbySettingsPanel() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  /** 改完 ffmpeg 路径保存后，让状态面板重新检测（用 key 强制重建） */
  const [ffmpegToken, setFfmpegToken] = useState(0);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api.settings();
      setDraft({
        emby_meta: res.settings.emby_meta,
        fallback_folder: res.settings.fallback_folder,
        auto_cover_frames: res.settings.auto_cover_frames,
        ffmpeg_path: res.settings.ffmpeg_path,
      });
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
      await api.saveSettings(draft as never);
      toast.push("Emby 媒体信息设置已保存", "success");
      setFfmpegToken((n) => n + 1);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    // 三块内容共用一个框：外层画卡片外壳与分隔线，里面的块一律 flat
    <section className="card divide-y divide-white/[0.06] overflow-hidden">
      <CollapsibleCard
        id="emby-meta"
        flat
        tint="violet"
        icon={<IconSpark className="h-4 w-4" />}
        title="Emby 媒体信息"
        desc="边下边写 nfo 与封面，Emby 扫描即出海报、简介与集数"
        defaultOpen={false}
        extra={
          <Badge
            className={
              draft?.emby_meta
                ? "border-emerald-500/20 bg-emerald-500/10 text-ok"
                : "border-white/10 bg-white/[0.04] text-slate-400"
            }
          >
            {draft?.emby_meta ? "已开启" : "已关闭"}
          </Badge>
        }
      >
        <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
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
      </CollapsibleCard>

      {/* 入库通知：服务地址、API Key、路径映射与推送流水（自己管自己的保存） */}
      <EmbyNotifyPanel flat />

      <div className="p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-300">
            <IconTv className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-white">Emby 端还要做三件事</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">少了这几步，nfo 和封面写对了 Emby 也不会用</p>
          </div>
        </div>

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
          <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/80" />
          上面填好地址与 API Key 后，「Emby 媒体库」页就能直接浏览、播放这些内容；入库通知只负责「告诉 Emby 有新文件」，不会替你改媒体库配置。
        </p>
      </div>
    </section>
  );
}
