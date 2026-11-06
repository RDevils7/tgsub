import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { logger } from "../logger";
import { normalizeEntityKey } from "./entity";
import { inputChannelOf, inputPeerOf } from "./media";
import {
  chatInfoOf,
  discussionEntityKey,
  groupsFromChats,
  hashString,
  idString,
  linkedGroupId,
  pickDiscussionGroup,
  postReplyInfo,
  threadGroupId,
  type DiscussionGroup,
  type PostReplyInfo,
} from "./discussionplan";

/**
 * 取「频道帖子的关联讨论组」。
 *
 * `https://t.me/<频道>/<帖子>?comment=<评论ID>` 里的评论不在频道里：
 * 帖子被转发进关联的 megagroup，评论 ID 是讨论组内部的消息 ID。
 * 拿不到那个组，后面按 ID 取消息就无从谈起。
 *
 * 以前只有一条路（`messages.getDiscussionMessage`），它**偶发返回空**
 * ——同一个帖子下，一条评论能下、另一条报「没有开启评论或不在讨论组里」，
 * 就这么来的。现在改成多路兜底，任何一条通就能下：
 *
 *   1. `messages.getDiscussionMessage`（官方说明：无需加入群组），空结果重试；
 *   2. 帖子自己的 `replies.channel_id` —— 评论开关和讨论组 ID 就写在帖子上；
 *   3. `messages.getReplies` —— 客户端拉评论走的就是它，返回的 chats 里带 access_hash；
 *   4. 对话框列表 —— 账号其实已经加过那个群时，hash 就在里面；
 *   5. `getEntity("-100<id>")` —— 进程内缓存 / 公开组 username 兜底。
 *
 * 全部失败才报错，并且把每一步的失败原因写进报错文案，便于一眼定位。
 */

export interface ResolvedDiscussion extends DiscussionGroup {
  /** 交给 getEntity 的键 */
  entityKey: string;
}

/** 频道引用：entityKey 用于解析，accessHash 用于直接拼 InputPeerChannel */
export interface ChannelPeerRef {
  entityKey: string;
  accessHash?: string | null;
}

