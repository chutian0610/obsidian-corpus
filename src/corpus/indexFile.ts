import { writeFile } from "node:fs/promises";
import { readOptionalFile } from "./fs.js";
import { INDEX_FILE, resolveInCorpus, toCorpusRel } from "./paths.js";
import type { PageMeta } from "./frontmatter.js";
import type { WikiPage } from "./pages.js";

/**
 * Index（索引，index.md）格式（spec #1，条目行加列表前缀便于 markdown 渲染）：
 * - `## Sources` 节：每行 `- [[来源页标题]] — raw/<路径>`
 * - `## Topics` 节：每行 `- [[主题页标题]]`，别名以全角括号附注
 * 解析兼容无前缀的旧格式行——apply 整体重渲染时自动迁移为列表格式。
 */
export const INDEX_SOURCES_HEADING = "## Sources";
export const INDEX_TOPICS_HEADING = "## Topics";
/** 条目行的 markdown 列表前缀。 */
export const INDEX_ENTRY_BULLET = "- ";
/** Sources 行：`[[来源页标题]] — raw/<路径>`（em dash 两侧各一空格）。 */
export const INDEX_SOURCE_SEPARATOR = " — ";
/** Topics 行别名附注：`[[主题页标题]]（别名：a、b）`。 */
export const INDEX_ALIASES_NOTE_PREFIX = "（别名：";
export const INDEX_ALIASES_NOTE_SUFFIX = "）";
export const INDEX_ALIASES_JOIN = "、";

export interface SourceIndexEntry {
  /** 来源页标题。 */
  title: string;
  /** raw 相对路径（形如 raw/xxx.md）。 */
  sourcePath: string;
}

export interface TopicIndexEntry {
  /** 主题页标题（缺省取文件名的那份标题，与 wikilink 一致）。 */
  title: string;
  aliases: string[];
}

export interface IndexData {
  sources: SourceIndexEntry[];
  topics: TopicIndexEntry[];
}

export function formatSourceEntry(entry: SourceIndexEntry): string {
  return `${INDEX_ENTRY_BULLET}[[${entry.title}]]${INDEX_SOURCE_SEPARATOR}${entry.sourcePath}`;
}

export function formatTopicEntry(entry: TopicIndexEntry): string {
  const base = `${INDEX_ENTRY_BULLET}[[${entry.title}]]`;
  if (entry.aliases.length === 0) {
    return base;
  }
  return `${base}${INDEX_ALIASES_NOTE_PREFIX}${entry.aliases.join(INDEX_ALIASES_JOIN)}${INDEX_ALIASES_NOTE_SUFFIX}`;
}

// 前缀可选：兼容既有 corpus 里无 `- ` 的旧格式行。
const SOURCE_ENTRY_RE = /^(?:- )?\[\[([^\]]+)\]\] — (.+)$/u;
const TOPIC_ENTRY_RE = /^(?:- )?\[\[([^\]]+)\]\](?:（别名：(.+?)）)?$/u;

/** 渲染整个 index.md 内容（两节顺序固定：Sources 在前、Topics 在后）。 */
export function renderIndex(data: IndexData): string {
  const parts: string[] = [INDEX_SOURCES_HEADING, ""];
  for (const entry of data.sources) {
    parts.push(formatSourceEntry(entry));
  }
  parts.push("", INDEX_TOPICS_HEADING, "");
  for (const entry of data.topics) {
    parts.push(formatTopicEntry(entry));
  }
  parts.push("");
  return parts.join("\n");
}

/** 解析 index.md 内容；无法识别的行忽略（lint 票再做严格对账）。 */
export function parseIndex(text: string): IndexData {
  const data: IndexData = { sources: [], topics: [] };
  let section: "sources" | "topics" | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === INDEX_SOURCES_HEADING) {
      section = "sources";
      continue;
    }
    if (trimmed === INDEX_TOPICS_HEADING) {
      section = "topics";
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (section === "sources") {
      const m = trimmed.match(SOURCE_ENTRY_RE);
      if (m) {
        data.sources.push({ title: m[1] ?? "", sourcePath: m[2] ?? "" });
      }
    } else if (section === "topics") {
      const m = trimmed.match(TOPIC_ENTRY_RE);
      if (m) {
        data.topics.push({
          title: m[1] ?? "",
          aliases: m[2] ? m[2].split(INDEX_ALIASES_JOIN) : [],
        });
      }
    }
  }
  return data;
}

/** 读 corpus 根的 index.md；不存在返回空索引。 */
export async function readIndex(corpusRoot: string): Promise<IndexData> {
  const abs = resolveInCorpus(corpusRoot, INDEX_FILE);
  const text = await readOptionalFile(abs);
  return text === null ? { sources: [], topics: [] } : parseIndex(text);
}

/** 整体覆写 index.md（由 apply 在单个变更批次内联动调用）。 */
export async function writeIndex(corpusRoot: string, data: IndexData): Promise<string> {
  const abs = resolveInCorpus(corpusRoot, INDEX_FILE);
  await writeFile(abs, renderIndex(data), "utf8");
  return toCorpusRel(corpusRoot, abs);
}

/** index 联动的写入页入参：apply 变更计划中一页的标题与解析后的 frontmatter。 */
export interface IndexPageInput {
  title: string;
  meta: PageMeta;
}

/** index 联动（apply 用）：移除一页对应的行（按变更前的标题/来源匹配；不在则无操作）。 */
export function removeIndexEntries(data: IndexData, page: Pick<WikiPage, "title" | "meta">): void {
  const meta = page.meta;
  if (meta.type === "source") {
    const sourcePath = meta.source;
    const i = data.sources.findIndex((e) => e.title === page.title && e.sourcePath === sourcePath);
    if (i >= 0) {
      data.sources.splice(i, 1);
    }
  } else {
    const i = data.topics.findIndex((e) => e.title === page.title);
    if (i >= 0) {
      data.topics.splice(i, 1);
    }
  }
}

/** index 联动（apply 用）：登记一个写入页（来源页进 Sources 节、主题页进 Topics 节）。 */
export function appendIndexEntries(data: IndexData, page: IndexPageInput): void {
  if (page.meta.type === "source") {
    data.sources.push({ title: page.title, sourcePath: page.meta.source });
  } else {
    data.topics.push({ title: page.title, aliases: page.meta.aliases });
  }
}
