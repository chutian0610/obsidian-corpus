import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { connectTestClient, createCorpusFixture, type CorpusFixture, type TestSession } from "./harness.js";
import { gitStatus } from "../src/corpus/git.js";
import { INDEX_SOURCE_SEPARATOR } from "../src/corpus/indexFile.js";

/**
 * lint 工具接缝测试（ticket #6 验收）：
 * 构造断链/孤儿/索引漂移/缺字段夹具，四规则各自命中且互不误报；干净 corpus 返回零 findings。
 * 断言只打在外部行为上：工具返回值 + lint 后工作树仍干净（只读保证）。
 */

interface LintFinding {
  rule: string;
  path: string;
  detail: string;
}

interface LintReport {
  findings: LintFinding[];
  summary: { total: number; byRule: Record<string, number> };
}

let fixture: CorpusFixture | null = null;
let session: TestSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
  await fixture?.dispose();
  fixture = null;
});

async function callLint(): Promise<LintReport> {
  if (session === null) {
    throw new Error("测试会话未初始化");
  }
  const result = await session.client.callTool({ name: "lint", arguments: {} });
  expect(result.isError).toBeFalsy();
  const block = (result.content as Array<{ type: string; text?: string }>)[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block?.text ?? "") as LintReport;
}

/** 播种 corpus 根的 index.md（harness 只覆盖 raw/wiki，索引由本测试直写）。 */
async function seedIndex(root: string, text: string): Promise<void> {
  await writeFile(path.join(root, "index.md"), text, "utf8");
}

function sourcePage(source: string, title: string, body: string): string {
  return `---\ntype: source\nsource: ${source}\ntitle: ${title}\ncreated: 2026-01-01\n---\n\n${body}\n`;
}

function topicPage(title: string, body: string, aliases?: string[]): string {
  const aliasLine = aliases === undefined ? "" : `aliases: [${aliases.join(", ")}]\n`;
  return `---\ntype: topic\ntitle: ${title}\n${aliasLine}created: 2026-01-01\n---\n\n${body}\n`;
}

