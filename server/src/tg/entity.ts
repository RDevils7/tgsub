/**
 * Telegram 频道的实体标识与消息链接。
 *
 * Telegram 的 peer ID 分「标记」和「未标记」两种形式：
 *   频道 / 超级群：-100<id>      普通群：-<id>      用户：<id>
 *
 * gramjs 只按标记形式判断类型（Utils.resolveId）：正数一律当用户、
 * `-100` 开头当频道。传裸号会走 users.getUsers，服务器返回 UserEmpty，
 * 于是报「Could not find the input entity for {"userId":…,"className":"PeerUser"}」。
 *
 * 数据库 channels.tg_id 存的正是未标记的裸号（entity.id），
 * 所以凡是交给 getEntity 的地方都要先转成标记形式；
 * 有 username 的公开频道不受影响，username 优先。
 */

export interface ChannelRef {
  username?: string | null;
  tg_id?: string | null;
}

/** 频道 ID 的标记形式 -100<id>；非法输入返回 null */
export function markedChannelId(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  // 已经是标记形式就别再套一层前缀
  if (text.startsWith("-100")) return text;
  return `-100${text.replace(/^-/, "")}`;
}

/** 频道的内部 ID（去掉 -100 前缀），用于 t.me/c/<id>/<msgId> 链接 */
export function channelInternalId(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  return text.replace(/^-100/, "").replace(/^-/, "");
}

/**
 * 实体键归一化：裸数字一律转成标记形式，避免被当成用户 ID。
 * 用户名原样返回。
 */
export function normalizeEntityKey(key: string | null | undefined): string {
  const text = String(key ?? "").trim();
  if (!text) return text;
  if (/^\d+$/.test(text)) return `-100${text}`;
  return text;
}

/** 交给 getEntity 的键：优先 username，其次标记形式的频道 ID */
export function channelEntityKey(channel: ChannelRef): string {
  const username = String(channel.username ?? "").trim();
  if (username) return username;
  return markedChannelId(channel.tg_id) ?? "";
}

/** 频道消息链接：公开频道 t.me/<username>/<id>，私有频道 t.me/c/<id>/<id> */
export function channelMessageLink(channel: ChannelRef, messageId: number | string): string {
  const username = String(channel.username ?? "").trim();
  if (username) return `https://t.me/${username}/${messageId}`;
  const internal = channelInternalId(channel.tg_id);
  return internal ? `https://t.me/c/${internal}/${messageId}` : "";
}

/**
 * 修正旧版生成的失效链接：t.me/<裸号>/<消息ID> → t.me/c/<裸号>/<消息ID>。
 * 裸号不是用户名，那个地址打不开，已经被写进 nfo 的 uniqueid 了。
 */
export function fixTelegramLink(link: string | null | undefined): string | null {
  if (!link) return link ?? null;
  const matched = /^https:\/\/t\.me\/(\d+)\/(\d+)$/.exec(link);
  if (!matched) return link;
  return `https://t.me/c/${matched[1]}/${matched[2]}`;
}

/** nfo 文本里失效的私有频道链接 */
const BROKEN_LINK_RE = /https:\/\/t\.me\/(\d+)\/(\d+)/g;

/**
 * 把 nfo 文本里失效的私有频道链接换成能打开的 t.me/c/ 形式。
 *
 * tvshow.nfo 只在剧集首次落盘时生成，旧的会一直留在那里；
 * 任务入队时缓存的 emby_json 也可能是修复前的快照 —— 所以按文本模式扫，不依赖库里的旧值。
 */
export function repairNfoText(text: string): string {
  BROKEN_LINK_RE.lastIndex = 0;
  return text.replace(BROKEN_LINK_RE, "https://t.me/c/$1/$2");
}
