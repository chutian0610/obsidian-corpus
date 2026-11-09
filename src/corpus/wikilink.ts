import { unified } from "unified";
import remarkParse from "remark-parse";
import type { WikiPage } from "./pages.js";

/**
 * wikilink 提取（spec #1；#21 起改为 mdast 解析，见 ADR-0007）。
 * Obsidian 语法：`[[目标]]`、`[[目标|显示]]`、嵌入 `![[目标]]`；目标可带 `#锚点`（解析时剥掉，只保留页面目标）。
 *
 * 提取基于 remark-parse 的 AST，只扫**文本节点**：代码围栏 / 行内代码 / HTML 注释的内容挂在
 * code/inlineCode/html 节点的 value 上而非 text 节点，天然不会被扫到——代码示例里的 `[[ ]]`
 * 字面量不再是链接边。文本节点内先剥 Obsidian `%%注释%%` 与 `$数学$` 定界符再跑链接正则。
 */

export interface Wikilink {
  /** 链接目标（标题、别名或文件名，已 trim、已剥锚点）。 */
  target: string;
  /** `[[目标|显示]]` 的显示部分；无 `|` 时为 null。 */
  display: string | null;
  /** `![[...]]` 嵌入（图片/附件/整页）。嵌入目标可能是附件，不参与目标存在性校验（#21）。 */
  embed: boolean;
}

/** 解析器复用（remark-parse 纯函数、无状态）。 */
const parser = unified().use(remarkParse);

/** mdast 节点的结构化最小类型（避免深引 unist 工具类型）。 */
interface MdNode {
  type: string;
  value?: unknown;
  children?: MdNode[];
}

/** 文本节点内的链接正则：可选 `!` 前缀（嵌入）+ 双括号体。 */
const WIKILINK_RE = /(!?)\[\[([^\[\]]+?)\]\]/gu;

/** 在单个文本节点内容里扫描 wikilink（先剥 Obsidian 注释与数学定界符）。 */
function scanTextChunk(text: string, links: Wikilink[]): void {
  const cleaned = text
    .replace(/%%[\s\S]*?%%/gu, " ")
    .replace(/\$\$[\s\S]*?\$\$/gu, " ")
    .replace(/\$[^$\n]+\$/gu, " ");
  for (const match of cleaned.matchAll(WIKILINK_RE)) {
    const embed = match[1] === "!";
    const inner = (match[2] ?? "").trim();
    if (inner === "") {
      continue;
    }
    const pipe = inner.indexOf("|");
    const left = pipe === -1 ? inner : inner.slice(0, pipe);
    const display = pipe === -1 ? null : inner.slice(pipe + 1).trim();
    const target = left.split("#")[0]?.trim() ?? "";
    if (target === "") {
      continue;
    }
    links.push({ target, display, embed });
  }
}

/** 提取一段正文里的全部 wikilink（代码块/行内代码/HTML 注释内的不算）。 */
export function extractWikilinks(body: string): Wikilink[] {
  const links: Wikilink[] = [];
  const visit = (node: MdNode): void => {
    if (node.type === "text") {
      scanTextChunk(String(node.value ?? ""), links);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(parser.parse(body) as unknown as MdNode);
  return links;
}

export interface PageRef {
  /** wikilink 可命中的名字：页面标题与别名。 */
  name: string;
  /** 对应 wiki/ 内相对路径。 */
  pagePath: string;
}

/**
 * 把页面清单展开为 wikilink 可解析的名字索引（WikiPage.names 已含标题 + 别名）。
 * apply/lint 校验「wikilink 目标存在性（含别名解析）」时使用；
 * apply 对本批新建/更新页以 { pagePath, names } 子集合成传入。
 */
export function buildNameIndex(pages: Array<Pick<WikiPage, "pagePath" | "names">>): PageRef[] {
  const refs: PageRef[] = [];
  for (const page of pages) {
    for (const name of page.names) {
      if (name.trim() !== "") {
        refs.push({ name, pagePath: page.pagePath });
      }
    }
  }
  return refs;
}

/** 在名字清单中解析一个 wikilink 目标，返回命中的页面路径；未命中返回 null。大小写不敏感（对齐 Obsidian 文件名解析）。 */
export function resolveWikilinkTarget(nameIndex: PageRef[], target: string): string | null {
  const lower = target.toLowerCase();
  return nameIndex.find((ref) => ref.name.toLowerCase() === lower)?.pagePath ?? null;
}
