import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import { collectWikiPages, type WikiPage } from "../corpus/pages.js";
import { isRawPath, RAW_DIR, resolveInCorpus, toCorpusRel, CorpusPathError } from "../corpus/paths.js";
import { buildNameIndex, extractWikilinks, resolveWikilinkTarget } from "../corpus/wikilink.js";
import { gitStatus, GitError } from "../corpus/git.js";

/**
 * ingest_prepare（spec #1 / #4）：只读。Ingest 流程的第一步：
 * 拿到指定 Raw 材料的内容（行窗口）、stat 与相关既有页面清单，供 agent 一次性起草完整变更集。
 * 相关页判定（复用共享层名字索引与别名解析）：
 * - source：既有来源页的 source 指向同一份 raw 材料（重复灌入检测）。
 * - title / alias：页面标题或别名作为子串出现在源内容中。
 * - wikilink：源内容中的 [[链接]] 经名字索引解析到既有页面（重新灌入的旧笔记场景）。
 *
 * raw 门禁（#20）：只接受 .md/.txt 文本材料（二进制会以乱码混进起草），内容含 NUL 视为二进制拒绝；
 * 大材料（书籍级）用 startLine/maxLines 分段读，防止全量返回撑爆 agent context；
 * 全文 sha256 与 raw/ 既有文件比对，内容相同而路径不同 → duplicateOf 警告（只警告不阻塞）。
 *
 * git 边界前置（#17）：非 git 库或存在阻塞性脏文件时直接拒绝——apply 的门是本检查的
 * 严格超集，提前拒零误伤；apply 在写锁内的检查仍是权威（TOCTOU）。
 */

/** 允许的 raw 材料扩展名（纯文本，可安全作为知识源）。 */
const RAW_ALLOWED_EXTS = new Set([".md", ".txt"]);
/** 行窗口默认行数与单次上限（#20：分段读，防爆 context）。 */
const DEFAULT_WINDOW_LINES = 2000;
const MAX_WINDOW_LINES = 5000;

export interface RelatedPage {
  /** wiki/ 内相对路径。 */
  pagePath: string;
  type: "source" | "topic";
  title: string;
  /** 触发关联的具体名字（标题 / 别名 / wikilink 目标）。 */
  matchedNames: string[];
  /** 关联类型集合。 */
  relations: Array<"source" | "title" | "alias" | "wikilink">;
}

export interface IngestPrepareResult {
  /** 归一后的 corpus 内相对路径（形如 raw/xxx.md）。 */
  path: string;
  /** 本次行窗口内的正文（startLine..endLine）。 */
  content: string;
  /** 行窗口元数据：大材料分段读的定位信息。 */
  contentWindow: {
    startLine: number;
    /** 窗口末行（含）；窗口为空（startLine 越过 EOF）时为 null。 */
    endLine: number | null;
    totalLines: number;
    truncated: boolean;
    /** 还有后续内容时的下一窗口起始行；读尽为 null。 */
    nextStartLine: number | null;
  };
  stat: {
    size: number;
    mtime: string;
    birthtime: string;
  };
  /** 与本材料内容相同（sha256 一致）而路径不同的既有 raw 文件；空数组=无重复。 */
  duplicateOf: string[];
  relatedPages: RelatedPage[];
  /** git 边界概要：本材料可安全起草，另有这些待灌材料（ADR-0005）。 */
  git: {
    clean: true;
    pendingRaw: string[];
  };
}

/** 参数校验失败等可预期错误：以 MCP isError 返回，不炸连接。 */
class PrepareError extends Error {}

function addRelation(
  related: Map<string, RelatedPage>,
  page: WikiPage,
  relation: "source" | "title" | "alias" | "wikilink",
  matchedName: string,
): void {
  const existing = related.get(page.pagePath);
  if (existing) {
    if (!existing.relations.includes(relation)) {
      existing.relations.push(relation);
    }
    if (!existing.matchedNames.includes(matchedName)) {
      existing.matchedNames.push(matchedName);
    }
    return;
  }
  related.set(page.pagePath, {
    pagePath: page.pagePath,
    type: page.meta.type,
    title: page.title,
    matchedNames: [matchedName],
    relations: [relation],
  });
}

