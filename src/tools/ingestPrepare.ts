import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import { collectWikiPages, type WikiPage } from "../corpus/pages.js";
import { isRawPath, RAW_DIR, resolveInCorpus, toCorpusRel, CorpusPathError } from "../corpus/paths.js";
import { buildNameIndex, extractWikilinks, resolveWikilinkTarget } from "../corpus/wikilink.js";
import { gitStatus, GitError } from "../corpus/git.js";

/**
 * ingest_prepare（spec #1 / #4）：只读。Ingest 流程的第一步：
 * 拿到指定 Raw 材料的内容、stat 与相关既有页面清单，供 agent 一次性起草完整变更集。
 * 相关页判定（复用共享层名字索引与别名解析）：
 * - source：既有来源页的 source 指向同一份 raw 材料（重复灌入检测）。
 * - title / alias：页面标题或别名作为子串出现在源内容中。
 * - wikilink：源内容中的 [[链接]] 经名字索引解析到既有页面（重新灌入的旧笔记场景）。
 *
 * git 边界前置（#17）：非 git 库或存在阻塞性脏文件时直接拒绝——apply 的门是本检查的
 * 严格超集，提前拒零误伤；apply 在写锁内的检查仍是权威（TOCTOU）。
 */

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
  content: string;
  stat: {
    size: number;
    mtime: string;
    birthtime: string;
  };
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

/** ingest_prepare 主逻辑：校验 raw 路径 → 读内容与 stat → 计算相关既有页面。 */
export async function prepareIngest(corpusRoot: string, rawPath: string): Promise<IngestPrepareResult> {
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

  const content = await readFile(abs, "utf8");
  const pages = await collectWikiPages(corpusRoot);
  const related = new Map<string, RelatedPage>();

  for (const page of pages) {
    // 同一份材料已有的来源页：重复灌入时 agent 应更新而非新建
    if (page.meta.type === "source" && page.meta.source === rel) {
      addRelation(related, page, "source", rel);
    }
    // 页面名（标题 + 别名）出现在源内容中
    for (const name of page.names) {
      if (name.trim() !== "" && content.includes(name)) {
        addRelation(related, page, name === page.title ? "title" : "alias", name);
      }
    }
  }

  // 源内容中的 wikilink 解析到既有页面（重新灌入的旧笔记常带 [[链接]]）
  const nameIndex = buildNameIndex(pages);
  for (const link of extractWikilinks(content)) {
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
    stat: {
      size: fileStat.size,
      mtime: fileStat.mtime.toISOString(),
      birthtime: fileStat.birthtime.toISOString(),
    },
    relatedPages: [...related.values()],
    git: { clean: true, pendingRaw: git.pendingRaw },
  };
}

export const ingestPrepareTool: ToolDefinition = {
  name: "ingest_prepare",
  description:
    "只读。Ingest 第一步：校验并读取指定 raw/ 材料，返回源内容、文件 stat、相关既有页面清单" +
    "（按 source 同源、标题/别名出现在源内容、源内 wikilink 解析三类关联）与 git 边界概要（含其余待灌材料）。" +
    "前置检查：非 git 库或存在未提交手改（脏树）时直接拒绝——避免整批起草后在 apply 阶段白费；" +
    "未跟踪的 raw/ 新材料不算脏（ADR-0005）。",
  register(server, ctx) {
    server.registerTool(
      this.name,
      {
        description: this.description,
        inputSchema: {
          rawPath: z.string().min(1).describe("raw 材料的 corpus 内相对路径（形如 raw/xxx.md）"),
        },
      },
      async (args) => {
        try {
          const result = await prepareIngest(ctx.corpusDir, String(args.rawPath));
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
