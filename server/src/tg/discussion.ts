import { Api, TelegramClient } from "telegram";
import { logger } from "../logger";
import { discussionEntityKey, idString, pickDiscussionGroup, type DiscussionGroup } from "./discussionplan";

/**
 * 取「频道帖子的关联讨论组」。
 *
 * `https://t.me/<频道>/<帖子>?comment=<评论ID>` 里的评论不在频道里：
 * 帖子被转发进关联的 megagroup，评论 ID 是讨论组内部的消息 ID。
 * 必须先用 messages.GetDiscussionMessage 找到那个组，再用它作为 peer 取消息。
 *
 * GramJS 的 invoke 会把返回的 chats 放进 entityCache，之后
 * `getEntity("-100<id>")` 能直接命中；公开讨论组还会返回 username，
 * 用它当 entityKey 最稳（进程重启后也能 ResolveUsername）。
 */

export interface ResolvedDiscussion extends DiscussionGroup {
  /** 交给 getEntity 的键 */
  entityKey: string;
}

function explain(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  // RPCError 的 message 常是 CHANNEL_INVALID / MESSAGE_ID_INVALID 之类，留着方便排障
  return text.slice(0, 160);
}

export async function resolveDiscussionGroup(
  client: TelegramClient,
  channelEntity: unknown,
  postId: number,
): Promise<ResolvedDiscussion> {
  let payload: unknown;
  try {
    payload = await client.invoke(
      new Api.messages.GetDiscussionMessage({
        peer: channelEntity as never,
        msgId: postId,
      }),
    );
  } catch (err) {
    logger.warn({ postId, err: explain(err) }, "读取帖子评论区失败");
    throw new Error(
      `读取帖子评论区失败（${explain(err) || "未知错误"}）：请确认这个帖子开了评论、且登录的账号已加入关联讨论组`,
    );
  }

  const selfId = idString((channelEntity as { id?: unknown } | null)?.id);
  const group = pickDiscussionGroup(payload, selfId);
  if (!group) {
    throw new Error("这个帖子没有开启评论，或当前账号不在关联讨论组里（需先加入讨论组）");
  }
  logger.info({ postId, groupId: group.id, groupTitle: group.title }, "已定位帖子的关联讨论组");
  return { ...group, entityKey: discussionEntityKey(group) };
}
