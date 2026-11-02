import { getEmbyApiKey, getSettings } from "../db";
import { logger } from "../logger";
import { mapEmbyPath, normalizeEmbyUrl, parsePathMap, type EmbyPathRule } from "./embypath";

/**
 * Emby 入库通知。
 *
 * 下载完成 → 调 Emby 的 `POST /Library/Media/Updated`，把新增/更新的文件路径
 * 交给它，Emby 只对这条路径做一次增量扫描，不用等下一次全库扫描，
 * 也不用肉眼去点「扫描媒体库」。
 *
 * 三件事必须一起配对，否则 Emby 会静默忽略（它返回 204，什么都不报）：
 *  1. 地址   —— Emby 服务根地址，例如 http://192.168.1.10:8096
 *  2. API Key —— Emby 后台「API 密钥」里生成，管理员权限
 *  3. 路径映射 —— 本程序看到的路径与 Emby 看到的路径往往不是同一个
 *                （容器内 /downloads ↔ 宿主机 /volume1/media/tgsub）
 *
 * 通知是「锦上添花」：失败只记日志与历史，绝不影响下载结果本身。
 */

const REQUEST_TIMEOUT_MS = 8000;
/** 相邻几集往往连着下完，攒 2.5 秒合成一次请求，别把 Emby 打出一堆扫描 */
const DEBOUNCE_MS = 2500;
/** 一次请求最多带多少条路径 */
const BATCH_SIZE = 50;
/** 通知失败后重试一次（内网抖动、Emby 正在重启都很常见） */
const RETRY_DELAY_MS = 15_000;
const HISTORY_LIMIT = 30;

export interface EmbyConfig {
  baseUrl: string;
  apiKey: string;
  rules: EmbyPathRule[];
}

/**
 * Emby 的入库通知类型。
 *
 * Created  新增（下载完成）
 * Modified 重新生成 NFO / 封面后让 Emby 重新认一遍
 * Deleted  文件被删了，让 Emby 把这条从库里摘掉
 */
export type EmbyUpdateType = "Created" | "Modified" | "Deleted";

export interface EmbyNotifyRecord {
  at: number;
  /** 提交给 Emby 的路径（映射后） */
  paths: string[];
  ok: boolean;
  /** HTTP 状态码，网络层失败时为 null */
  status: number | null;
  error: string | null;
  /** 是否来自定时下载（false = 手动补推 / 生成元数据） */
  auto: boolean;
}

// 纯函数（地址规整、路径映射）在 embypath.ts，这里只负责发请求与攒批
export { mapEmbyPath, normalizeEmbyUrl, parsePathMap };
export type { EmbyPathRule };

/** 当前生效的配置；没开启或缺项时返回 null（调用方据此跳过通知） */
export function getEmbyConfig(): EmbyConfig | null {
  let settings;
  try {
    settings = getSettings();
  } catch {
    return null;
  }
  if (!settings.emby_notify) return null;
  const baseUrl = normalizeEmbyUrl(settings.emby_url);
  const apiKey = getEmbyApiKey();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, rules: parsePathMap(settings.emby_path_map) };
}

export interface EmbyProbeResult {
  ok: boolean;
  serverName: string | null;
  version: string | null;
  error: string | null;
}

function describeError(err: unknown): string {
  const e = err as Error & {
    code?: string;
    cause?: { code?: string; message?: string; errors?: Array<{ code?: string; message?: string }> };
  };
  if (e?.name === "AbortError") return `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`;
  // Node 的 fetch 把真实原因塞在 cause 里；解析双栈地址时会变成 AggregateError
  const code = e?.code || e?.cause?.code || e?.cause?.errors?.[0]?.code;
  if (code === "ECONNREFUSED") return "连接被拒绝：地址或端口不对，或 Emby 没在跑";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败，检查地址是否写错";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "网络不可达：检查容器网络与地址";
  if (code === "ETIMEDOUT") return "连接超时：检查防火墙是否放行该端口";
  if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "HTTPS 证书不受信任，可改用 http，或给 Emby 换正式证书";
  }
  const message = e?.cause?.message || e?.message || String(err);
  if (/fetch failed/i.test(message)) return "无法连接到该地址（网络不通或端口不对）";
  if (/bad port/i.test(message)) return "端口不被允许（Node 拒绝的低端口），请填 Emby 实际端口";
  return message;
}

