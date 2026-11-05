import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import { readIndex, type SourceIndexEntry, type TopicIndexEntry } from "../corpus/indexFile.js";
import { RAW_DIR, WIKI_DIR, resolveInCorpus, toCorpusRel } from "../corpus/paths.js";

/**
 * search（spec #1 / #4）：只读查询，Index-first、纯文本匹配（ADR-0003，无向量）。
 * - 索引命中：index.md 条目（标题 / 别名 / raw 路径）匹配 query。
 * - 全文命中：wiki/ 与 raw/ 逐行匹配，返回路径 + 行号 + 摘录。
 * - scope：all（默认）= 索引 + wiki/raw 全文；wiki = 索引 + wiki/ 全文；raw = 仅 raw/ 全文。
 */

const SEARCH_SCOPES = ["all", "wiki", "raw"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** 单文件命中上限，防大文件刷屏；超出即截断并在返回体标记。 */
const MAX_HITS_PER_FILE = 50;
/** 全文命中总数上限（索引命中不受限：条目量级即页面量级）。 */
const MAX_TOTAL_HITS = 200;
/** 摘录窗口：以首个命中为中心的半宽。 */
const EXCERPT_RADIUS = 60;

export interface IndexHit {
  section: "sources" | "topics";
  title: string;
  /** Sources 条目的 raw 路径；Topics 条目无此字段。 */
  sourcePath?: string;
  aliases?: string[];
  /** 命中的名字（标题、别名或 raw 路径）。 */
  matchedOn: string;
}

export interface FullTextHit {
  /** corpus 内相对路径（POSIX 风格）。 */
  path: string;
  /** 1 起行号。 */
  line: number;
  /** 命中行摘录（以命中处为中心截取）。 */
  excerpt: string;
}

export interface SearchResult {
  query: string;
  scope: SearchScope;
  indexHits: IndexHit[];
  fullTextHits: FullTextHit[];
  /** 命中数达到上限被截断时为 true。 */
  truncated: boolean;
}

function includesIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** 以首个命中处为中心截取摘录，超宽两侧以 … 标记。 */
function excerptAround(line: string, query: string): string {
  const trimmed = line.trim();
  const idx = trimmed.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1 || trimmed.length <= EXCERPT_RADIUS * 2 + query.length) {
    return trimmed;
  }
  const start = Math.max(0, idx - EXCERPT_RADIUS);
  const end = Math.min(trimmed.length, idx + query.length + EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

function matchSourceEntry(entry: SourceIndexEntry, query: string): string | null {
  if (includesIgnoreCase(entry.title, query)) {
    return entry.title;
  }
  if (includesIgnoreCase(entry.sourcePath, query)) {
    return entry.sourcePath;
  }
  return null;
}

function matchTopicEntry(entry: TopicIndexEntry, query: string): string | null {
  if (includesIgnoreCase(entry.title, query)) {
    return entry.title;
  }
  const alias = entry.aliases.find((a) => includesIgnoreCase(a, query));
  return alias ?? null;
}

async function listMdFilesFlat(dirAbs: string): Promise<string[]> {
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => path.join(dirAbs, e.name));
}

/** 递归列出 raw/ 下全部文件（源材料不限扩展名，二进制读不出匹配自然落空）。 */
async function listFilesRecursive(dirAbs: string): Promise<string[]> {
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(abs)));
    } else if (entry.isFile()) {
      files.push(abs);
    }
  }
  return files;
}

/** 逐行匹配单个文件；同一行多次出现只记一条（去重）。 */
async function searchFile(
  absPath: string,
  corpusRoot: string,
  query: string,
  maxHits: number,
): Promise<FullTextHit[]> {
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    return [];
  }
  const hits: FullTextHit[] = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    if (includesIgnoreCase(lines[i] ?? "", query)) {
      hits.push({
        path: toCorpusRel(corpusRoot, absPath),
        line: i + 1,
        excerpt: excerptAround(lines[i] ?? "", query),
      });
    }
  }
  return hits;
}

/** search 主逻辑：索引命中 + 全文命中，按 scope 过滤。 */
export async function searchCorpus(corpusRoot: string, query: string, scope: SearchScope): Promise<SearchResult> {
  const indexHits: IndexHit[] = [];
  if (scope !== "raw") {
    const index = await readIndex(corpusRoot);
    for (const entry of index.sources) {
      const matchedOn = matchSourceEntry(entry, query);
      if (matchedOn !== null) {
        indexHits.push({ section: "sources", title: entry.title, sourcePath: entry.sourcePath, matchedOn });
      }
    }
    for (const entry of index.topics) {
      const matchedOn = matchTopicEntry(entry, query);
      if (matchedOn !== null) {
        indexHits.push({ section: "topics", title: entry.title, aliases: entry.aliases, matchedOn });
      }
    }
  }

  const fullTextHits: FullTextHit[] = [];
  let truncated = false;

  const wikiFiles = scope === "raw" ? [] : await listMdFilesFlat(resolveInCorpus(corpusRoot, WIKI_DIR));
  const rawFiles = scope === "wiki" ? [] : await listFilesRecursive(resolveInCorpus(corpusRoot, RAW_DIR));
  for (const abs of [...wikiFiles, ...rawFiles]) {
    if (fullTextHits.length >= MAX_TOTAL_HITS) {
      truncated = true;
      break;
    }
    const remaining = MAX_TOTAL_HITS - fullTextHits.length;
    const cap = Math.min(MAX_HITS_PER_FILE, remaining);
    const hits = await searchFile(abs, corpusRoot, query, cap);
    if (hits.length === cap) {
      truncated = true; // 命中数触到单文件或总量配额，该文件内可能还有更多命中
    }
    fullTextHits.push(...hits);
  }

  return { query, scope, indexHits, fullTextHits, truncated };
}

export const searchTool: ToolDefinition = {
  name: "search",
  description:
    "只读查询 corpus：索引命中（index.md 条目：标题/别名/raw 路径）与全文命中（wiki/ 与 raw/ 的路径/行号/摘录）。" +
    "纯文本匹配（无向量）。scope 可选 all/wiki/raw（默认 all；wiki 含索引命中，raw 仅搜 raw/）。",
  register(server, ctx) {
    server.registerTool(
      this.name,
      {
        description: this.description,
        inputSchema: {
          query: z.string().min(1).describe("查询词，纯文本子串匹配（不区分大小写）"),
          scope: z.enum(SEARCH_SCOPES).default("all").describe("搜索范围：all=索引+wiki/raw 全文；wiki=索引+wiki/；raw=仅 raw/"),
        },
      },
      async (args) => {
        const query = String(args.query);
        const scope = (args.scope ?? "all") as SearchScope;
        const result = await searchCorpus(ctx.corpusDir, query, scope);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  },
};
