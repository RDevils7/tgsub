import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Channel } from "../types";
import { Badge, Button, EmptyState, Modal, Spinner, StatusDot, Toggle, useToast } from "../components/ui";
import { IconAlert, IconBroadcast, IconPlay, IconPlus, IconRefresh, IconTrash } from "../components/icons";
import { formatRelative } from "../utils";

function ChannelAvatar({ title }: { title: string }) {
  const initial = (title || "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?";
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-[14px] font-semibold text-onbrand shadow-glow">
      {initial}
    </div>
  );
}

export default function Channels() {
  const [items, setItems] = useState<Channel[] | null>(null);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Channel | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api.channels();
      setItems(res.items);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    const value = input.trim();
    if (!value) {
      toast.push("请输入频道 @用户名、t.me 链接或频道 ID", "error");
      return;
    }
    setAdding(true);
    try {
      const res = await api.addChannel(value);
      setInput("");
      toast.push(`已添加「${res.channel.title}」`, "success");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (channel: Channel, enabled: boolean) => {
    setItems((prev) => prev?.map((c) => (c.id === channel.id ? { ...c, enabled: enabled ? 1 : 0 } : c)) ?? prev);
    try {
      await api.updateChannel(channel.id, { enabled });
    } catch (err) {
      toast.push((err as Error).message, "error");
      await load();
    }
  };

  const scanOne = async (channel: Channel) => {
    setBusyId(channel.id);
    try {
      const res = await api.scanChannel(channel.id);
      if (res.error) toast.push(`${channel.title}：${res.error}`, "error");
      else
        toast.push(
          `「${channel.title}」扫描 ${res.scanned} 条，命中 ${res.matched} 条，入队 ${res.queued} 个文件`,
          "success",
        );
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  };

  const resetCursor = async (channel: Channel) => {
    try {
      await api.updateChannel(channel.id, { resetCursor: true });
      toast.push("已重置扫描游标，下次扫描会重新检查最近消息", "success");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteChannel(pendingDelete.id);
      toast.push("频道已删除", "success");
      setPendingDelete(null);
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="label">添加频道</label>
            <input
              className="field"
              placeholder="@channel_username  或  https://t.me/channel_username"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !adding) void handleAdd();
              }}
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
              私有频道请先在自己的 Telegram 中关注，可直接粘贴 t.me/+ 邀请链接（会自动加入）。
            </p>
          </div>
          <Button variant="primary" onClick={handleAdd} loading={adding} className="sm:mb-[22px]">
            {!adding && <IconPlus className="h-3.5 w-3.5" />}
            添加频道
          </Button>
        </div>
      </div>

      {items === null ? (
        <div className="flex h-48 items-center justify-center text-slate-500">
          <Spinner className="h-5 w-5" />
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<IconBroadcast className="h-5 w-5" />}
            title="还没有监控任何频道"
            description="添加频道后，系统会按设定的间隔扫描新消息，命中关键词的文件将自动下载。"
          />
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((channel, i) => (
            <div
              key={channel.id}
              className="card card-hover animate-fade-up p-4"
              style={{ animationDelay: `${i * 35}ms` }}
            >
              <div className="flex flex-wrap items-start gap-3">
                <ChannelAvatar title={channel.title} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-[14px] font-medium text-white">{channel.title}</h3>
                    {channel.username && <span className="text-[12px] text-slate-500">@{channel.username}</span>}
                    {channel.enabled ? (
                      <Badge className="border-emerald-500/20 bg-emerald-500/10 text-ok">
                        <StatusDot className="bg-emerald-400" /> 监控中
                      </Badge>
                    ) : (
                      <Badge className="border-white/10 bg-white/5 text-slate-400">
                        <StatusDot className="bg-slate-500" /> 已暂停
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-slate-500">
                    <span>上次扫描：{formatRelative(channel.last_scan_at)}</span>
                    <span>游标：{channel.last_scanned_id || "未初始化"}</span>
                    <span>
                      文件：<span className="text-slate-400">{channel.done_count ?? 0}</span>
                      {" / "}
                      <span className="text-slate-400">{channel.download_count ?? 0}</span>
                    </span>
                  </div>
                  {channel.last_error && (
                    <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-500/15 bg-rose-500/[0.06] px-2.5 py-1.5">
                      <IconAlert className="mt-0.5 h-3 w-3 shrink-0 text-err" />
                      <p className="text-[11.5px] leading-relaxed text-err/85">{channel.last_error}</p>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <Toggle checked={Boolean(channel.enabled)} onChange={(next) => void toggle(channel, next)} label="启用" />
                  <Button size="sm" onClick={() => void scanOne(channel)} loading={busyId === channel.id} title="立即扫描">
                    {busyId !== channel.id && <IconPlay className="h-3 w-3" />}
                    扫描
                  </Button>
                  <Button size="sm" onClick={() => void resetCursor(channel)} title="重置游标">
                    <IconRefresh className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPendingDelete(channel)} title="删除">
                    <IconTrash className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        title="删除频道"
        description={`将移除「${pendingDelete?.title ?? ""}」及其下载记录，已下载到磁盘的文件不会被删除。`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>取消</Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-slate-400">
          删除后该频道不再参与定时扫描。如需保留订阅关系，可以先将频道暂停而不是删除。
        </p>
      </Modal>
    </div>
  );
}
