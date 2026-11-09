import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectTestClient, createCorpusFixture, type CorpusFixture, type TestSession } from "./harness.js";
import { writeIndex } from "../src/corpus/indexFile.js";
import { gitStatus } from "../src/corpus/git.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * T3（#4）接缝测试：search 与 ingest_prepare。
 * 只断言外部行为（MCP 工具返回值、git 干净），播种多页 corpus 验证命中、scope 过滤与相关页。

 * corpus 夹具布局（词面刻意错开，避免跨文件意外命中）：
 * - raw/transformer论文.md：含「注意力机制」「self-attention」与 wikilink [[检索]]
 * - raw/周会记录.md：含「周会」（仅 raw 出现）
 * - wiki/Transformer.md：主题页，别名「注意力机制」「自注意力」，正文含 [[检索]]
 * - wiki/检索.md：主题页，正文含「全文检索」（仅 wiki 出现）
 * - wiki/Transformer 论文精读.md：来源页，source 指向 raw/transformer论文.md
 */

const RAW_TRANSFORMER = [
  "# Transformer 论文笔记",
  "self-attention 是整体架构的核心。",
  "注意力机制 用 Query-Key-Value 描述。",
  "引用 [[检索]] 便于后续回查。",
  "注意力机制 在编码器与解码器中都有。",
].join("\n");

const RAW_MEETING = ["# 周会记录", "本周周会讨论了语料库维护分工。"].join("\n");

const WIKI_TRANSFORMER = [
  "---",
  "type: topic",
  "title: Transformer",
  "aliases:",
  "  - 注意力机制",
  "  - 自注意力",
  "created: 2026-11-01",
  "---",
  "# Transformer",
  "",
  "注意力机制是其核心，参见 [[检索]]。",
].join("\n");

const WIKI_RETRIEVAL = [
  "---",
  "type: topic",
  "title: 检索",
  "created: 2026-11-01",
  "---",
  "# 检索",
  "",
  "MVP 采用全文检索方案（index-first）。",
].join("\n");

const WIKI_SOURCE_PAGE = [
  "---",
  "type: source",
  "source: raw/transformer论文.md",
  "title: Transformer 论文精读",
  "created: 2026-11-01",
  "---",
  "# Transformer 论文精读",
  "",
  "摘要：self-attention 架构要点。",
].join("\n");

let fixture: CorpusFixture | null = null;
let session: TestSession | null = null;

async function setup(): Promise<{ fixture: CorpusFixture; session: TestSession }> {
  fixture = await createCorpusFixture({
    raw: {
      "transformer论文.md": RAW_TRANSFORMER,
      "周会记录.md": RAW_MEETING,
    },
    wiki: {
      "Transformer.md": WIKI_TRANSFORMER,
      "检索.md": WIKI_RETRIEVAL,
      "Transformer 论文精读.md": WIKI_SOURCE_PAGE,
    },
  });
  // 播种 index.md（用共享层渲染，保持与 apply 联动产物同格式）
  await writeIndex(fixture.root, {
    sources: [{ title: "Transformer 论文精读", sourcePath: "raw/transformer论文.md" }],
    topics: [
      { title: "Transformer", aliases: ["注意力机制", "自注意力"] },
      { title: "检索", aliases: [] },
    ],
  });
  await fixture.commitSeed();
  session = await connectTestClient(fixture.root);
  return { fixture, session };
}

afterEach(async () => {
  await session?.close();
  session = null;
  await fixture?.dispose();
  fixture = null;
});

function parseJson(result: CallToolResult): any {
  expect(result.isError).toBeFalsy();
  const text = result.content?.[0];
  expect(text?.type).toBe("text");
  return JSON.parse((text as { text: string }).text);
}

describe("工具面注册", () => {
  it("listTools 含 search 与 ingest_prepare", async () => {
    const { session } = await setup();
    const tools = await session.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("search");
    expect(names).toContain("ingest_prepare");
  });
});

