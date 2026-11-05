import type { ToolDefinition } from "./registry.js";
import { collectWikiPages } from "../corpus/pages.js";
import { readIndex } from "../corpus/indexFile.js";
import { buildNameIndex, extractWikilinks, resolveWikilinkTarget } from "../corpus/wikilink.js";
import { INDEX_FILE } from "../corpus/paths.js";

/** lint 规则标识（findings 的 rule 字段取值）。 */
export const RULE_BROKEN_WIKILINK = "broken-wikilink";
export const RULE_ORPHAN_TOPIC = "orphan-topic";
export const RULE_INDEX_MISMATCH = "index-mismatch";
export const RULE_FRONTMATTER = "frontmatter";

/** 一条体检结果：rule 定位规则、path 定位 corpus 内文件（POSIX 相对路径）、detail 说明问题。 */
export interface LintFinding {
  rule: string;
  path: string;
  detail: string;
}

export interface LintReport {
  findings: LintFinding[];
  summary: { total: number; byRule: Record<string, number> };
}

/** 对整个 corpus 跑四规则，只读不写。 */
export async function lintCorpus(corpusRoot: string): Promise<LintReport> {
  const findings: LintFinding[] = [];
  const pages = await collectWikiPages(corpusRoot);
  const index = await readIndex(corpusRoot);

  // 规则 4：frontmatter 完整性（按页面类型的必填字段；字段级问题来自共享层解析）
  for (const page of pages) {
    for (const issue of page.issues) {
      findings.push({ rule: RULE_FRONTMATTER, path: page.pagePath, detail: issue.message });
    }
  }

  // frontmatter 无效的页面标题不可信：断链/孤儿/索引对账只在有效页面上做，避免误报
  const validPages = pages.filter((page) => page.issues.length === 0);
  const nameIndex = buildNameIndex(validPages);

  // 规则 1：断链；顺带统计入链（规则 2 共用）。自链不算入链。
  //（正文复用 collectWikiPages 已剥好的 page.body，与 apply 的删除入链检查同形）
  const inbound = new Map<string, number>();
  for (const page of pages) {
    for (const link of extractWikilinks(page.body)) {
      const targetPath = resolveWikilinkTarget(nameIndex, link.target);
      if (targetPath === null) {
        findings.push({
          rule: RULE_BROKEN_WIKILINK,
          path: page.pagePath,
          detail: `wikilink [[${link.target}${link.display === null ? "" : `|${link.display}`}]] 指向不存在的页（标题与别名均未命中）`,
        });
      } else if (targetPath !== page.pagePath) {
        inbound.set(targetPath, (inbound.get(targetPath) ?? 0) + 1);
      }
    }
  }

  // 规则 2：孤儿页（主题页无入链；来源页不算孤儿）
  for (const page of validPages) {
    if (page.meta.type === "topic" && (inbound.get(page.pagePath) ?? 0) === 0) {
      findings.push({ rule: RULE_ORPHAN_TOPIC, path: page.pagePath, detail: "主题页无任何入链" });
    }
  }

  // 规则 3：索引不一致（页面↔index 双向，按标题对账；来源页对 Sources 节、主题页对 Topics 节）
  const sourcePages = validPages.filter((page) => page.meta.type === "source");
  const topicPages = validPages.filter((page) => page.meta.type === "topic");
  const indexSourceTitles = new Set(index.sources.map((entry) => entry.title));
  const indexTopicTitles = new Set(index.topics.map((entry) => entry.title));
  for (const page of sourcePages) {
    if (!indexSourceTitles.has(page.title)) {
      findings.push({
        rule: RULE_INDEX_MISMATCH,
        path: page.pagePath,
        detail: "来源页未登记进 index.md 的 ## Sources 节",
      });
    }
  }
  for (const entry of index.sources) {
    if (!sourcePages.some((page) => page.title === entry.title)) {
      findings.push({
        rule: RULE_INDEX_MISMATCH,
        path: INDEX_FILE,
        detail: `## Sources 节的 [[${entry.title}]] 无对应来源页`,
      });
    }
  }
  for (const page of topicPages) {
    if (!indexTopicTitles.has(page.title)) {
      findings.push({
        rule: RULE_INDEX_MISMATCH,
        path: page.pagePath,
        detail: "主题页未登记进 index.md 的 ## Topics 节",
      });
    }
  }
  for (const entry of index.topics) {
    if (!topicPages.some((page) => page.title === entry.title)) {
      findings.push({
        rule: RULE_INDEX_MISMATCH,
        path: INDEX_FILE,
        detail: `## Topics 节的 [[${entry.title}]] 无对应主题页`,
      });
    }
  }

  const byRule: Record<string, number> = {};
  for (const finding of findings) {
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  }
  return { findings, summary: { total: findings.length, byRule } };
}

/** Lint（体检）：只报告不修改，修复决策权在库主人。 */
export const lintTool: ToolDefinition = {
  name: "lint",
  description:
    "Corpus 体检（只读，不修改任何文件）。四规则：断链（wikilink 指向不存在的页或别名，含别名解析与锚点剥离）、" +
    "孤儿页（主题页无入链；来源页不算）、索引不一致（页面↔index.md 双向对账）、frontmatter 完整性（按页面类型的必填字段）。" +
    "返回结构化 findings（rule/path/detail），按报告逐项修复。",
  register(server, ctx) {
    server.registerTool(
      this.name,
      {
        description: this.description,
        inputSchema: {},
      },
      async () => {
        const report = await lintCorpus(ctx.corpusDir);
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        };
      },
    );
  },
};
