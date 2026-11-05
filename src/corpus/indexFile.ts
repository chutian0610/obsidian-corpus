import { readFile, writeFile } from "node:fs/promises";
import { INDEX_FILE, resolveInCorpus, toCorpusRel } from "./paths.js";

/**
 * Index（索引，index.md）格式（spec #1，一字不差）：
 * - `## Sources` 节：每行 `[[来源页标题]] — raw/<路径>`
 * - `## Topics` 节：每行 `[[主题页标题]]`，别名以全角括号附注
 */
export const INDEX_SOURCES_HEADING = "## Sources";
export const INDEX_TOPICS_HEADING = "## Topics";
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
  return `[[${entry.title}]]${INDEX_SOURCE_SEPARATOR}${entry.sourcePath}`;
}

export function formatTopicEntry(entry: TopicIndexEntry): string {
  const base = `[[${entry.title}]]`;
  if (entry.aliases.length === 0) {
    return base;
  }
  return `${base}${INDEX_ALIASES_NOTE_PREFIX}${entry.aliases.join(INDEX_ALIASES_JOIN)}${INDEX_ALIASES_NOTE_SUFFIX}`;
}

const SOURCE_ENTRY_RE = /^\[\[([^\]]+)\]\] — (.+)$/u;
const TOPIC_ENTRY_RE = /^\[\[([^\]]+)\]\](?:（别名：(.+?)）)?$/u;

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
  try {
    const text = await readFile(abs, "utf8");
    return parseIndex(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sources: [], topics: [] };
    }
    throw error;
  }
}

/** 整体覆写 index.md（由 apply 在单个变更批次内联动调用）。 */
export async function writeIndex(corpusRoot: string, data: IndexData): Promise<string> {
  const abs = resolveInCorpus(corpusRoot, INDEX_FILE);
  await writeFile(abs, renderIndex(data), "utf8");
  return toCorpusRel(corpusRoot, abs);
}
