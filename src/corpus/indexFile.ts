import { writeFile } from "node:fs/promises";
import { readOptionalFile } from "./fs.js";
import { INDEX_FILE, resolveInCorpus, toCorpusRel } from "./paths.js";
import type { PageMeta } from "./frontmatter.js";
import type { WikiPage } from "./pages.js";

/**
 * Index（索引，index.md）格式（spec #1；#32 起三节）：
 * - `## Sources` 节：每行 `- [[来源页标题]] — raw/<路径>`
 * - `## Entities` 节：每行 `- [[实体页标题]]`，别名以全角括号附注
 * - `## Concepts` 节：每行 `- [[概念页标题]]`，别名以全角括号附注
 * 过渡兼容（ADR-0008）：旧 corpus 的 `## Topics` 节仍可解析（进 topics 桶），
 * 仅在非空时渲染；条目随迁移批次被 removeIndexEntries 摘除，空节自动消失。
 * 解析兼容无前缀的旧格式行——apply 整体重渲染时自动迁移为列表格式。
 */
export const INDEX_SOURCES_HEADING = "## Sources";
export const INDEX_ENTITIES_HEADING = "## Entities";
export const INDEX_CONCEPTS_HEADING = "## Concepts";
/** @deprecated 过渡兼容（ADR-0008）：存量 corpus 的待迁移节。 */
export const INDEX_TOPICS_HEADING = "## Topics";
/** 条目行的 markdown 列表前缀。 */
export const INDEX_ENTRY_BULLET = "- ";
/** Sources 行：`[[来源页标题]] — raw/<路径>`（em dash 两侧各一空格）。 */
export const INDEX_SOURCE_SEPARATOR = " — ";
/** 实体/概念行别名附注：`[[页标题]]（别名：a、b）`。 */
export const INDEX_ALIASES_NOTE_PREFIX = "（别名：";
export const INDEX_ALIASES_NOTE_SUFFIX = "）";
export const INDEX_ALIASES_JOIN = "、";

export interface SourceIndexEntry {
  /** 来源页标题。 */
  title: string;
  /** raw 相对路径（形如 raw/xxx.md）。 */
  sourcePath: string;
}

export interface NonSourceIndexEntry {
  /** 实体页/概念页标题（缺省取文件名的那份标题，与 wikilink 一致）。 */
  title: string;
  aliases: string[];
}

export interface IndexData {
  sources: SourceIndexEntry[];
  entities: NonSourceIndexEntry[];
  concepts: NonSourceIndexEntry[];
  /** @deprecated 过渡兼容（ADR-0008）：旧 Topics 节的存量条目，迁移完成后清空。 */
  topics: NonSourceIndexEntry[];
}

export function formatSourceEntry(entry: SourceIndexEntry): string {
  return `${INDEX_ENTRY_BULLET}[[${entry.title}]]${INDEX_SOURCE_SEPARATOR}${entry.sourcePath}`;
}

export function formatNonSourceEntry(entry: NonSourceIndexEntry): string {
  const base = `${INDEX_ENTRY_BULLET}[[${entry.title}]]`;
  if (entry.aliases.length === 0) {
    return base;
  }
  return `${base}${INDEX_ALIASES_NOTE_PREFIX}${entry.aliases.join(INDEX_ALIASES_JOIN)}${INDEX_ALIASES_NOTE_SUFFIX}`;
}

// 前缀可选：兼容既有 corpus 里无 `- ` 的旧格式行。
const SOURCE_ENTRY_RE = /^(?:- )?\[\[([^\]]+)\]\] — (.+)$/u;
const NON_SOURCE_ENTRY_RE = /^(?:- )?\[\[([^\]]+)\]\](?:（别名：(.+?)）)?$/u;

/** 渲染整个 index.md 内容（节顺序固定：Sources / Entities / Concepts；Topics 仅在非空时渲染）。 */
export function renderIndex(data: IndexData): string {
  const parts: string[] = [INDEX_SOURCES_HEADING, ""];
  for (const entry of data.sources) {
    parts.push(formatSourceEntry(entry));
  }
  parts.push("", INDEX_ENTITIES_HEADING, "");
  for (const entry of data.entities) {
    parts.push(formatNonSourceEntry(entry));
  }
  parts.push("", INDEX_CONCEPTS_HEADING, "");
  for (const entry of data.concepts) {
    parts.push(formatNonSourceEntry(entry));
  }
  if (data.topics.length > 0) {
    parts.push("", INDEX_TOPICS_HEADING, "");
    for (const entry of data.topics) {
      parts.push(formatNonSourceEntry(entry));
    }
  }
  parts.push("");
  return parts.join("\n");
}

