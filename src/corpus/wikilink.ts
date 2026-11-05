import type { WikiPage } from "./pages.js";

/**
 * wikilink 提取（spec #1）。
 * Obsidian 语法：`[[目标]]` 与 `[[目标|显示]]`；目标可带 `#锚点`（解析时剥掉，只保留页面目标）。
 */

export interface Wikilink {
  /** 链接目标（标题、别名或文件名，已 trim、已剥锚点）。 */
  target: string;
  /** `[[目标|显示]]` 的显示部分；无 `|` 时为 null。 */
  display: string | null;
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
    links.push({ target, display });
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

/** 在名字清单中解析一个 wikilink 目标，返回命中的页面路径；未命中返回 null。 */
export function resolveWikilinkTarget(nameIndex: PageRef[], target: string): string | null {
  return nameIndex.find((ref) => ref.name === target)?.pagePath ?? null;
}
