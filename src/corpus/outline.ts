import { markdownParser } from "./markdown.js";
import { splitFrontmatter } from "./frontmatter.js";

/**
 * 原文大纲（#34）：按标题把一份 markdown 材料切成互不重叠的行区间，供 agent 起草后逐节核对覆盖度。
 * - 标题判定走 remark-parse（mdast）：代码围栏内的 `#` 行不是标题。
 * - 首个标题之前的非空内容计为 level 0 条目，保证条目合起来覆盖全文。
 * - frontmatter 先剥掉再解析（否则会被当成 setext 标题），行号按其在原文中的真实位置计。
 * 不做任何内容判断：只回答「每一节在第几行到第几行」。
 */

export interface OutlineEntry {
  /** 标题层级 1-6；首个标题之前的内容为 0。 */
  level: number;
  /** 标题文本（行内标记已展平为纯文本）；标题前内容为「（标题前内容）」。 */
  title: string;
  /** 起始行（1 起）：标题所在行；标题前内容从第 1 行起。 */
  startLine: number;
  /** 结束行（含）：下一标题的前一行，末条目到文件末行。 */
  endLine: number;
}

/** 大纲条目上限：行窗口为防爆 context 而设，大纲同样要有界（标题极密的病态材料才会触达）。 */
export const OUTLINE_MAX_ENTRIES = 500;

/** 首个标题前内容的条目标题。 */
export const OUTLINE_PREAMBLE_TITLE = "（标题前内容）";

/** mdast 节点的结构化最小类型（避免深引 unist 工具类型）。 */
interface MdNode {
  type: string;
  value?: unknown;
  depth?: unknown;
  children?: MdNode[];
  position?: { start: { line: number } };
}

interface HeadingLine {
  level: number;
  title: string;
  line: number;
}

/** 展平节点下的文本（text / inlineCode 取 value，容器节点递归子节点）。 */
function textOf(node: MdNode): string {
  if (node.type === "text" || node.type === "inlineCode") {
    return String(node.value ?? "");
  }
  return (node.children ?? []).map(textOf).join("");
}

function collectHeadings(node: MdNode, out: HeadingLine[]): void {
  if (node.type === "heading" && node.position) {
    out.push({
      level: Number(node.depth ?? 0),
      title: (node.children ?? []).map(textOf).join("").trim(),
      line: node.position.start.line,
    });
    return;
  }
  for (const child of node.children ?? []) {
    collectHeadings(child, out);
  }
}

/** 提取大纲：条目按出现顺序，区间互不重叠且合起来覆盖全文（行号按 split("\n") 计，与行窗口一致）。 */
export function extractOutline(text: string): OutlineEntry[] {
  const lines = text.split("\n");
  const totalLines = lines.length;
  // frontmatter 剥掉再解析；行号偏移 = frontmatter 块占用的换行数
  const { body } = splitFrontmatter(text);
  const lineOffset = (text.slice(0, text.length - body.length).match(/\n/gu) ?? []).length;

  const found: HeadingLine[] = [];
  collectHeadings(markdownParser.parse(body) as unknown as MdNode, found);
  const headings = found
    .map((h) => ({ ...h, line: h.line + lineOffset }))
    .filter((h) => h.level >= 1 && h.level <= 6);

  const entries: OutlineEntry[] = [];
  // 首个标题之前（frontmatter 之后）若有非空内容，计为 level 0 条目——frontmatter 本身不算内容
  const bodyStartLine = lineOffset + 1;
  const firstHeadingLine = headings[0]?.line ?? totalLines + 1;
  if (lines.slice(bodyStartLine - 1, firstHeadingLine - 1).some((line) => line.trim() !== "")) {
    entries.push({
      level: 0,
      title: OUTLINE_PREAMBLE_TITLE,
      startLine: bodyStartLine,
      endLine: firstHeadingLine - 1,
    });
  }
  headings.forEach((h, i) => {
    entries.push({
      level: h.level,
      title: h.title,
      startLine: h.line,
      endLine: (headings[i + 1]?.line ?? totalLines + 1) - 1,
    });
  });
  return entries;
}