describe("search 工具", () => {
  it("索引命中：标题、别名与来源页 raw 路径", async () => {
    const { session } = await setup();

    const byAlias = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "注意力机制", scope: "all" } }),
    );
    const topicHit = byAlias.indexHits.find((h: any) => h.title === "Transformer");
    expect(topicHit).toMatchObject({ section: "topics", matchedOn: "注意力机制" });
    expect(topicHit.aliases).toEqual(["注意力机制", "自注意力"]);

    const byTitle = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "论文精读" } }),
    );
    expect(byTitle.scope).toBe("all"); // scope 缺省 all
    expect(byTitle.indexHits).toContainEqual({
      section: "sources",
      title: "Transformer 论文精读",
      sourcePath: "raw/transformer论文.md",
      matchedOn: "Transformer 论文精读",
    });

    const bySourcePath = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "周会记录.md", scope: "wiki" } }),
    );
    expect(bySourcePath.indexHits).toEqual([]);
  });

  it("全文命中：路径、行号、摘录，且不区分大小写", async () => {
    const { session } = await setup();

    const result = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "Self-Attention" } }),
    );
    const rawHit = result.fullTextHits.find((h: any) => h.path === "raw/transformer论文.md");
    expect(rawHit).toBeDefined();
    expect(rawHit.line).toBe(2);
    expect(rawHit.excerpt.toLowerCase()).toContain("self-attention");

    const wikiHit = result.fullTextHits.find((h: any) => h.path === "wiki/Transformer 论文精读.md");
    expect(wikiHit).toBeDefined();
  });

  it("同行多次出现只记一条（去重）", async () => {
    const { session } = await setup();

    const result = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "注意力机制", scope: "raw" } }),
    );
    // 材料第 3、5 行各一次；每行一条，无重复 (path, line)
    const pairs = result.fullTextHits.map((h: any) => `${h.path}:${h.line}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(result.fullTextHits).toHaveLength(2);
  });

  it("scope 过滤：wiki 与 raw 各自命中、互不渗漏", async () => {
    const { session } = await setup();

    const onlyRaw = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "周会", scope: "all" } }),
    );
    expect(onlyRaw.fullTextHits.length).toBeGreaterThan(0);
    expect(onlyRaw.fullTextHits.every((h: any) => h.path === "raw/周会记录.md")).toBe(true);

    const rawScope = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "周会", scope: "raw" } }),
    );
    expect(rawScope.fullTextHits.every((h: any) => h.path === "raw/周会记录.md")).toBe(true);
    expect(rawScope.indexHits).toEqual([]); // raw scope 不查索引

    const wikiScopeMiss = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "周会", scope: "wiki" } }),
    );
    expect(wikiScopeMiss.fullTextHits).toEqual([]);

    const wikiScopeHit = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "全文检索", scope: "wiki" } }),
    );
    expect(wikiScopeHit.fullTextHits.map((h: any) => h.path)).toEqual(["wiki/检索.md"]);

    const rawScopeWikiWord = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "全文检索", scope: "raw" } }),
    );
    expect(rawScopeWikiWord.fullTextHits).toEqual([]);
  });

  it("无命中时返回空清单而非报错", async () => {
    const { session } = await setup();

    const result = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "不存在的词" } }),
    );
    expect(result.indexHits).toEqual([]);
    expect(result.fullTextHits).toEqual([]);
    expect(result.filesWithHits).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("文件级聚合 filesWithHits：摘录被配额截断时聚合仍如实（#23）", async () => {
    const { session, fixture: fx } = await setup();
    // 单文件 60 处命中：摘录只给 50 条（单文件配额），聚合记 60
    const manyHits = Array.from({ length: 60 }, (_, i) => `第${i + 1}处 周会记录。`).join("\n");
    await fx.seedRaw("高频词.md", manyHits);
    await fx.seedRaw("低频词.md", "周会记录 出现一次。");
    await fx.commitSeed();

    const result = parseJson(
      await session.client.callTool({ name: "search", arguments: { query: "周会记录", scope: "raw" } }),
    );
    const fromHot = result.fullTextHits.filter((h: any) => h.path === "raw/高频词.md");
    expect(fromHot).toHaveLength(50); // 摘录被单文件配额截断
    expect(result.truncated).toBe(true);
    // 聚合永不截断：高频词 60 + 低频词 1（周会记录.md 不在 raw scope 的本次断言范围内单独验证）
    const agg = new Map(result.filesWithHits.map((f: any) => [f.path, f.hits]));
    expect(agg.get("raw/高频词.md")).toBe(60);
    expect(agg.get("raw/低频词.md")).toBe(1);
    // 排序确定性：命中数降序
    const counts = result.filesWithHits.map((f: any) => f.hits);
    expect([...counts].sort((a: number, b: number) => b - a)).toEqual(counts);
  });

  it("空 query 被参数校验拒绝", async () => {
    const { session } = await setup();
    const result = (await session.client.callTool({
      name: "search",
      arguments: { query: "" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain("query");
  });
});

describe("ingest_prepare 工具", () => {
  it("合法路径：返回内容、stat 与相关页（source/title/alias/wikilink）", async () => {
    const { session } = await setup();

    const result = parseJson(
      await session.client.callTool({ name: "ingest_prepare", arguments: { rawPath: "raw/transformer论文.md" } }),
    );
    expect(result.path).toBe("raw/transformer论文.md");
    expect(result.content).toContain("self-attention 是整体架构的核心。");
    expect(result.stat.size).toBeGreaterThan(0);
    expect(result.stat.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const related = result.relatedPages as Array<{
      pagePath: string;
      relations: string[];
      matchedNames: string[];
    }>;
    const byPath = new Map(related.map((page) => [page.pagePath, page]));

    // 同一份材料已有的来源页（重复灌入检测）
    const sourcePage = byPath.get("wiki/Transformer 论文精读.md");
    expect(sourcePage?.relations).toContain("source");

    // 主题页标题出现在源内容
    const topicPage = byPath.get("wiki/Transformer.md");
    expect(topicPage?.relations).toContain("title");
    expect(topicPage?.matchedNames).toContain("Transformer");

    // 别名出现在源内容
    expect(topicPage?.relations).toContain("alias");
    expect(topicPage?.matchedNames).toContain("注意力机制");

    // 源内容中的 wikilink 解析到既有页面（含别名解析）
    const linkedPage = byPath.get("wiki/检索.md");
    expect(linkedPage?.relations).toContain("wikilink");
    expect(linkedPage?.matchedNames).toContain("检索");
  });

  it("对不存在的 raw 路径报错", async () => {
    const { session } = await setup();

    const result = (await session.client.callTool({
      name: "ingest_prepare",
      arguments: { rawPath: "raw/不存在.md" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain("不存在");
  });

  it("对 raw/ 外路径与路径逃逸报错", async () => {
    const { session } = await setup();

    const outside = (await session.client.callTool({
      name: "ingest_prepare",
      arguments: { rawPath: "wiki/Transformer.md" },
    })) as CallToolResult;
    expect(outside.isError).toBe(true);
    expect((outside.content?.[0] as { text: string }).text).toContain("raw/");

    const bare = (await session.client.callTool({
      name: "ingest_prepare",
      arguments: { rawPath: "transformer论文.md" },
    })) as CallToolResult;
    expect(bare.isError).toBe(true);

    const escape = (await session.client.callTool({
      name: "ingest_prepare",
      arguments: { rawPath: "../outside.md" },
    })) as CallToolResult;
    expect(escape.isError).toBe(true);
    expect((escape.content?.[0] as { text: string }).text).toContain("corpus 根");
  });

  it("支持 raw/ 子目录中的材料", async () => {
    const { fixture, session } = await setup();
    await fixture.seedRaw("notes/旧笔记.md", "# 旧笔记\n\n提到 [[检索]] 与自注意力。");
    await fixture.commitSeed();

    const result = parseJson(
      await session.client.callTool({ name: "ingest_prepare", arguments: { rawPath: "raw/notes/旧笔记.md" } }),
    );
    expect(result.path).toBe("raw/notes/旧笔记.md");
    expect(result.content).toContain("旧笔记");
    const paths = (result.relatedPages as Array<{ pagePath: string }>).map((p) => p.pagePath);
    expect(paths).toContain("wiki/检索.md");
  });
});

describe("只读边界", () => {
  it("search 与 ingest_prepare 不产生任何写入（工作树保持干净）", async () => {
    const { fixture, session } = await setup();

    await session.client.callTool({ name: "search", arguments: { query: "注意力机制" } });
    await session.client.callTool({
      name: "ingest_prepare",
      arguments: { rawPath: "raw/transformer论文.md" },
    });

    const status = await gitStatus(fixture.root);
    expect(status.clean).toBe(true);
  });
});

describe("ingest_prepare 的 git 边界前置（#17）", () => {
  let bareRoot: string | null = null;

  afterEach(async () => {
    if (bareRoot) {
      await rm(bareRoot, { recursive: true, force: true });
      bareRoot = null;
    }
  });

  it("脏树（未提交手改）：直接拒绝并列出脏文件，不返回内容", async () => {
    const { session, fixture: fx } = await setup();
    // 模拟人类手改未提交（未跟踪 wiki 文件属阻塞性脏，ADR-0005）
    await writeFile(
      path.join(fx.root, "wiki", "手写草稿.md"),
      "---\ntype: topic\ncreated: 2026-11-06\n---\n\n手写内容。\n",
      "utf8",
    );

    const result = (await session.client.callTool({
      name: "ingest_prepare",
      arguments: { rawPath: "raw/transformer论文.md" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain("不干净");
    expect(text).toContain("wiki/手写草稿.md");
    expect(text).not.toContain("self-attention");
  });

  it("非 git 库：直接拒绝并提示先 init", async () => {
    bareRoot = await mkdtemp(path.join(tmpdir(), "obsidian-corpus-prepare-"));
    await mkdir(path.join(bareRoot, "raw"), { recursive: true });
    await writeFile(path.join(bareRoot, "raw", "材料.md"), "# 材料\n", "utf8");
    const session2 = await connectTestClient(bareRoot);

    const result = (await session2.client.callTool({
      name: "ingest_prepare",
      arguments: { rawPath: "raw/材料.md" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain("init");
    await session2.close();
  });

  it("干净树：照常返回内容，并透出其余待灌材料（pendingRaw）", async () => {
    const { session, fixture: fx } = await setup();
    await writeFile(path.join(fx.root, "raw", "另一份.md"), "# 另一份\n", "utf8");

    const payload = parseJson(
      await session.client.callTool({
        name: "ingest_prepare",
        arguments: { rawPath: "raw/transformer论文.md" },
      }),
    );
    expect(payload.content).toContain("self-attention");
    expect(payload.git.clean).toBe(true);
    expect(payload.git.pendingRaw).toEqual(["raw/另一份.md"]);
  });
});
