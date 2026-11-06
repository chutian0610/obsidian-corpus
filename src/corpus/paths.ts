import path from "node:path";

/** corpus 根内固定布局（spec #1 corpus 结构约定）。 */
export const RAW_DIR = "raw";
export const WIKI_DIR = "wiki";
export const TRASH_DIR = ".trash";
export const INDEX_FILE = "index.md";
export const LOG_FILE = "log.md";
export const AGENTS_FILE = "AGENTS.md";
export const GITIGNORE_FILE = ".gitignore";

/** 路径解析后落在 corpus 根外时抛出，防逃逸是硬保证。 */
export class CorpusPathError extends Error {
  constructor(public readonly offender: string) {
    super(`路径越出 corpus 根：${offender}`);
    this.name = "CorpusPathError";
  }
}

/**
 * 把相对 corpus 根的路径解析为绝对路径。
 * 任何形式（含 `..`、绝对路径片段）解析后必须落在 corpus 根内，否则抛 CorpusPathError。
 */
export function resolveInCorpus(corpusRoot: string, relPath: string): string {
  const root = path.resolve(corpusRoot);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new CorpusPathError(relPath);
  }
  return abs;
}

/** 统一为 POSIX 风格的 corpus 内相对路径（index/log/git 与 frontmatter 共用的形态）。 */
export function toCorpusRel(corpusRoot: string, absPath: string): string {
  return path.relative(path.resolve(corpusRoot), absPath).split(path.sep).join("/");
}

/** 是否指向 Raw sources 层（raw/ 对写操作只读）。 */
export function isRawPath(relPath: string): boolean {
  const p = relPath.replaceAll("\\", "/");
  return p === RAW_DIR || p.startsWith(RAW_DIR + "/");
}

/** 是否指向 Wiki 层（写入口 apply 只接受 wiki/ 内的路径）。 */
export function isWikiPath(relPath: string): boolean {
  const p = relPath.replaceAll("\\", "/");
  return p === WIKI_DIR || p.startsWith(WIKI_DIR + "/");
}
