import fs from "node:fs";
import path from "node:path";

/**
 * NFO（Emby / Kodi 的 XML 元数据）读取与就地改写。
 *
 * 目标：既能用表单改常见字段，又不破坏用户手写的其它标签。
 * 做法是「定位 + 局部替换」：扫描出根节点下每个直接子标签在原文里的位置，
 * 只替换目标标签的内容，其余字节原样保留（包括注释、嵌套的 actor 块、未知标签）。
 */

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface NfoChild {
  name: string;
  attrs: string;
  /** 内层文本（已 trim，未反转义） */
  value: string;
  /** 整个 <tag>…</tag> 在原文中的区间 */
  blockStart: number;
  blockEnd: number;
  /** 内层内容区间（自闭合时与 blockEnd 相同） */
  innerStart: number;
  innerEnd: number;
  /** 内层还包含子标签（如 <actor><name/></actor>） */
  nested: boolean;
}

export interface ParsedNfo {
  root: string;
  raw: string;
  children: NfoChild[];
  /** 根节点闭合标签的起始下标，用于追加新标签 */
  insertAt: number;
}

const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/** 只解析一层：根元素 + 其直接子元素 */
export function parseNfo(raw: string): ParsedNfo | null {
  const rootMatch = /<([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(raw);
  if (!rootMatch) return null;
  const root = rootMatch[1];
  if (!root) return null;
  const rootStart = rootMatch.index + rootMatch[0].length;
  const closeIdx = raw.lastIndexOf(`</${root}`);
  if (closeIdx < rootStart) return null;

  const content = raw.slice(0, closeIdx);
  const children: NfoChild[] = [];
  TAG_RE.lastIndex = rootStart;

  let depth = 0;
  let open: { name: string; attrs: string; start: number; innerStart: number } | null = null;
  let hasNested = false;

  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(content))) {
    const [full, closing, name, attrs, selfClose] = m;
    const tagStart = m.index;
    if (tagStart < rootStart) continue;

    if (closing === "/") {
      if (!open) continue;
      if (name !== open.name) continue;
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      children.push({
        name: open.name,
        attrs: open.attrs,
        value: unescapeXml(content.slice(open.innerStart, tagStart)).trim(),
        blockStart: open.start,
        blockEnd: tagStart + full.length,
        innerStart: open.innerStart,
        innerEnd: tagStart,
        nested: hasNested,
      });
      open = null;
      hasNested = false;
      continue;
    }

    if (!open) {
      open = { name, attrs, start: tagStart, innerStart: tagStart + full.length };
      if (selfClose === "/") {
        children.push({
          name,
          attrs,
          value: "",
          blockStart: tagStart,
          blockEnd: tagStart + full.length,
          innerStart: tagStart + full.length,
          innerEnd: tagStart + full.length,
          nested: false,
        });
        open = null;
      }
      hasNested = false;
      continue;
    }
    if (selfClose === "/") {
      hasNested = true;
      continue;
    }
    depth += 1;
    hasNested = true;
  }

  return { root, raw, children, insertAt: closeIdx };
}

/* ------------------------------ 字段模型 ------------------------------ */

/** 表单里可编辑的字段；值与 NFO 标签一一对应 */
export interface NfoFields {
  title: string;
  originaltitle: string;
  showtitle: string;
  season: string;
  episode: string;
  year: string;
  aired: string;
  premiered: string;
  plot: string;
  outline: string;
  studio: string;
  rating: string;
  tags: string[];
  genres: string[];
}

export const EMPTY_FIELDS: NfoFields = {
  title: "",
  originaltitle: "",
  showtitle: "",
  season: "",
  episode: "",
  year: "",
  aired: "",
  premiered: "",
  plot: "",
  outline: "",
  studio: "",
  rating: "",
  tags: [],
  genres: [],
};

const SCALAR_TAGS = [
  "title",
  "originaltitle",
  "showtitle",
  "season",
  "episode",
  "year",
  "aired",
  "premiered",
  "plot",
  "outline",
  "studio",
  "rating",
] as const;

/** 从已解析的 NFO 读出一份表单值（同名标签取第一个非空） */
export function fieldsFromNfo(parsed: ParsedNfo | null): NfoFields {
  const fields: NfoFields = { ...EMPTY_FIELDS, tags: [], genres: [] };
  if (!parsed) return fields;
  for (const tag of SCALAR_TAGS) {
    const hit = parsed.children.find((c) => c.name === tag && !c.nested);
    if (hit) fields[tag] = hit.value;
  }
  fields.tags = parsed.children.filter((c) => c.name === "tag" && !c.nested).map((c) => c.value).filter(Boolean);
  fields.genres = parsed.children
    .filter((c) => c.name === "genre" && !c.nested)
    .map((c) => c.value)
    .filter(Boolean);
  return fields;
}

type Splice = { start: number; end: number; text: string };

