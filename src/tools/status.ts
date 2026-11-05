import type { ToolDefinition } from "./registry.js";
import { collectWikiPages } from "../corpus/pages.js";
import { PAGE_TYPE_SOURCE } from "../corpus/frontmatter.js";
import { readLog, type LogEntry } from "../corpus/logFile.js";
import { gitStatus, GitError } from "../corpus/git.js";

/** status 返回的最近日志条数。 */
export const STATUS_RECENT_LOG_COUNT = 5;

export interface StatusResult {
  /** 是否 git 库；false 意味着应先 init。 */
  git_repo: boolean;
  /** 工作树是否干净（agent 写操作的前置安全边界，ADR-0004）。 */
  git_clean: boolean;
  /** 脏文件清单（含暂存与未跟踪）。 */
  dirty_files: string[];
  /** 来源页计数。 */
  source_pages: number;
  /** 主题页计数。 */
  topic_pages: number;
  /** frontmatter 解析失败的页面数（页面计数外另行提示）。 */
  invalid_pages: number;
  /** 最近日志条目（旧到新）。 */
  recent_log: LogEntry[];
}

/**
 * status 概览（spec #1，只读）：git 干净状态、脏文件清单、
 * 来源页/主题页计数、最近日志条目解析结果。
 * 对未 init 的目录优雅降级（各计数为 0、git_repo=false），供 agent 自检后先 init。
 */
export async function corpusStatus(corpusDir: string): Promise<StatusResult> {
  let gitRepo = true;
  let clean = false;
  let dirtyFiles: string[] = [];
  try {
    const status = await gitStatus(corpusDir);
    clean = status.clean;
    dirtyFiles = status.dirtyFiles;
  } catch (error) {
    if (!(error instanceof GitError)) {
      throw error;
    }
    gitRepo = false;
  }

  const pages = await collectWikiPages(corpusDir);
  const sourcePages = pages.filter((p) => p.meta.type === PAGE_TYPE_SOURCE && p.issues.length === 0);
  const topicPages = pages.filter((p) => p.meta.type !== PAGE_TYPE_SOURCE && p.issues.length === 0);
  const invalidPages = pages.filter((p) => p.issues.length > 0);

  const recentLog = await readLog(corpusDir, STATUS_RECENT_LOG_COUNT);

  return {
    git_repo: gitRepo,
    git_clean: clean,
    dirty_files: dirtyFiles,
    source_pages: sourcePages.length,
    topic_pages: topicPages.length,
    invalid_pages: invalidPages.length,
    recent_log: recentLog,
  };
}

/** status 工具：只读概览，agent 每次操作前自检安全边界。 */
export const statusTool: ToolDefinition = {
  name: "status",
  description:
    "只读返回 corpus 概览：git 是否干净与脏文件清单、来源页/主题页计数、最近日志条目。" +
    "agent 在写操作前调用以自检 git 干净边界；未 init 的目录返回 git_repo=false。",
  register(server, ctx) {
    server.registerTool(
      this.name,
      {
        description: this.description,
        inputSchema: {},
      },
      async () => {
        const result = await corpusStatus(ctx.corpusDir);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  },
};