/** 递归找出 raw/ 下与本材料内容相同（sha256）的其他文件；个人库规模下线性扫可接受。 */
async function findRawDuplicates(corpusRoot: string, selfAbs: string, content: string): Promise<string[]> {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const dupRels: string[] = [];
  const walk = async (dirAbs: string): Promise<void> => {
    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // raw/ 不存在等情形：无重复可言
    }
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && abs !== selfAbs) {
        try {
          const other = await readFile(abs, "utf8");
          if (!other.includes("\u0000") && createHash("sha256").update(other, "utf8").digest("hex") === hash) {
            dupRels.push(toCorpusRel(corpusRoot, abs));
          }
        } catch {
          // 读不了的文件（权限等）跳过，不影响主流程
        }
      }
    }
  };
  await walk(resolveInCorpus(corpusRoot, RAW_DIR));
  return dupRels.sort();
}

/** ingest_prepare 主逻辑：校验 raw 路径与类型 → 读内容（行窗口）与 stat → 计算相关既有页面与内容查重。 */
export async function prepareIngest(
  corpusRoot: string,
  rawPath: string,
  startLineArg = 1,
  maxLinesArg = DEFAULT_WINDOW_LINES,
): Promise<IngestPrepareResult> {
  let abs: string;
  try {
    abs = resolveInCorpus(corpusRoot, rawPath);
  } catch (error) {
    if (error instanceof CorpusPathError) {
      throw new PrepareError(`路径越出 corpus 根：${rawPath}`);
    }
    throw error;
  }
  const rel = toCorpusRel(corpusRoot, abs);
  if (!isRawPath(rel) || rel === RAW_DIR) {
    throw new PrepareError(`路径必须在 raw/ 内（形如 raw/xxx.md）：${rawPath}`);
  }
  // 类型门禁（#20）：二进制材料读出来是乱码，agent 会拿乱码起草——直接拒并给出转存指引
  const ext = path.extname(rel).toLowerCase();
  if (!RAW_ALLOWED_EXTS.has(ext)) {
    throw new PrepareError(
      `raw 材料只接受 .md/.txt 文本文件（收到 ${ext || "无扩展名"}）：${rel}；PDF 等请先转存为 markdown/txt 再放入 raw/`,
    );
  }

  let fileStat: Stats;
  try {
    fileStat = await stat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PrepareError(`raw 材料不存在：${rel}`);
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    throw new PrepareError(`raw 材料必须是文件：${rel}`);
  }

  // git 边界前置（#17）：脏树/非 git 库必然在 apply 被拦，提前拒可省下整批起草；
  // 待灌材料（pendingRaw）不算脏（ADR-0005），随结果透出供 agent 顺带知晓。
  let git;
  try {
    git = await gitStatus(corpusRoot);
  } catch (error) {
    if (error instanceof GitError) {
      throw new PrepareError("corpus 不是 git 库，请先调用 init 初始化。");
    }
    throw error;
  }
  if (!git.clean) {
    throw new PrepareError(
      "corpus 工作树不干净（未提交的人类手改），ingest 会在 apply 阶段被拒；请库主人先提交后再起草。" +
        `脏文件：${git.dirtyFiles.join("、")}`,
    );
  }

  const fullContent = await readFile(abs, "utf8");
  // 二进制保险丝：扩展名对了但内容含 NUL（改扩展名的 PDF/图片等）照样拒
  if (fullContent.includes("\u0000")) {
    throw new PrepareError(`raw 材料包含二进制内容（检测到 NUL 字节）：${rel}；请确认是文本 markdown/txt`);
  }

  // 行窗口（#20）：大材料分段读；窗口之外的行不返回，但相关页/查重仍基于全文
  const startLine = Math.max(1, Math.floor(startLineArg));
  const maxLines = Math.min(MAX_WINDOW_LINES, Math.max(1, Math.floor(maxLinesArg)));
  const lines = fullContent.split("\n");
  const totalLines = lines.length;
  const windowLines = lines.slice(startLine - 1, startLine - 1 + maxLines);
  const content = windowLines.join("\n");
  const endLine = windowLines.length > 0 ? startLine + windowLines.length - 1 : null;
  const truncated = endLine !== null && endLine < totalLines;
  const nextStartLine = truncated ? endLine + 1 : null;

  const duplicateOf = await findRawDuplicates(corpusRoot, abs, fullContent);

  const pages = await collectWikiPages(corpusRoot);
  const related = new Map<string, RelatedPage>();

  for (const page of pages) {
    // 同一份材料已有的来源页：重复灌入时 agent 应更新而非新建
    if (page.meta.type === "source" && page.meta.source === rel) {
      addRelation(related, page, "source", rel);
    }
    // 页面名（标题 + 别名）出现在源内容中——基于全文而非当前窗口
    for (const name of page.names) {
      if (name.trim() !== "" && fullContent.includes(name)) {
        addRelation(related, page, name === page.title ? "title" : "alias", name);
      }
    }
  }

  // 源内容中的 wikilink 解析到既有页面（重新灌入的旧笔记常带 [[链接]]）——用全文而非当前窗口
  const nameIndex = buildNameIndex(pages);
  for (const link of extractWikilinks(fullContent)) {
    const target = resolveWikilinkTarget(nameIndex, link.target);
    if (target === null) {
      continue;
    }
    const page = pages.find((p) => p.pagePath === target);
    if (page) {
      addRelation(related, page, "wikilink", link.target);
    }
  }

  return {
    path: rel,
    content,
    contentWindow: { startLine, endLine, totalLines, truncated, nextStartLine },
    stat: {
      size: fileStat.size,
      mtime: fileStat.mtime.toISOString(),
      birthtime: fileStat.birthtime.toISOString(),
    },
    duplicateOf,
    relatedPages: [...related.values()],
    git: { clean: true, pendingRaw: git.pendingRaw },
  };
}