async function embyFetch(
  config: { baseUrl: string; apiKey: string },
  pathname: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // 再规整一次：地址可能来自「测试连接」的临时输入，未必走过 getEmbyConfig
  const baseUrl = normalizeEmbyUrl(config.baseUrl);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      // Emby 新旧两个表头都认，两个都带能兼容更多版本
      "X-Emby-Token": config.apiKey,
      "X-MediaBrowser-Token": config.apiKey,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    return await fetch(`${baseUrl}${pathname}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "";
  }
}

/** 探测连接：拿到服务器名与版本，说明地址和 API Key 都对 */
export async function probeEmby(config: { baseUrl: string; apiKey: string }): Promise<EmbyProbeResult> {
  try {
    const res = await embyFetch(config, "/System/Info");
    if (res.status === 401 || res.status === 403) {
      return { ok: false, serverName: null, version: null, error: "API Key 被拒绝（401），请重新复制 Emby 后台的 API 密钥" };
    }
    if (!res.ok) {
      const snippet = await readSnippet(res);
      return {
        ok: false,
        serverName: null,
        version: null,
        error: `HTTP ${res.status}${snippet ? `：${snippet}` : ""}`,
      };
    }
    const info = (await res.json().catch(() => null)) as { ServerName?: string; Version?: string } | null;
    return { ok: true, serverName: info?.ServerName ?? null, version: info?.Version ?? null, error: null };
  } catch (err) {
    return { ok: false, serverName: null, version: null, error: describeError(err) };
  }
}

const history: EmbyNotifyRecord[] = [];
const pending = new Map<string, EmbyUpdateType>();
let flushTimer: NodeJS.Timeout | null = null;
let lastNotifiedAt: number | null = null;

function record(entry: EmbyNotifyRecord): void {
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  if (entry.ok) lastNotifiedAt = entry.at;
}

export function getEmbyNotifyState(): {
  lastNotifiedAt: number | null;
  pending: number;
  history: EmbyNotifyRecord[];
} {
  return { lastNotifiedAt, pending: pending.size, history: [...history] };
}

/**
 * 排一条入库通知。传入本机绝对路径，这里负责攒批、映射、提交。
 * 没启用通知时直接返回，连定时器都不建。
 */
export function queueEmbyUpdate(absPath: string, type: EmbyUpdateType = "Created", auto = true): void {
  if (!absPath) return;
  if (!getEmbyConfig()) return;
  pending.set(absPath, type);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const entries = [...pending.entries()];
    pending.clear();
    void deliver(entries, auto);
  }, DEBOUNCE_MS);
  // 定时器不该拖住进程退出
  flushTimer.unref?.();
}

/** 立刻提交一批路径（手动补推用），返回最后一次请求结果 */
export async function notifyEmbyNow(
  absPaths: string[],
  type: EmbyUpdateType = "Modified",
): Promise<EmbyNotifyRecord> {
  if (!absPaths.length) {
    return { at: Date.now(), paths: [], ok: false, status: null, error: "没有需要提交的路径", auto: false };
  }
  return deliver(absPaths.map((p) => [p, type] as [string, EmbyUpdateType]), false);
}

async function deliver(entries: Array<[string, EmbyUpdateType]>, auto: boolean, attempt = 0): Promise<EmbyNotifyRecord> {
  const config = getEmbyConfig();
  const now = Date.now();
  if (!config) {
    const body: EmbyNotifyRecord = {
      at: now,
      paths: entries.map(([p]) => p),
      ok: false,
      status: null,
      error: "Emby 入库通知未启用或未配置完整",
      auto,
    };
    record(body);
    return body;
  }

  const updates = entries.map(([absPath, type]) => ({
    Path: mapEmbyPath(absPath, config.rules),
    UpdateType: type,
  }));
  // 映射后可能重复（多集落在同一目录被合并时），去重再提交
  const seen = new Set<string>();
  const unique = updates.filter((item) => {
    const key = `${item.UpdateType}|${item.Path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let status: number | null = null;
  let error: string | null = null;
  try {
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const chunk = unique.slice(i, i + BATCH_SIZE);
      const res = await embyFetch(config, "/Library/Media/Updated", {
        method: "POST",
        body: { Updates: chunk },
      });
      status = res.status;
      if (!res.ok) {
        const snippet = await readSnippet(res);
        error =
          res.status === 401 || res.status === 403
            ? `API Key 无权提交入库（HTTP ${res.status}），请确认它是 Emby 管理员密钥`
            : `HTTP ${res.status}${snippet ? `：${snippet}` : ""}`;
        break;
      }
    }
  } catch (err) {
    error = describeError(err);
  }

  const ok = !error;
  const paths = unique.map((u) => u.Path);
  const entry: EmbyNotifyRecord = { at: now, paths, ok, status, error, auto };
  record(entry);

  if (ok) {
    logger.info(
      { count: paths.length, paths: paths.slice(0, 5), server: config.baseUrl },
      `已通知 Emby 入库 ${paths.length} 项`,
    );
    return entry;
  }

  // 失败重试一次：Emby 重启、NAS 短暂抽风都靠它兜住
  if (attempt === 0 && entries.length) {
    logger.warn(
      { count: paths.length, paths: paths.slice(0, 5), err: error },
      `通知 Emby 入库失败，${RETRY_DELAY_MS / 1000} 秒后重试一次`,
    );
    const timer = setTimeout(() => void deliver(entries, auto, 1), RETRY_DELAY_MS);
    timer.unref?.();
    return entry;
  }

  logger.warn(
    { count: paths.length, paths: paths.slice(0, 5), err: error, server: config.baseUrl },
    `通知 Emby 入库失败，Emby 上的新集需要等下一次全库扫描才会出现`,
  );
  return entry;
}

/** 让 Emby 立刻全库扫描一次（补历史文件、或通知失败后的兜底） */
export async function refreshEmbyLibrary(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const config = getEmbyConfig();
  if (!config) return { ok: false, status: null, error: "Emby 入库通知未启用或未配置完整" };
  try {
    const res = await embyFetch(config, "/Library/Refresh", { method: "POST" });
    if (!res.ok) {
      const snippet = await readSnippet(res);
      return {
        ok: false,
        status: res.status,
        error: res.status === 401 || res.status === 403 ? "API Key 无管理员权限" : `HTTP ${res.status}${snippet ? `：${snippet}` : ""}`,
      };
    }
    logger.info({ server: config.baseUrl }, "已请求 Emby 全库扫描");
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return { ok: false, status: null, error: describeError(err) };
  }
}
