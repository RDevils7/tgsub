import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Channel, MatchMode, Subscription } from "../types";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Spinner,
  StatusDot,
  Toggle,
  useToast,
} from "../components/ui";
import { IconAlert, IconEdit, IconPlus, IconTag, IconTrash } from "../components/icons";
import { formatRelative, parseKeywords } from "../utils";

const MODE_OPTIONS: Array<{ value: MatchMode; label: string; desc: string }> = [
  { value: "contains", label: "包含", desc: "文本中出现该词即命中" },
  { value: "word", label: "完整词", desc: "前后需为非字母数字，避免误匹配" },
  { value: "regex", label: "正则", desc: "支持 (4K|1080P) 等高级写法" },
];

interface FormState {
  id: number | null;
  name: string;
  keywords: string;
  match_mode: MatchMode;
  channel_ids: number[];
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  keywords: "",
  match_mode: "contains",
  channel_ids: [],
  enabled: true,
};

/** 名称留空时用关键词自动生成，和保存时保持一致，避免用户以为"没填名称就存不了" */
function deriveName(keywordList: string[]): string {
  const first = (keywordList[0] ?? "未命名订阅").slice(0, 20);
  return keywordList.length > 1 ? `${first} 等 ${keywordList.length} 个关键词` : first;
}

export default function Subscriptions() {
  const [items, setItems] = useState<Subscription[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Subscription | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [subs, chs] = await Promise.all([api.subscriptions(), api.channels()]);
      setItems(subs.items);
      setChannels(chs.items);
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const channelMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of channels) map.set(c.id, c.title);
    return map;
  }, [channels]);

  const parsed = form ? parseKeywords(form.keywords) : [];

  const openCreate = () => setForm({ ...EMPTY_FORM });
  const openEdit = (sub: Subscription) => {
    let ids: number[] = [];
    try {
      const parsedIds = JSON.parse(sub.channel_ids || "[]");
      if (Array.isArray(parsedIds)) ids = parsedIds.map(Number);
    } catch {
      ids = [];
    }
    setForm({
      id: sub.id,
      name: sub.name,
      keywords: sub.keywords,
      match_mode: sub.match_mode,
      channel_ids: ids,
      enabled: Boolean(sub.enabled),
    });
  };

  const save = async () => {
    if (!form || saving) return;
    if (parsed.length === 0) {
      toast.push("请至少填写一个关键词", "error");
      return;
    }
    const finalName = form.name.trim() || deriveName(parsed);
    setSaving(true);
    try {
      const payload = {
        name: finalName,
        keywords: parsed.join(","),
        match_mode: form.match_mode,
        channel_ids: form.channel_ids,
        enabled: form.enabled,
      };
      if (form.id) await api.updateSubscription(form.id, payload);
      else await api.createSubscription(payload);
      toast.push(
        form.id ? "订阅已更新" : `订阅「${finalName}」已创建`,
        "success",
      );
      setForm(null);
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (sub: Subscription, enabled: boolean) => {
    setItems((prev) => prev?.map((s) => (s.id === sub.id ? { ...s, enabled: enabled ? 1 : 0 } : s)) ?? prev);
    try {
      await api.updateSubscription(sub.id, { enabled });
    } catch (err) {
      toast.push((err as Error).message, "error");
      await load();
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteSubscription(pendingDelete.id);
      toast.push("订阅已删除", "success");
      setPendingDelete(null);
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge className="border-white/[0.08] bg-white/[0.03] text-slate-400">
            {items?.length ?? 0} 条规则
          </Badge>
          <span className="text-[12px] text-slate-500">命中任一关键词即下载该消息的全部文件</span>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <IconPlus className="h-3.5 w-3.5" />
          新建订阅
        </Button>
      </div>

      {items === null ? (
        <div className="flex h-48 items-center justify-center text-slate-500">
          <Spinner className="h-5 w-5" />
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<IconTag className="h-5 w-5" />}
            title="还没有订阅规则"
            description="例如关键词「4K」「资源」「教程」，命中后自动抓取文件。"
            action={
              <Button variant="primary" size="sm" onClick={openCreate}>
                创建第一条订阅
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {items.map((sub, i) => {
            let scope: number[] = [];
            try {
              const ids = JSON.parse(sub.channel_ids || "[]");
              if (Array.isArray(ids)) scope = ids.map(Number);
            } catch {
              scope = [];
            }
            const keywords = parseKeywords(sub.keywords);
            return (
              <div
                key={sub.id}
                className="card card-hover animate-fade-up p-4"
                style={{ animationDelay: `${i * 35}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[14px] font-medium text-white">{sub.name}</h3>
                      <Badge className="border-violet-500/20 bg-violet-500/10 text-violet-300">
                        {MODE_OPTIONS.find((m) => m.value === sub.match_mode)?.label ?? sub.match_mode}
                      </Badge>
                      {!sub.enabled && (
                        <Badge className="border-white/10 bg-white/5 text-slate-400">
                          <StatusDot className="bg-slate-500" /> 已暂停
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {keywords.slice(0, 12).map((kw) => (
                        <span key={kw} className="chip">
                          {kw}
                        </span>
                      ))}
                      {keywords.length > 12 && <span className="chip">+{keywords.length - 12}</span>}
                    </div>
                    <p className="mt-2.5 text-[11.5px] text-slate-500">
                      范围：
                      {scope.length === 0
                        ? "全部频道"
                        : scope
                            .map((id) => channelMap.get(id) ?? `#${id}`)
                            .slice(0, 3)
                            .join("、") + (scope.length > 3 ? ` 等 ${scope.length} 个` : "")}
                      <span className="mx-1.5 text-slate-700">·</span>
                      创建于 {formatRelative(sub.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Toggle checked={Boolean(sub.enabled)} onChange={(next) => void toggle(sub, next)} label="启用" />
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => openEdit(sub)} title="编辑">
                        <IconEdit className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setPendingDelete(sub)} title="删除">
                        <IconTrash className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? "编辑订阅" : "新建订阅"}
        description="关键词支持逗号或换行分隔，任意一个命中即触发下载。"
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setForm(null)}>取消</Button>
            <Button variant="primary" onClick={() => void save()} loading={saving}>
              {form?.id ? "保存修改" : "创建订阅"}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <Field
              label="订阅名称"
              hint={
                form.name.trim()
                  ? undefined
                  : parsed.length > 0
                    ? `留空将自动命名为「${deriveName(parsed)}」`
                    : "可留空，保存时自动用关键词命名"
              }
            >
              <input
                className="field"
                placeholder={parsed.length > 0 ? deriveName(parsed) : "例如：4K 影片资源（可留空）"}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            </Field>

            <Field label="关键词" hint="支持多个关键词，用逗号或换行分隔">
              <textarea
                className="field min-h-[92px] resize-y font-mono text-[12.5px]"
                placeholder={"4K, 蓝光\n纪录片"}
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              />
            </Field>

            {parsed.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {parsed.map((kw) => (
                  <span key={kw} className="chip border-brand-500/20 bg-brand-500/10 text-brand-200">
                    {kw}
                  </span>
                ))}
              </div>
            )}

            <Field label="匹配方式">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {MODE_OPTIONS.map((opt) => {
                  const active = form.match_mode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setForm({ ...form, match_mode: opt.value })}
                      className={`rounded-xl border p-3 text-left transition ${
                        active
                          ? "border-brand-500/50 bg-brand-500/[0.08] shadow-glow"
                          : "border-white/[0.07] bg-white/[0.02] hover:border-white/15"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-[13px] font-medium ${active ? "text-white" : "text-slate-300"}`}>
                          {opt.label}
                        </span>
                        <span
                          className={`h-3 w-3 rounded-full border ${
                            active ? "border-brand-400 bg-brand-400" : "border-white/20"
                          }`}
                        />
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="适用频道" hint="不选择则对所有启用的频道生效">
              {channels.length === 0 ? (
                <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-[12px] text-warn/90">
                  <IconAlert className="h-3.5 w-3.5" />
                  还没有添加频道，订阅将不会匹配到任何消息。
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, channel_ids: [] })}
                    className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition ${
                      form.channel_ids.length === 0
                        ? "border-brand-500/50 bg-brand-500/10 text-brand-200"
                        : "border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/15"
                    }`}
                  >
                    全部频道
                  </button>
                  {channels.map((c) => {
                    const active = form.channel_ids.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setForm({
                            ...form,
                            channel_ids: active
                              ? form.channel_ids.filter((id) => id !== c.id)
                              : [...form.channel_ids, c.id],
                          })
                        }
                        className={`max-w-[220px] truncate rounded-lg border px-2.5 py-1.5 text-[12px] transition ${
                          active
                            ? "border-brand-500/50 bg-brand-500/10 text-brand-200"
                            : "border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/15"
                        }`}
                      >
                        {c.title}
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>

            <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
              <div>
                <p className="text-[13px] text-slate-200">启用此订阅</p>
                <p className="mt-0.5 text-[11px] text-slate-500">关闭后不再匹配新消息，历史记录保留</p>
              </div>
              <Toggle checked={form.enabled} onChange={(next) => setForm({ ...form, enabled: next })} />
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        title="删除订阅"
        description={`确认删除「${pendingDelete?.name ?? ""}」？`}
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
          已下载的文件与下载记录不会被删除，仅停止后续的关键词匹配。
        </p>
      </Modal>
    </div>
  );
}
