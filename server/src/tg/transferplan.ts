import path from "node:path";

/**
 * 移动 / 复制的路径规划。
 *
 * 纯逻辑：不 import db / env / fs，自检可以直接调。
 * 真正落盘与数据库同步在 transfer.ts。
 */

export type TransferAction = "move" | "copy";

export interface TransferInput {
  /** 源路径（绝对路径） */
  path: string;
  kind: "file" | "folder";
}

export interface TransferPlanItem {
  from: string;
  to: string;
  kind: "file" | "folder";
  name: string;
}

export interface TransferPlan {
  /** 可以执行的项目 */
  items: TransferPlanItem[];
  /** 不执行的项目及原因（目标已存在、移到原位、移进自己等） */
  skipped: Array<{ from: string; reason: string }>;
}

/** child 是否在 parent 之下（含相等） */
export function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 规划一次批量移动 / 复制。
 *
 * 每个源条目在目标目录下保持原名（不支持批量改名 —— 那样冲突处理会变得难以预测，
 * 单个条目要改名请用「重命名文件」）。目标已存在时跳过而不是覆盖：
 * 这些是用户的影视文件，静默覆盖是不可接受的损失。
 */
export function planTransfer(
  inputs: TransferInput[],
  destRoot: string,
  exists: (target: string) => boolean,
): TransferPlan {
  const root = path.resolve(destRoot);
  const items: TransferPlanItem[] = [];
  const skipped: Array<{ from: string; reason: string }> = [];
  const taken = new Set<string>();

  for (const input of inputs) {
    const from = path.resolve(input.path);
    const name = path.basename(from);
    const to = path.join(root, name);

    if (from === to) {
      skipped.push({ from, reason: "已经在这个目录里了" });
      continue;
    }
    // 把目录移进它自己的子目录 → 会边搬边丢文件
    if (input.kind === "folder" && isUnder(root, from)) {
      skipped.push({ from, reason: "不能移到自己内部" });
      continue;
    }
    if (taken.has(to) || exists(to)) {
      skipped.push({ from, reason: "目标位置已有同名文件或目录" });
      continue;
    }
    taken.add(to);
    items.push({ from, to, kind: input.kind, name });
  }

  return { items, skipped };
}

/**
 * 把一条记录里的路径前缀从 from 换成 to。
 *
 * 返回 null 表示这条记录不受影响（不在被移动的范围内）。
 * 移动剧集目录时，downloads.file_path / media_sources.path 都要跟着走，
 * 否则元数据页会指向一个已经不存在的旧位置。
 */
export function replacePrefix(value: string, from: string, to: string): string | null {
  const abs = path.resolve(value);
  const src = path.resolve(from);
  if (abs === src) return to;
  if (!abs.startsWith(src + path.sep)) return null;
  return path.join(to, abs.slice(src.length + 1));
}
