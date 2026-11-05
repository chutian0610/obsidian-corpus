/**
 * wikilink 提取（spec #1）。
 * Obsidian 语法：`[[目标]]` 与 `[[目标|显示]]`；目标可带 `#锚点`（解析时剥掉，只保留页面目标）。
 */

export interface Wikilink {
  /** 链接目标（标题、别名或文件名，已 trim、已剥锚点）。 */
  target: string;
  /** `[[目标|显示]]` 的显示部分；无 `|` 时为 null。 */
  display: string | null;
  /** 在正文中的起始偏移（lint 定位用）。 */
  offset: number;
}

const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/gu;

export function extractWikilinks(body: string): Wikilink[] {
  const links: Wikilink[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const inner = (match[1] ?? "").trim();
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
    links.push({ target, display, offset: match.index ?? 0 });
  }
  return links;
}

export interface PageRef {
  /** wikilink 可命中的名字：页面标题与别名。 */
  name: string;
  /** 对应 wiki/ 内相对路径。 */
  pagePath: string;
}

/**
 * 把页面（标题 + 别名）展开为 wikilink 可解析的名字清单。
 * apply/lint 校验「wikilink 目标存在性（含别名解析）」时使用。
 */
export function buildNameIndex(pages: Array<{ pagePath: string; title: string; aliases: string[] }>): PageRef[] {
  const refs: PageRef[] = [];
  for (const page of pages) {
    if (page.title.trim() !== "") {
      refs.push({ name: page.title, pagePath: page.pagePath });
    }
    for (const alias of page.aliases) {
      refs.push({ name: alias, pagePath: page.pagePath });
    }
  }
  return refs;
}

/** 在名字清单中解析一个 wikilink 目标，返回命中的页面路径；未命中返回 null。 */
export function resolveWikilinkTarget(nameIndex: PageRef[], target: string): string | null {
  return nameIndex.find((ref) => ref.name === target)?.pagePath ?? null;
}
