import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInCorpus, toCorpusRel, WIKI_DIR } from "./paths.js";
import { parseWikiPage, topicTitleFromMeta, type PageMeta } from "./frontmatter.js";

/** wiki 层的平铺页面清单：status 计数、apply 的 wikilink 目标校验、lint 对账共用。 */
export interface WikiPage {
  /** wiki/ 内相对路径（POSIX 风格）。 */
  pagePath: string;
  /** 文件名（去扩展名）；主题页缺省标题来源于它。 */
  fileName: string;
  meta: PageMeta;
  /** 最终标题：来源页必为 frontmatter title，主题页缺省取文件名。 */
  title: string;
  /** wikilink 可解析的名字（标题 + 别名）。 */
  names: string[];
  /** frontmatter 校验问题（lint 报告用；此处不抛错）。 */
  issues: Array<{ field: string; message: string }>;
}

/** 扫描 wiki/ 全部 .md（平铺一层；spec：wiki/ 平铺、中文文件名）。 */
export async function collectWikiPages(corpusRoot: string): Promise<WikiPage[]> {
  const wikiAbs = resolveInCorpus(corpusRoot, WIKI_DIR);
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdir(wikiAbs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const pages: WikiPage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const abs = path.join(wikiAbs, entry.name);
    const text = await readFile(abs, "utf8");
    const result = parseWikiPage(text);
    const pagePath = toCorpusRel(corpusRoot, abs);
    const fileName = entry.name.replace(/\.md$/u, "");
    if (result.ok) {
      const title =
        result.meta.type === "source"
          ? result.meta.title
          : topicTitleFromMeta(result.meta, fileName);
      pages.push({
        pagePath,
        fileName,
        meta: result.meta,
        title,
        names: [title, ...result.meta.aliases],
        issues: [],
      });
    } else {
      pages.push({
        pagePath,
        fileName,
        meta: { type: "source", source: "", title: "", created: "", aliases: [] },
        title: fileName,
        names: [fileName],
        issues: result.issues,
      });
    }
  }
  pages.sort((a, b) => a.pagePath.localeCompare(b.pagePath, "zh-Hans-CN"));
  return pages;
}
