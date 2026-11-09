import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import { readIndex, type SourceIndexEntry, type TopicIndexEntry } from "../corpus/indexFile.js";
import { RAW_DIR, WIKI_DIR, resolveInCorpus, toCorpusRel } from "../corpus/paths.js";
import { readOptionalFile } from "../corpus/fs.js";

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

export interface FileHitCount {
  /** corpus 内相对路径（POSIX 风格）。 */
  path: string;
  /** 该文件的全文命中总次数（不受摘录配额影响）。 */
  hits: number;
}

export interface SearchResult {
  query: string;
  scope: SearchScope;
  indexHits: IndexHit[];
  fullTextHits: FullTextHit[];
  /** 文件级聚合：每文件命中总数，永不截断（摘录可截断，聚合如实）。按命中数降序、同数按路径升序。 */
  filesWithHits: FileHitCount[];
  /** 摘录命中数达到上限被截断时为 true（filesWithHits 不受影响）。 */
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

/** 逐行匹配单个文件；同一行多次出现只记一条（去重）。读失败（含不存在）静默跳过。
 * 返回摘录（受 maxHits 配额）与该文件命中总数（不受配额，供文件级聚合）。 */
async function searchFile(
  absPath: string,
  corpusRoot: string,
  query: string,
  maxHits: number,
): Promise<{ hits: FullTextHit[]; totalMatches: number }> {
  let text: string | null;
  try {
    text = await readOptionalFile(absPath);
  } catch {
    return { hits: [], totalMatches: 0 };
  }
  if (text === null) {
    return { hits: [], totalMatches: 0 };
  }
  const hits: FullTextHit[] = [];
  let totalMatches = 0;
  const rel = toCorpusRel(corpusRoot, absPath);
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    if (includesIgnoreCase(lines[i] ?? "", query)) {
      totalMatches += 1;
      if (hits.length < maxHits) {
        hits.push({
          path: rel,
          line: i + 1,
          excerpt: excerptAround(lines[i] ?? "", query),
        });
      }
    }
  }
  return { hits, totalMatches };
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
  const filesWithHits = new Map<string, number>();
  let truncated = false;

  const wikiFiles = scope === "raw" ? [] : await listMdFilesFlat(resolveInCorpus(corpusRoot, WIKI_DIR));
  const rawFiles = scope === "wiki" ? [] : await listFilesRecursive(resolveInCorpus(corpusRoot, RAW_DIR));
  // 全部文件都要读：聚合计数（filesWithHits）永不截断，摘录在配额满后停止收集；
  // 不再因摘录满额提前 break——否则聚合也会缺文件（个人库规模下全量扫描成本可接受）
  for (const abs of [...wikiFiles, ...rawFiles]) {
    const remaining = MAX_TOTAL_HITS - fullTextHits.length;
    const cap = Math.min(MAX_HITS_PER_FILE, Math.max(0, remaining));
    const { hits, totalMatches } = await searchFile(abs, corpusRoot, query, cap);
    if (totalMatches > 0) {
      filesWithHits.set(toCorpusRel(corpusRoot, abs), totalMatches);
    }
    fullTextHits.push(...hits);
    if (totalMatches > hits.length) {
      truncated = true; // 该文件命中数超过摘录配额（单文件 50 或总量余量），摘录被截
    }
    if (fullTextHits.length >= MAX_TOTAL_HITS) {
      truncated = true; // 总量配额满：后续文件若还有命中，摘录不再收集（聚合仍如实计数）
    }
  }

  // 文件级聚合排序：命中数降序、同数按路径升序（确定性）
  const fileCounts = [...filesWithHits.entries()]
    .map(([path, hits]) => ({ path, hits }))
    .sort((a, b) => b.hits - a.hits || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { query, scope, indexHits, fullTextHits, filesWithHits: fileCounts, truncated };
}

export const searchTool: ToolDefinition = {
  name: "search",
  description:
    "只读查询 corpus：索引命中（index.md 条目：标题/别名/raw 路径）与全文命中（wiki/ 与 raw/ 的路径/行号/摘录），" +
    "另有文件级聚合 filesWithHits（每文件命中总数，永不截断；摘录触达配额时 truncated=true 但聚合如实）。" +
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