export const ingestPrepareTool: ToolDefinition = {
  name: "ingest_prepare",
  description:
    "只读。Ingest 第一步：校验并读取指定 raw/ 材料（仅 .md/.txt，含 NUL 判二进制），返回源内容" +
    "（行窗口：大材料用 startLine/maxLines 分段读，默认 2000 行、单次上限 5000）、文件 stat、内容查重" +
    "（duplicateOf：raw/ 内内容相同而路径不同的文件）、相关既有页面清单（按 source 同源、标题/别名出现在" +
    "源内容、源内 wikilink 解析三类关联，基于全文计算）与 git 边界概要（含其余待灌材料）。" +
    "前置检查：非 git 库或存在未提交手改（脏树）时直接拒绝——避免整批起草后在 apply 阶段白费；" +
    "未跟踪的 raw/ 新材料不算脏（ADR-0005）。",
  register(server, ctx) {
    server.registerTool(
      this.name,
      {
        description: this.description,
        inputSchema: {
          rawPath: z.string().min(1).describe("raw 材料的 corpus 内相对路径（形如 raw/xxx.md）"),
          startLine: z.number().int().min(1).optional().describe("行窗口起始行（1 起，缺省 1）；大材料分段读"),
          maxLines: z.number().int().min(1).max(5000).optional().describe("行窗口行数（缺省 2000，上限 5000）"),
        },
      },
      async (args) => {
        try {
          const result = await prepareIngest(
            ctx.corpusDir,
            String(args.rawPath),
            args.startLine === undefined ? 1 : Number(args.startLine),
            args.maxLines === undefined ? DEFAULT_WINDOW_LINES : Number(args.maxLines),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          if (error instanceof PrepareError) {
            return {
              content: [{ type: "text", text: error.message }],
              isError: true,
            };
          }
          throw error;
        }
      },
    );
  },
};
