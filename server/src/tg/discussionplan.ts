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
  title: string;
}

type AnyRecord = Record<string, unknown>;

/** GramJS 里 id 可能是 bigint / number / string，也常包在 PeerChannel 里 */
export function idString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint" || typeof value === "number") {
    return String(value).replace(/^-100/, "").replace(/^-/, "");
  }
  if (typeof value === "string") {
    const text = value.trim();
    return /^-?\d+$/.test(text) ? text.replace(/^-100/, "").replace(/^-/, "") : null;
  }
  if (typeof value === "object") {
    const obj = value as AnyRecord;
    return idString(obj.channelId ?? obj.chatId ?? obj.id ?? null);
  }
  return null;
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
  let wanted = idString(messages[0]?.peerId);
  if (wanted && wanted === selfId) wanted = null;

  // 2) 兜底：从 chats 里找 megagroup（或另一个 Channel），避开频道自身
  if (!wanted) {
    const others = chats.filter((chat) => {
      const id = idString(chat.id);
      if (!id || id === selfId) return false;
      const kind = String(chat.className ?? chat._ ?? "");
      return Boolean(chat.megagroup) || /Channel|Chat/i.test(kind) || !kind;
    });
    const mega = others.find((chat) => Boolean(chat.megagroup));
    wanted = idString((mega ?? others[0])?.id);
  }

  const chat = wanted ? chats.find((c) => idString(c.id) === wanted) : undefined;
  if (!wanted) return null;
  return {
    id: wanted,
    username: chat?.username ? String(chat.username).replace(/^@/, "") : null,
    title: chat?.title ? String(chat.title) : "",
  };
}

/** 交给 getEntity 的键：公开讨论组用 username（重启后也能解析），否则 -100<id> */
export function discussionEntityKey(group: DiscussionGroup): string {
  return group.username || `-100${group.id}`;
}