function explain(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  // RPCError 的 message 常是 CHANNEL_INVALID / MESSAGE_ID_INVALID 之类，留着方便排障
  return text.slice(0, 120);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 对话框里的 chat（只留后面要用的字段） */
let dialogsCache: { at: number; chats: DiscussionGroup[] } | null = null;

/** 账号已加入的群（含私密组）—— 最后一步才查，查一次缓存 10 分钟 */
async function knownChats(client: TelegramClient): Promise<DiscussionGroup[]> {
  if (dialogsCache && Date.now() - dialogsCache.at < 10 * 60_000) return dialogsCache.chats;
  try {
    const payload = await client.invoke(
      new Api.messages.GetDialogs({
        offsetDate: 0,
        offsetId: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        limit: 200,
        hash: bigInt(0),
      }),
    );
    const chats = groupsFromChats(payload);
    // 空结果不缓存：用户刚加完群要能立刻生效
    if (chats.length) dialogsCache = { at: Date.now(), chats };
    return chats;
  } catch (err) {
    logger.warn({ err: explain(err) }, "读取对话框列表失败，跳过「已加入的群」兜底");
    return [];
  }
}

export async function resolveDiscussionGroup(
  client: TelegramClient,
  ref: ChannelPeerRef,
  postId: number,
): Promise<ResolvedDiscussion> {
  const diag: string[] = [];
  const key = normalizeEntityKey(ref.entityKey);
  const inputPeer = inputPeerOf(key, ref.accessHash);

  // messages.* 的 peer：有 access_hash 就直接拼，省一次实体解析；
  // 公开频道只有 username 时退回 getEntity（这条路本来就能用）。
  const peer: unknown = inputPeer ?? (await client.getEntity(key as never));
  const selfId = idString((peer as { id?: unknown } | null)?.id) ?? idString(key);
  // 库里没存 hash 时，用刚解析出来的实体补一个（channels.getFullChannel 需要 InputChannel）
  const channelHash = ref.accessHash ?? hashString((peer as { accessHash?: unknown } | null)?.accessHash);

  let group: DiscussionGroup | null = null;
  let postInfo: PostReplyInfo | null = null;

  /* ---------- 0) channels.getFullChannel：频道级信息里直接写着关联讨论组 ----------
   * 这是最可靠的一条路，也是 Telegram 官方客户端用的：`ChannelFull.linked_chat_id`
   * 就是讨论组 ID，公开频道对任何已登录账号都可读，不需要加入任何群。
   * 而且 `messages.chatFull` 的 `chats` 数组里通常连带那个讨论组的完整对象
   * （含 access_hash）—— 一步就把 ID 和 hash 一起拿到。 */
  if (!group) {
    try {
      const channelInput = inputChannelOf(key, channelHash) ?? (peer as never);
      const full = await client.invoke(
        new Api.channels.GetFullChannel({ channel: channelInput as never }),
      );
      const linked = linkedGroupId(full);
      if (linked) {
        const info = chatInfoOf(full, linked);
        group = {
          id: linked,
          username: info?.username ?? null,
          accessHash: info?.accessHash ?? null,
          title: info?.title ?? "",
        };
        diag.push(
          `getFullChannel 定位到讨论组 ${linked}${info?.accessHash ? "（含 hash）" : "（无 hash）"}`,
        );
      } else {
        diag.push("getFullChannel 显示该频道没有关联讨论组");
      }
    } catch (err) {
      diag.push(`getFullChannel 报错 ${explain(err)}`);
    }
  }

  /* ---------- 1) 官方接口，空结果重试一次 ---------- */
  for (let attempt = 1; attempt <= 2 && !group; attempt += 1) {
    try {
      const payload = await client.invoke(
        new Api.messages.GetDiscussionMessage({ peer: peer as never, msgId: postId }),
      );
      group = pickDiscussionGroup(payload, selfId);
      if (!group) {
        // messages 可能是空的，但 chats 里仍然带着那个 megagroup
        const candidates = groupsFromChats(payload, selfId);
        const mega = candidates.find((c) => c.title) ?? candidates[0] ?? null;
        group = mega?.accessHash ? mega : null;
      }
      if (!group) diag.push(`getDiscussionMessage 第 ${attempt} 次返回空`);
    } catch (err) {
      const text = explain(err);
      diag.push(`getDiscussionMessage 报错 ${text}`);
      const flood = /FLOOD_WAIT_(\d+)/i.exec(text);
      // FLOOD_WAIT 等一下再试，其它错误也别立刻放弃
      await sleep(flood ? Math.min(Number(flood[1]), 5) * 1000 : 700);
    }
    if (!group && attempt === 1) await sleep(600);
  }

  /* ---------- 2) 帖子自己的 replies 字段 ---------- */
  if (!group) {
    try {
      const list = (await client.getMessages(peer as never, { ids: [postId] })) as unknown as Array<
        Record<string, unknown>
      >;
      postInfo = postReplyInfo({ messages: list }, postId);
      if (postInfo.channelId) {
        group = { id: postInfo.channelId, username: null, accessHash: null, title: "" };
        diag.push(`帖子 replies.channel_id=${postInfo.channelId}`);
      } else if (!postInfo.comments) {
        diag.push("帖子 replies.comments=false");
      } else {
        // 有评论但没给 channel_id：以前这里什么都不记，诊断就只剩「返回空」两条
        diag.push(`帖子 replies 无 channel_id（comments=true, ${postInfo.count} 条）`);
      }
    } catch (err) {
      diag.push(`读帖子失败 ${explain(err)}`);
    }
  }

  /* ---------- 3) messages.getReplies：拉评论线程，顺带带出讨论组 ---------- */
  let repliesPayload: unknown = null;
  try {
    repliesPayload = await client.invoke(
      new Api.messages.GetReplies({
        peer: peer as never,
        msgId: postId,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: 1,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    );
  } catch (err) {
    diag.push(`getReplies 报错 ${explain(err)}`);
  }

  if (repliesPayload) {
    if (!group) {
      const fromThread = threadGroupId(repliesPayload, selfId);
      const byChats = pickDiscussionGroup(repliesPayload, selfId);
      const id = fromThread ?? byChats?.id ?? null;
      const info = id ? chatInfoOf(repliesPayload, id) : null;
      if (id) {
        group = {
          id,
          username: info?.username ?? byChats?.username ?? null,
          accessHash: info?.accessHash ?? byChats?.accessHash ?? null,
          title: info?.title ?? byChats?.title ?? "",
        };
        diag.push(`getReplies 定位到讨论组 ${id}`);
      } else {
        // 成功但什么都没给：把「返回了几条消息 / 几个 chat」记下来，
        // 才能区分「帖子确实没评论」和「账号看不到这个讨论组」
        const msgs = (repliesPayload as { messages?: unknown[] })?.messages;
        const chats = (repliesPayload as { chats?: unknown[] })?.chats;
        diag.push(
          `getReplies 未返回讨论组（messages=${Array.isArray(msgs) ? msgs.length : "?"}，chats=${
            Array.isArray(chats) ? chats.length : "?"
          }）`,
        );
      }
    }
    if (group && (!group.accessHash || !group.username)) {
      const info = chatInfoOf(repliesPayload, group.id);
      if (info?.accessHash && !group.accessHash) {
        group.accessHash = info.accessHash;
        diag.push("getReplies 补到 access_hash");
      }
      if (info?.username && !group.username) group.username = info.username;
      if (info?.title && !group.title) group.title = info.title;
    }
  }

  /* ---------- 4) 账号已经加过这个群：对话框列表里有 hash ---------- */
  if (group && !group.accessHash && !group.username) {
    const chats = await knownChats(client);
    const hit = chats.find((c) => c.id === group?.id);
    if (hit) {
      group.accessHash = hit.accessHash ?? null;
      group.username = hit.username ?? null;
      if (!group.title) group.title = hit.title;
      if (group.accessHash) diag.push("对话框列表补到 access_hash");
    }
  }

  /* ---------- 5) 最后让 gramjs 自己解析一次（进程内缓存 / 公开组） ---------- */
  if (group && !group.accessHash && !group.username) {
    try {
      const entity = (await client.getEntity(`-100${group.id}` as never)) as {
        accessHash?: unknown;
        username?: string;
        title?: string;
      };
      const hash = chatInfoOf({ chats: [entity] }, group.id)?.accessHash ?? null;
      if (hash) {
        group.accessHash = hash;
        diag.push("getEntity 解析到 access_hash");
      }
      if (entity?.username) group.username = String(entity.username);
      if (entity?.title && !group.title) group.title = String(entity.title);
    } catch (err) {
      diag.push(`getEntity 解析讨论组失败 ${explain(err)}`);
    }
  }

  if (!group) {
    // 报错文案先给结论、再给诊断（前端「提交记录」只留 300 字，别把结论挤掉）
    logger.warn({ postId, diag, postInfo }, "定位不到帖子的讨论组");
    if (postInfo && !postInfo.comments) {
      throw new Error(
        `这个帖子没有开启评论（帖子 replies.comments=false，channel_id=0），没有评论区可下。诊断：${diag
          .slice(-2)
          .join("；")}`,
      );
    }
    if (diag.some((d) => /CHANNEL_PRIVATE/i.test(d))) {
      throw new Error(
        `读取评论区被拒（CHANNEL_PRIVATE）：帖子本身可读，但关联讨论组是私密群、登录账号不在群里。` +
          `公开讨论组不需要加群；私密群只能先用同一个账号加入。诊断：${diag.slice(-2).join("；")}`,
      );
    }
    throw new Error(
      `定位不到帖子的讨论组（6 条路都试过）。诊断：${diag.slice(-3).join("；")}`,
    );
  }

  // 有 ID 但没有任何 hash / username：拼不出 InputChannel，也解析不了实体。
  // 这种情况只出现在「私密讨论组 + 账号不是成员」，平台层面就只给成员读。
  if (!group.accessHash && !group.username) {
    logger.warn({ postId, groupId: group.id, diag }, "讨论组拿不到 access_hash");
    throw new Error(
      `已定位讨论组（ID ${group.id}），但拿不到 access_hash —— 这种情况只出现在「私密讨论组 + 登录账号不在群里」，` +
        `公开讨论组不需要加群。若这个群是私密群，需要先用同一个 Telegram 账号加入该群，再重试这条链接。诊断：${diag
          .slice(-2)
          .join("；")}`,
    );
  }

  logger.info(
    {
      postId,
      groupId: group.id,
      groupTitle: group.title,
      hasHash: Boolean(group.accessHash),
      hasUsername: Boolean(group.username),
      steps: diag.length,
    },
    "已定位帖子的关联讨论组",
  );
  return { ...group, entityKey: discussionEntityKey(group) };
}
