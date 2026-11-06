/**
 * 从 `messages.GetDiscussionMessage` 的返回里挑出「关联讨论组」（纯逻辑）。
 *
 * 评论并不在频道里：频道帖子底下开评论后，Telegram 会把它转发进一个关联的
 * megagroup（讨论组），`?comment=<id>` 里的 id 是**讨论组内部**的消息 ID。
 * 所以拿到讨论组 peer 才能用 getMessages 把这条评论取出来。
 *
 * 这里刻意不 import telegram / db：GramJS 返回的对象结构可以直接喂给自检脚本，
 * 用普通对象造几条数据就能验证挑选逻辑。
 */

export interface DiscussionGroup {
  /** 讨论组的裸 ID（不带 -100） */
  id: string;
  /** 讨论组公开用户名（多数没有） */
  username: string | null;
  /**
   * 讨论组的 access_hash（十进制字符串）。
   *
   * 评论区的讨论组大多是**私密 megagroup**，没有 username；这时
   * `-100<id>` 这种裸键 gramjs 解析不了（拼不出 InputChannel），
   * 只有 access_hash 才能按消息 ID 直接读评论 —— 而
   * `messages.getDiscussionMessage` 的返回里本来就带着它。
   * 用它取消息**不需要加入群组**（官方文档原话：without actually joining the group）。
   */
  accessHash: string | null;
  title: string;
}

type AnyRecord = Record<string, unknown>;

/** 去掉 -100 / 负号，只留裸 ID；非整数返回 null */
function bareId(text: string): string | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return trimmed.replace(/^-100/, "").replace(/^-/, "");
}

/**
 * 把 GramJS 的 ID 统一成「裸 ID 十进制字符串」。
 *
 * 注意 gramjs 里的 `long` **不是** JS 原生 bigint，而是 `big-integer` 的
 * BigInteger 实例（`tl/api.d.ts` 里 `type long = BigInteger`）：
 * `typeof` 是 `"object"`，身上没有 `channelId` / `id` 字段，只有 `toString()`。
 * 早先只认 bigint / number / string，于是 `replies.channelId`、
 * `peerId.channelId`、`chat.id` 一律解析成 null —— 评论区 6 条路全部「看起来没数据」，
 * 就是这个原因（1.3.10 报告：replies 明明 comments=true 90 条却说没有 channel_id）。
 */
export function idString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint" || typeof value === "number") return bareId(String(value));
  if (typeof value === "string") return bareId(value);
  if (typeof value === "object") {
    const obj = value as AnyRecord;
    // PeerChannel / PeerChat / { id } 这类容器：先往里钻一层
    const nested = obj.channelId ?? obj.chatId ?? obj.userId ?? obj.id;
    if (nested !== undefined && nested !== null) return idString(nested);
    // BigInteger（以及别的「数值型对象」）：只能靠 toString()，"[object Object]" 会被过滤掉
    try {
      return bareId(String(obj));
    } catch {
      return null;
    }
  }
  return null;
}

/** 和 idString 一样，但把 0 当成「没有」（DiscussionMessage 里常拿 0 表示空） */
export function validId(value: unknown): string | null {
  const id = idString(value);
  return id && id !== "0" ? id : null;
}

/**
 * 从 `channels.getFullChannel` 的返回（`messages.chatFull`）里取关联讨论组 ID。
 *
 * 这是最可靠的一条路：`ChannelFull.linked_chat_id` 是频道级设置，
 * 公开频道对任何已登录账号都可读，不需要加入讨论组。
 * 同一份返回里的 `chats` 还常带着讨论组本身（含 access_hash）。
 */
export function linkedGroupId(payload: unknown): string | null {
  const fullChat = (payload as AnyRecord | null)?.fullChat;
  if (!fullChat || typeof fullChat !== "object") return null;
  return validId((fullChat as AnyRecord).linkedChatId);
}

/**
 * access_hash 归一化成十进制字符串。
 *
 * gramjs 里可能是 bigint、big-integer 对象或字符串；超过 2^53 所以不能过 Number。
 * 拿不到合法整数时返回 null（这条链路上宁可退回 username，也不能塞个假 hash）。
 */
export function hashString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  try {
    text = String(value).trim();
  } catch {
    return null;
  }
  return /^-?\d+$/.test(text) ? text : null;
}

function chatList(payload: unknown): AnyRecord[] {
  const chats = (payload as AnyRecord | null)?.chats;
  return Array.isArray(chats) ? (chats as AnyRecord[]) : [];
}

function messageList(payload: unknown): AnyRecord[] {
  const messages = (payload as AnyRecord | null)?.messages;
  return Array.isArray(messages) ? (messages as AnyRecord[]) : [];
}

/**
 * @param payload `GetDiscussionMessage` 的返回（或同形状的普通对象）
 * @param channelId 频道自身的裸 ID，用来排除「返回的其实是频道自己」
 */