function buildScalar(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function buildList(name: string, values: string[], indent: string): string {
  return values.map((v) => `${indent}<${name}>${escapeXml(v)}</${name}>`).join("\n");
}

/** 向上吃到行首（前导只有空白时），删除/替换时连缩进一起处理，避免留下空行与错位 */
function lineStartOf(raw: string, pos: number): number {
  const nl = raw.lastIndexOf("\n", Math.max(0, pos - 1));
  const start = nl + 1;
  return raw.slice(start, pos).trim() === "" ? start : pos;
}

/** 向下吃到行尾（其后只有空白时） */
function lineEndOf(raw: string, pos: number): number {
  const nl = raw.indexOf("\n", pos);
  if (nl < 0) return pos;
  return raw.slice(pos, nl).trim() === "" ? nl + 1 : pos;
}

/** 把表单值合并回原 NFO 文本，保留其它标签 */
export function applyFields(parsed: ParsedNfo, fields: NfoFields): string {
  const splices: Splice[] = [];
  const inserts: string[] = [];

  for (const tag of SCALAR_TAGS) {
    const value = (fields[tag] ?? "").trim();
    const hits = parsed.children.filter((c) => c.name === tag && !c.nested);
    if (hits.length === 0) {
      if (value) inserts.push(`  ${buildScalar(tag, value)}`);
      continue;
    }
    if (!value) {
      // 清空即删除，避免残留空标签被 Emby 当作有效值
      for (const hit of hits) {
        splices.push({ start: lineStartOf(parsed.raw, hit.blockStart), end: lineEndOf(parsed.raw, hit.blockEnd), text: "" });
      }
      continue;
    }
    const [first, ...rest] = hits;
    splices.push({ start: first.blockStart, end: first.blockEnd, text: buildScalar(tag, value) });
    for (const extra of rest) {
      splices.push({ start: lineStartOf(parsed.raw, extra.blockStart), end: lineEndOf(parsed.raw, extra.blockEnd), text: "" });
    }
  }

  for (const [name, values] of [
    ["tag", fields.tags],
    ["genre", fields.genres],
  ] as Array<[string, string[]]>) {
    const cleaned = values.map((v) => v.trim()).filter(Boolean);
    const hits = parsed.children.filter((c) => c.name === name && !c.nested);
    if (cleaned.length === 0) {
      for (const hit of hits) {
        splices.push({ start: lineStartOf(parsed.raw, hit.blockStart), end: lineEndOf(parsed.raw, hit.blockEnd), text: "" });
      }
      continue;
    }
    const block = buildList(name, cleaned, "  ");
    if (hits.length === 0) {
      inserts.push(block);
      continue;
    }
    splices.push({ start: lineStartOf(parsed.raw, hits[0].blockStart), end: lineEndOf(parsed.raw, hits[0].blockEnd), text: `${block}\n` });
    for (const extra of hits.slice(1)) {
      splices.push({ start: lineStartOf(parsed.raw, extra.blockStart), end: lineEndOf(parsed.raw, extra.blockEnd), text: "" });
    }
  }

  // 从后往前替换，前面的下标不受影响
  splices.sort((a, b) => b.start - a.start);
  let out = parsed.raw;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);

  if (inserts.length > 0) {
    const closeAt = out.lastIndexOf(`</${parsed.root}`);
    if (closeAt > 0) out = `${out.slice(0, closeAt)}${inserts.join("\n")}\n${out.slice(closeAt)}`;
  }

  // 删除标签后可能留下空行，收一下但不改语义
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

/** 没有 NFO 时按表单值新建一份完整文件 */
export function buildNfo(kind: "episode" | "show", fields: NfoFields): string {
  const HEAD = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>';
  const lines: string[] = [];
  const push = (tag: string, value: string) => {
    if (value.trim()) lines.push(`  ${buildScalar(tag, value.trim())}`);
  };

  if (kind === "episode") {
    const tag = fields.season && fields.episode ? `S${fields.season.padStart(2, "0")}E${fields.episode.padStart(2, "0")}` : "";
    const title = fields.title.trim() || (tag || fields.showtitle || "未命名");
    lines.push(`${HEAD}`, "<episodedetails>");
    lines.push(`  <title>${escapeXml(title)}</title>`);
    push("originaltitle", fields.originaltitle);
    push("showtitle", fields.showtitle);
    push("season", fields.season);
    push("episode", fields.episode);
    push("plot", fields.plot);
    push("outline", fields.outline || fields.plot.replace(/\s+/g, " ").slice(0, 200));
    if (fields.tags.length) lines.push(buildList("tag", fields.tags, "  "));
    if (fields.genres.length) lines.push(buildList("genre", fields.genres, "  "));
    push("studio", fields.studio);
    push("rating", fields.rating);
    push("aired", fields.aired);
    push("premiered", fields.premiered);
    push("year", fields.year);
    lines.push("</episodedetails>", "");
    return lines.join("\n");
  }

  lines.push(`${HEAD}`, "<tvshow>");
  push("title", fields.title);
  push("originaltitle", fields.originaltitle || fields.title);
  push("plot", fields.plot);
  if (fields.tags.length) lines.push(buildList("tag", fields.tags, "  "));
  if (fields.genres.length) lines.push(buildList("genre", fields.genres, "  "));
  push("studio", fields.studio);
  push("rating", fields.rating);
  push("premiered", fields.premiered || fields.aired);
  push("year", fields.year);
  lines.push("  <status>Continuing</status>");
  lines.push("</tvshow>", "");
  return lines.join("\n");
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** 原子写入：先写临时文件再 rename，避免 Emby 扫到半个文件 */
export async function writeTextAtomic(file: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, content, "utf8");
  await fs.promises.rename(tmp, file);
}

/** 只做最宽松的合法性检查：必须有根标签，避免把 JSON 之类写进去 */
export function validateNfo(content: string, kind: "episode" | "show"): string | null {
  const text = content.trim();
  if (!text) return "内容为空";
  if (text.length > 512 * 1024) return "文件过大（超过 512KB）";
  if (!/^<\?xml|^<[A-Za-z_]/.test(text)) return "不是有效的 XML 内容";
  const expect = kind === "episode" ? /<episodedetails[\s>]/ : /<tvshow[\s>]/;
  if (!expect.test(text)) {
    return kind === "episode" ? "缺少 <episodedetails> 根标签" : "缺少 <tvshow> 根标签";
  }
  return null;
}