describe("lint 工具（MCP 接缝）", () => {
  it("四规则各自命中且互不误报", async () => {
    fixture = await createCorpusFixture({
      raw: { "断链测试材料.md": "# 断链测试材料\n\n原文内容。\n" },
      wiki: {
        // 断链夹具：两条断链（普通/带显示名）+ 锚点剥离与别名命中的合法链接
        "来源-断链测试.md": sourcePage(
          "raw/断链测试材料.md",
          "断链测试材料",
          "参见 [[正常主题]] 与 [[正常主题#锚点]]。\n\n断链：[[不存在的主题]]。\n带显示名的断链：[[幽灵别名|显示别名]]。\n",
        ),
        // 正常主题页：有入链（含别名路径）、登记进 index，不应出现在任何 finding
        "主题-正常主题.md": topicPage("正常主题", "正常主题的正文。", ["正常别名"]),
        // 孤儿夹具：主题页无任何入链；登记进 index（索引一致，只命中孤儿规则）
        "主题-孤儿.md": topicPage("孤儿主题", "没有人链接到我。"),
        // frontmatter 夹具：主题页缺 created（只命中 frontmatter 规则）
        "主题-缺字段.md": "---\ntype: topic\ntitle: 缺字段主题\n---\n\n正文。\n",
        // 索引漂移夹具（有页无行）：来源页合法但未登记进 index；无入链（来源页不算孤儿）
        "来源-未登记.md": sourcePage("raw/未登记材料.md", "未登记材料", "参见 [[正常主题]]。\n"),
      },
    });
    await seedIndex(
      fixture.root,
      [
        "## Sources",
        "",
        `[[断链测试材料]]${INDEX_SOURCE_SEPARATOR}raw/断链测试材料.md`,
        "",
        "## Topics",
        "",
        "[[正常主题]]（别名：正常别名）",
        "[[孤儿主题]]",
        "[[幽灵主题]]",
        "",
      ].join("\n"),
    );
    await fixture.commitSeed();
    session = await connectTestClient(fixture.root);

    const report = await callLint();
    expect(report.summary.total).toBe(6);
    expect(report.summary.byRule).toEqual({
      "broken-wikilink": 2,
      "orphan-topic": 1,
      "index-mismatch": 2,
      frontmatter: 1,
    });

    // 断链：两条都在断链页上，detail 逐条指认
    const broken = report.findings.filter((f) => f.rule === "broken-wikilink");
    expect(broken.map((f) => f.path)).toEqual(["wiki/来源-断链测试.md", "wiki/来源-断链测试.md"]);
    expect(broken.some((f) => f.detail.includes("[[不存在的主题]]"))).toBe(true);
    expect(broken.some((f) => f.detail.includes("[[幽灵别名|显示别名]]"))).toBe(true);

    // 孤儿：只有无入链的主题页；来源页「未登记材料」无入链但不算孤儿
    const orphans = report.findings.filter((f) => f.rule === "orphan-topic");
    expect(orphans.map((f) => f.path)).toEqual(["wiki/主题-孤儿.md"]);

    // 索引不一致：有页无行（来源页未登记）+ 有行无页（index 里的幽灵主题行）
    const mismatch = report.findings.filter((f) => f.rule === "index-mismatch");
    expect(mismatch).toContainEqual({
      rule: "index-mismatch",
      path: "wiki/来源-未登记.md",
      detail: "来源页未登记进 index.md 的 ## Sources 节",
    });
    expect(mismatch).toContainEqual({
      rule: "index-mismatch",
      path: "index.md",
      detail: "## Topics 节的 [[幽灵主题]] 无对应主题页",
    });

    // frontmatter：缺字段页只报 created 一条
    const fm = report.findings.filter((f) => f.rule === "frontmatter");
    expect(fm.map((f) => f.path)).toEqual(["wiki/主题-缺字段.md"]);
    expect(fm[0]?.detail).toContain("created");

    // 互不误报：正常页面（有入链、索引一致、字段齐全）不产生任何 finding
    const cleanPaths = report.findings
      .map((f) => f.path)
      .filter((p) => p === "wiki/主题-正常主题.md");
    expect(cleanPaths).toEqual([]);
  });

  it("干净 corpus 返回零 findings", async () => {
    fixture = await createCorpusFixture({
      raw: { "干净材料.md": "# 干净材料\n\n原文。\n" },
      wiki: {
        // 来源页经别名链接主题页（别名入链同样解除孤儿）
        "来源-干净材料.md": sourcePage(
          "raw/干净材料.md",
          "干净材料",
          "相关概念见 [[干净别名]]。\n",
        ),
        "主题-干净主题.md": topicPage("干净主题", "干净主题的正文。", ["干净别名"]),
      },
    });
    await seedIndex(
      fixture.root,
      [
        "## Sources",
        "",
        `[[干净材料]]${INDEX_SOURCE_SEPARATOR}raw/干净材料.md`,
        "",
        "## Topics",
        "",
        "[[干净主题]]（别名：干净别名）",
        "",
      ].join("\n"),
    );
    await fixture.commitSeed();
    session = await connectTestClient(fixture.root);

    const report = await callLint();
    expect(report.findings).toEqual([]);
    expect(report.summary.total).toBe(0);
    expect(report.summary.byRule).toEqual({});
  });

  it("lint 只读：报告 findings 后工作树仍干净", async () => {
    fixture = await createCorpusFixture({
      wiki: { "主题-孤儿.md": topicPage("孤儿主题", "无人链接。") },
    });
    await seedIndex(fixture.root, "## Sources\n\n## Topics\n");
    await fixture.commitSeed();
    session = await connectTestClient(fixture.root);

    const report = await callLint();
    expect(report.summary.total).toBeGreaterThan(0);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });
});