export function pickDiscussionGroup(payload: unknown, channelId?: string | null): DiscussionGroup | null {
  const chats = chatList(payload);
  const messages = messageList(payload);
  const selfId = idString(channelId ?? null);

  // 1) 讨论组里的「帖子镜像消息」的 peerId 就是讨论组，最可靠
  let wanted = validId(messages[0]?.peerId);
  if (wanted && wanted === selfId) wanted = null;

  // 2) 兜底：从 chats 里找 megagroup（或另一个 Channel），避开频道自身
  if (!wanted) {
    const others = chats.filter((chat) => {
      const id = validId(chat.id);
      if (!id || id === selfId) return false;
      const kind = String(chat.className ?? chat._ ?? "");
      return Boolean(chat.megagroup) || /Channel|Chat/i.test(kind) || !kind;
    });
    const mega = others.find((chat) => Boolean(chat.megagroup));
    wanted = validId((mega ?? others[0])?.id);
  }

  const chat = wanted ? chats.find((c) => idString(c.id) === wanted) : undefined;
  if (!wanted) return null;
  return {
    id: wanted,
    username: chat?.username ? String(chat.username).replace(/^@/, "") : null,
    accessHash: hashString(chat?.accessHash),
    title: chat?.title ? String(chat.title) : "",
  };
}

/** 交给 getEntity 的键：公开讨论组用 username（重启后仍可解析），否则 -100<id> */
export function discussionEntityKey(group: DiscussionGroup): string {
  return group.username || `-100${group.id}`;
}

/**
 * 帖子自己的 `replies` 字段（`channels.getMessages` / `getMessages` 取回来的那条消息）。
 *
 * Telegram 把「评论去哪了」直接写在帖子上：
 *   replies.comments = true  → 开了评论
 *   replies.channel_id       → 关联讨论组的裸 ID（评论的 ID 就是那个组里的消息序号）
 * 这条信息不依赖 `messages.getDiscussionMessage`，是它偶发返回空时的第一条后路。
 */
export interface PostReplyInfo {
  /** 帖子是否开启了评论 */
  comments: boolean;
  /** 评论条数（服务端统计值，可能滞后） */
  count: number;
  /** 关联讨论组的裸 ID；没开评论 / 字段缺失时为 null */
  channelId: string | null;
}

export function postReplyInfo(payload: unknown, postId: number): PostReplyInfo {
  const list = messageList(payload);
  const post =
    list.find((m) => idString(m.id) === String(postId)) ??
    (list.length === 1 ? list[0] : undefined);
  const replies = post?.replies as AnyRecord | undefined | null;
  if (!replies || typeof replies !== "object") {
    return { comments: false, count: 0, channelId: null };
  }
  const count = Number(replies.replies ?? 0);
  // 没开评论时 Telegram 给的就是 channelId=0，别当成合法 ID（否则会去查「讨论组 0」）
  const channelId = idString(replies.channelId);
  return {
    comments: Boolean(replies.comments),
    count: Number.isFinite(count) && count > 0 ? count : 0,
    channelId: channelId && channelId !== "0" ? channelId : null,
  };
}

/** 从任意带 `chats` 的返回里，按裸 ID 找某个 chat 的 hash / username / 标题 */
export function chatInfoOf(
  payload: unknown,
  id: string,
): { accessHash: string | null; username: string | null; title: string } | null {
  const wanted = validId(id);
  if (!wanted) return null;
  const chat = chatList(payload).find((c) => idString(c.id) === wanted);
  if (!chat) return null;
  return {
    accessHash: hashString(chat.accessHash),
    username: chat.username ? String(chat.username).replace(/^@/, "") : null,
    title: chat.title ? String(chat.title) : "",
  };
}

/**
 * 把「一堆 chats」摊成讨论组候选（对话框列表 / getReplies 的返回都能喂）。
 *
 * 对话框列表里全是已加入的群，其中就有那个私密讨论组 —— 这是
 * 「账号其实已经加过群、只是没有 username」时最省事的一条后路。
 */
export function groupsFromChats(payload: unknown, channelId?: string | null): DiscussionGroup[] {
  const selfId = idString(channelId ?? null);
  const out: DiscussionGroup[] = [];
  for (const chat of chatList(payload)) {
    const id = validId(chat.id);
    if (!id || id === selfId) continue;
    const kind = String(chat.className ?? chat._ ?? "");
    // 只认超级群 / 群；用户和频道自身排除掉
    if (!chat.megagroup && kind && !/Chat/i.test(kind)) continue;
    out.push({
      id,
      username: chat.username ? String(chat.username).replace(/^@/, "") : null,
      accessHash: hashString(chat.accessHash),
      title: chat.title ? String(chat.title) : "",
    });
  }
  return out;
}

/**
 * 线程里第一条消息的 peer —— `messages.getReplies` 返回的评论消息，
 * peerId 指向讨论组。用它兜底挑组（不依赖 chats 里的 megagroup 标记）。
 */
export function threadGroupId(payload: unknown, channelId?: string | null): string | null {
  const selfId = idString(channelId ?? null);
  const wanted = validId(messageList(payload)[0]?.peerId);
  return wanted && wanted !== selfId ? wanted : null;
}
