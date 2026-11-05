/**
 * Telegram 消息链接解析（纯函数，不 import db / env / telegram）。
 *
 * 之所以单独成文件：`direct.ts` 顶层会连数据库，自检脚本不能静态 import；
 * 而链接解析是最该被自检覆盖的一层（评论链接曾经被静默当成主帖）。
 *
 * 支持的形态：
 *   https://t.me/<用户名>/<帖子ID>
 *   https://t.me/c/<内部ID>/<帖子ID>
 *   https://t.me/<用户名>/<帖子ID>?comment=<评论ID>      ← 帖子评论区的单条评论
 *   https://t.me/c/<内部ID>/<帖子ID>?comment=<评论ID>
 *   以上都可以省略协议、带 www.、用 telegram.me、带 ?single 等查询串。
 */

export interface ParsedLink {
  kind: "public" | "private";
  /** 公开频道用户名（小写） */
  username: string | null;
  /** 私有频道 t.me/c/<id> 里的内部 ID */
  internalId: string | null;
  /** 路径里的消息 ID（评论链接里是「帖子 ID」，不是评论 ID） */
  messageId: number;
  raw: string;
  /** 帖子 ID：只有评论链接才有值，等于 messageId */
  postId: number | null;
  /** 评论消息 ID（讨论组里的 id）：来自 ?comment= */
  commentId: number | null;
}

/** 从链接里取 ?comment=<id>；顺便兼容 &comment=、#fragment、?thread=...&comment=... */
export function commentIdOf(raw: string): number | null {
  const text = String(raw ?? "");
  const matched = /(?:[?&]|^)comment=(\d+)/i.exec(text.split("#")[0]);
  if (!matched) return null;
  const id = Number(matched[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 支持 t.me/<用户名>/<id>、t.me/c/<内部ID>/<id>，带查询串也能认 */
export function parseTelegramLink(input: string): ParsedLink | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const text = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^(?:www\.)?(?:t|telegram)\.me\//i, "")
    .replace(/^@?/, "")
    .trim();
  if (!text) return null;

  // 查询串不参与「频道 / 帖子」的匹配，否则 ?comment=55488 会被当成路径的一部分。
  // 这里沿用旧版「匹配到第一个数字即停」的宽松规则，避免把历史能认的链接挡掉。
  const q = text.indexOf("?");
  const head = q >= 0 ? text.slice(0, q) : text;
  const commentId = q >= 0 ? commentIdOf(text) : null;

  const priv = /^c\/(\d+)\/(\d+)/i.exec(head);
  if (priv) {
    return {
      kind: "private",
      username: null,
      internalId: priv[1],
      messageId: Number(priv[2]),
      raw,
      postId: commentId ? Number(priv[2]) : null,
      commentId,
    };
  }
  const pub = /^([A-Za-z0-9_]{3,})\/(\d+)/i.exec(head);
  if (pub) {
    return {
      kind: "public",
      username: pub[1].toLowerCase(),
      internalId: null,
      messageId: Number(pub[2]),
      raw,
      postId: commentId ? Number(pub[2]) : null,
      commentId,
    };
  }
  return null;
}

/** 从一段文字里挑出所有 Telegram 消息链接（机器人收消息时用），查询串原样保留 */
export function extractTelegramLinks(text: string): string[] {
  const re = /(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:c\/\d+|[A-Za-z0-9_]{3,})\/\d+(?:\?\S*)?/gi;
  const found = String(text ?? "").match(re) ?? [];
  return [...new Set(found.map((s) => s.trim()))];
}

/** 这条链接指向的是帖子评论区里的某条评论 */
export function isCommentLink(parsed: ParsedLink | null): boolean {
  return Boolean(parsed && parsed.commentId && parsed.postId);
}