/** 解析 index.md 内容；无法识别的行忽略（lint 票再做严格对账）。 */
export function parseIndex(text: string): IndexData {
  const data: IndexData = { sources: [], entities: [], concepts: [], topics: [] };
  let section: keyof IndexData | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === INDEX_SOURCES_HEADING) {
      section = "sources";
      continue;
    }
    if (trimmed === INDEX_ENTITIES_HEADING) {
      section = "entities";
      continue;
    }
    if (trimmed === INDEX_CONCEPTS_HEADING) {
      section = "concepts";
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
    } else if (section === "entities" || section === "concepts" || section === "topics") {
      const m = trimmed.match(NON_SOURCE_ENTRY_RE);
      if (m) {
        data[section].push({
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
  return text === null ? { sources: [], entities: [], concepts: [], topics: [] } : parseIndex(text);
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

/** 一页在 index 里的位置：所在节的条目数组与下标。 */
interface IndexRowLocation {
  list: SourceIndexEntry[] | NonSourceIndexEntry[];
  index: number;
}

/**
 * 按变更前的页面元数据定位一页的 index 行：来源页按「标题 + raw 路径」，其余按标题。
 * 非来源页在三个非来源节里统一找——兼容"页面已迁移成 entity/concept、旧行还留在 Topics 节"的过渡态。
 */
function locateIndexRow(data: IndexData, page: Pick<WikiPage, "title" | "meta">): IndexRowLocation | null {
  const meta = page.meta;
  if (meta.type === "source") {
    const sourcePath = meta.source;
    const index = data.sources.findIndex((e) => e.title === page.title && e.sourcePath === sourcePath);
    return index >= 0 ? { list: data.sources, index } : null;
  }
  for (const list of [data.entities, data.concepts, data.topics]) {
    const index = list.findIndex((e) => e.title === page.title);
    if (index >= 0) {
      return { list, index };
    }
  }
  return null;
}

/** index 联动（apply 用）：移除一页对应的行（按变更前的标题/来源匹配；不在则无操作）。 */
export function removeIndexEntries(data: IndexData, page: Pick<WikiPage, "title" | "meta">): void {
  const at = locateIndexRow(data, page);
  if (at) {
    at.list.splice(at.index, 1);
  }
}

/** 非来源页的目标节：实体页进 Entities、概念页进 Concepts。 */
function nonSourceSection(data: IndexData, type: PageMeta["type"]): NonSourceIndexEntry[] | null {
  if (type === "entity") {
    return data.entities;
  }
  if (type === "concept") {
    return data.concepts;
  }
  return data.topics; // 过渡防御：apply 已拒写 type: topic，正常批次到不了这里
}

/**
 * index 联动（apply 用）：登记一个写入页。既有页**原位替换**——标题、别名没变时行内容与
 * 顺序都不动（#38）；页面换了节（如归类改判）或新建页才追加到目标节末尾。
 * `old` 为变更前的页面元数据，新建页不传。
 */
export function upsertIndexEntries(
  data: IndexData,
  page: IndexPageInput,
  old?: Pick<WikiPage, "title" | "meta">,
): void {
  const meta = page.meta;
  const at = old ? locateIndexRow(data, old) : null;
  if (meta.type === "source") {
    const entry: SourceIndexEntry = { title: page.title, sourcePath: meta.source };
    if (at && at.list === data.sources) {
      data.sources[at.index] = entry; // 同节：原位替换
    } else {
      if (at) {
        at.list.splice(at.index, 1); // 换节：从旧节摘除，再进目标节
      }
      data.sources.push(entry);
    }
    return;
  }
  const target = nonSourceSection(data, meta.type);
  if (!target) {
    return;
  }
  const entry: NonSourceIndexEntry = { title: page.title, aliases: meta.aliases };
  if (at && at.list === target) {
    target[at.index] = entry;
  } else {
    if (at) {
      at.list.splice(at.index, 1);
    }
    target.push(entry);
  }
}
