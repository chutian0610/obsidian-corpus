import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectTestClient,
  createCorpusFixture,
  type CorpusFixture,
  type TestSession,
} from "./harness.js";
import { gitLog, gitStatus } from "../src/corpus/git.js";

/**
 * apply 写事务（#5）接缝测试：经 MCP 边界直调工具，
 * 只断言外部行为——工具返回值、corpus 落盘（wiki/.trash/index.md/log.md）、git log。

 * 夹具约定：createCorpusFixture 播种后做一次初始 commit，工作树干净；
 * 需要预置 index.md/log.md 的用例在测试内写入根目录后手动 commitSeed。
 */

let fixture: CorpusFixture | null = null;
let session: TestSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
  await fixture?.dispose();
  fixture = null;
});

interface ApplyResult {
  isError: boolean;
  payload: {
    ok: boolean;
    code?: string;
    issues?: Array<{ code: string; path?: string; target?: string; field?: string }>;
    dirtyFiles?: string[];
    applied?: Array<{ path: string; action: string; trashPath?: string }>;
    commit?: { sha: string; message: string };
  };
}

async function callApply(args: unknown): Promise<ApplyResult> {
  const result = await session!.client.callTool({ name: "apply", arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: result.isError === true, payload: JSON.parse(text) };
}

async function readRootFile(rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(fixture!.root, rel), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function seedRootFile(rel: string, content: string): Promise<void> {
  const abs = path.join(fixture!.root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

const RAW_NAME = "karpathy-llm.md";

const SOURCE_PAGE = [
  "---",
  "type: source",
  `source: raw/${RAW_NAME}`,
  "title: LLM 记账",
  "created: 2026-11-05",
  "---",
  "摘要：让 LLM 承担记账。相关主题 [[个人知识管理]]。",
  "",
].join("\n");

const TOPIC_PAGE = [
  "---",
  "type: topic",
  "created: 2026-11-05",
  "aliases: [PKM]",
  "---",
  "个人知识库的长期维护。来源 [[LLM 记账#摘要]]。",
  "",
].join("\n");

describe("apply：成功路径", () => {
  it("新建来源页 + 主题页：索引联动、日志追加、恰好一个 commit", async () => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "# LLM wiki\n原文内容" } });
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [
        { path: "wiki/LLM 记账.md", content: SOURCE_PAGE },
        { path: "wiki/个人知识管理.md", content: TOPIC_PAGE },
      ],
      log: { title: "灌入 LLM 记账笔记" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.ok).toBe(true);
    expect(result.payload.applied).toEqual([
      { path: "wiki/LLM 记账.md", action: "created" },
      { path: "wiki/个人知识管理.md", action: "created" },
    ]);
    expect(result.payload.commit?.message).toBe("ingest: 灌入 LLM 记账笔记");
    expect(result.payload.commit?.sha).toMatch(/^[0-9a-f]{40}$/u);

    // 落盘：两个 wiki 页
    expect(await readRootFile("wiki/LLM 记账.md")).toBe(SOURCE_PAGE);
    expect(await readRootFile("wiki/个人知识管理.md")).toBe(TOPIC_PAGE);

    // index.md 联动（apply 前不存在，由本批创建；条目行为 markdown 列表）
    const index = await readRootFile("index.md");
    expect(index).toContain("## Sources");
    expect(index).toContain("- [[LLM 记账]] — raw/karpathy-llm.md");
    expect(index).toContain("## Topics");
    expect(index).toContain("- [[个人知识管理]]（别名：PKM）");

    // log.md 追加（op=ingest、对象为标题）
    const log = await readRootFile("log.md");
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ingest \| 灌入 LLM 记账笔记$/mu);

    // git：恰好一个新 commit、消息规范化、树恢复干净
    const commits = await gitLog(fixture.root);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe("ingest: 灌入 LLM 记账笔记");
    expect(commits[0]?.sha).toBe(result.payload.commit?.sha);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });

  it("wikilink 命中现存页别名与本批新建页别名", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "既有主题.md": [
          "---",
          "type: topic",
          "created: 2026-10-01",
          "aliases: [旧称]",
          "---",
          "正文。",
          "",
        ].join("\n"),
      },
    });
    session = await connectTestClient(fixture.root);

    const newTopic = [
      "---",
      "type: topic",
      "created: 2026-11-05",
      "aliases: [新别名]",
      "---",
      "引用现存别名 [[旧称]] 与本批新建别名 [[新别名]]。",
      "",
    ].join("\n");
    const result = await callApply({
      changes: [{ path: "wiki/引用页.md", content: newTopic }],
      log: { title: "别名解析" },
    });

    expect(result.isError).toBe(false);
    // 自引用也合法：[[新别名]] 命中本批页面自身
    expect(result.payload.issues).toBeUndefined();
  });

  it("覆盖更新既有页：index 旧行被替换", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "演进主题.md": ["---", "type: topic", "created: 2026-10-01", "title: 演进主题", "---", "旧正文。", ""].join("\n"),
      },
    });
    await seedRootFile("index.md", "## Sources\n\n## Topics\n\n[[演进主题]]\n");
    await fixture.commitSeed();
    session = await connectTestClient(fixture.root);

    // title=文件名（#22）：更新保持 title 与文件名一致，别名演进由 index 行注记体现
    const updated = [
      "---",
      "type: topic",
      "created: 2026-10-01",
      "title: 演进主题",
      "aliases: [演进别名]",
      "---",
      "新正文。",
      "",
    ].join("\n");
    const result = await callApply({
      changes: [{ path: "wiki/演进主题.md", content: updated }],
      log: { title: "主题演进" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.applied).toEqual([{ path: "wiki/演进主题.md", action: "updated" }]);
    const index = await readRootFile("index.md");
    expect(index).toContain("- [[演进主题]]（别名：演进别名）");
    expect(index).not.toMatch(/^\[\[演进主题\]\]$/mu);
    expect((await gitLog(fixture.root)).slice(0, 1)[0]?.subject).toBe("ingest: 主题演进");
  });

  it("旧格式（无列表前缀）index 在任何 apply 后整体重渲染为列表格式", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "演进主题.md": ["---", "type: topic", "created: 2026-10-01", "title: 演进主题", "---", "旧正文。", ""].join("\n"),
      },
    });
    // 既有 corpus 的无 `- ` 前缀行：解析必须兼容，且重渲染后统一迁移
    await seedRootFile("index.md", "## Sources\n\n## Topics\n\n[[演进主题]]\n");
    await fixture.commitSeed();
    session = await connectTestClient(fixture.root);

    const updated = ["---", "type: topic", "created: 2026-10-01", "title: 演进主题", "---", "新正文。", ""].join("\n");
    const result = await callApply({
      changes: [{ path: "wiki/演进主题.md", content: updated }],
      log: { title: "正文更新" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.index).toEqual({ sources: 0, topics: 1 });
    const index = await readRootFile("index.md");
    expect(index).toContain("- [[演进主题]]");
    expect(index).not.toMatch(/^\[\[演进主题\]\]$/mu);
  });
});

describe("apply：拒绝路径（all-or-nothing）", () => {
  it("脏树拒绝并列出脏文件", async () => {
    fixture = await createCorpusFixture({
      raw: { [RAW_NAME]: "原文" },
      wiki: { "手改页.md": TOPIC_PAGE },
    });
    // 模拟人类手改已提交页面后未 commit
    await seedRootFile("wiki/手改页.md", TOPIC_PAGE + "追加的手改。\n");
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [{ path: "wiki/新页.md", content: TOPIC_PAGE }],
      log: { title: "不应成功" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.code).toBe("dirty_tree");
    expect(result.payload.dirtyFiles).toContain("wiki/手改页.md");
    expect(await gitLog(fixture.root)).toHaveLength(1);
    expect(await readRootFile("wiki/新页.md")).toBeNull();
  });

  it("断链拒绝：wikilink 目标不存在且不在本批新建内", async () => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const broken = TOPIC_PAGE.replace("[[LLM 记账#摘要]]", "[[不存在的页面]]");
    const result = await callApply({
      changes: [{ path: "wiki/LLM 记账.md", content: SOURCE_PAGE }, { path: "wiki/个人知识管理.md", content: broken }],
      log: { title: "断链批次" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.code).toBe("validation_failed");
    expect(result.payload.issues).toContainEqual(
      expect.objectContaining({ code: "broken_wikilink", path: "wiki/个人知识管理.md", target: "不存在的页面" }),
    );
    // 零残留：无新 commit、树干净、文件与 index/log 均未创建
    expect(await gitLog(fixture.root)).toHaveLength(1);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
    expect(await readRootFile("wiki/LLM 记账.md")).toBeNull();
    expect(await readRootFile("index.md")).toBeNull();
    expect(await readRootFile("log.md")).toBeNull();
  });

  it.each([
    ["raw/ 内", "raw/越界.md"],
    ["wiki/ 外", "notes/越界.md"],
    ["corpus 外", "../越界.md"],
    ["wiki/ 子目录", "wiki/sub/越界.md"],
    ["非 .md", "wiki/越界.txt"],
  ])("越界路径拒绝（%s）", async (_label, badPath) => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [{ path: badPath, content: TOPIC_PAGE }],
      log: { title: "越界批次" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.code).toBe("validation_failed");
    expect(result.payload.issues?.some((i) => i.code === "invalid_path")).toBe(true);
    expect(await gitLog(fixture.root)).toHaveLength(1);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });

  it("frontmatter 必填缺失拒绝，零残留", async () => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const bad = SOURCE_PAGE.replace("created: 2026-11-05\n", "");
    const result = await callApply({
      changes: [{ path: "wiki/LLM 记账.md", content: bad }],
      log: { title: "缺字段" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.issues).toContainEqual(
      expect.objectContaining({ code: "frontmatter", field: "created" }),
    );
    expect(await gitLog(fixture.root)).toHaveLength(1);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
    expect(await readRootFile("wiki/LLM 记账.md")).toBeNull();
  });

  it.each([
    ["非 raw/ 前缀", "notes/x.md"],
    ["绝对路径（POSIX）", "/tmp/x.md"],
    ["绝对路径（Windows 盘符）", "C:\\vault\\x.md"],
    [".. 逃逸", "raw/../x.md"],
    ["裸 raw/", "raw/"],
  ])("来源页 source 非法拒绝（%s）", async (_label, badSource) => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const bad = SOURCE_PAGE.replace(`source: raw/${RAW_NAME}`, `source: ${badSource}`);
    const result = await callApply({
      changes: [{ path: "wiki/LLM 记账.md", content: bad }],
      log: { title: "坏 source" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.issues).toContainEqual(
      expect.objectContaining({ code: "frontmatter", field: "source" }),
    );
    expect(await gitLog(fixture.root)).toHaveLength(1);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
    expect(await readRootFile("wiki/LLM 记账.md")).toBeNull();
  });

  it("删除会在现存页留下断链时拒绝", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "被引主题.md": ["---", "type: topic", "created: 2026-10-01", "---", "正文。", ""].join("\n"),
        "引用页.md": ["---", "type: topic", "created: 2026-10-01", "---", "参见 [[被引主题]]。", ""].join("\n"),
      },
    });
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [{ path: "wiki/被引主题.md", content: null }],
      log: { title: "删除被引页" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.issues).toContainEqual(
      expect.objectContaining({ code: "broken_wikilink", path: "wiki/引用页.md", target: "被引主题" }),
    );
    expect(await readRootFile("wiki/被引主题.md")).not.toBeNull();
    expect(await gitLog(fixture.root)).toHaveLength(1);
  });

  it("删除页并在同一变更集内更新引用页则成功", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "被引主题.md": ["---", "type: topic", "created: 2026-10-01", "---", "正文。", ""].join("\n"),
        "引用页.md": ["---", "type: topic", "created: 2026-10-01", "---", "参见 [[被引主题]]。", ""].join("\n"),
      },
    });
    session = await connectTestClient(fixture.root);

    const updated = ["---", "type: topic", "created: 2026-10-01", "---", "引用已随删除清理。", ""].join("\n");
    const result = await callApply({
      changes: [
        { path: "wiki/被引主题.md", content: null },
        { path: "wiki/引用页.md", content: updated },
      ],
      log: { title: "删除并清理引用" },
    });

    expect(result.isError).toBe(false);
    expect(await readRootFile("wiki/被引主题.md")).toBeNull();
    expect(await readRootFile(".trash/被引主题.md")).not.toBeNull();
    expect(await gitLog(fixture.root)).toHaveLength(2);
  });

  it("变更集内路径重复拒绝", async () => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [
        { path: "wiki/A.md", content: TOPIC_PAGE },
        { path: "wiki/A.md", content: SOURCE_PAGE },
      ],
      log: { title: "重复路径" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.issues?.some((i) => i.code === "duplicate_path")).toBe(true);
  });

  it("代码围栏与行内代码里的 [[ ]] 不触发 broken_wikilink（#21）", async () => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const withCode = TOPIC_PAGE.replace(
      "个人知识库的长期维护。",
      "代码示例：\n\n```ts\nconst s = \"[[字面量链接]]\";\n```\n\n行内 `[[inline]]`。",
    );
    const result = await callApply({
      changes: [
        { path: "wiki/LLM 记账.md", content: SOURCE_PAGE },
        { path: "wiki/个人知识管理.md", content: withCode },
      ],
      log: { title: "代码内链接" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.issues).toBeUndefined();
  });

  it("嵌入 ![[...]] 不要求目标是 wiki 页面（附件直通）", async () => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const withEmbed = TOPIC_PAGE.replace(
      "个人知识库的长期维护。",
      "配图 ![[截图.png]]，嵌入整页 ![[LLM 记账]]。",
    );
    const result = await callApply({
      changes: [
        { path: "wiki/LLM 记账.md", content: SOURCE_PAGE },
        { path: "wiki/个人知识管理.md", content: withEmbed },
      ],
      log: { title: "嵌入批次" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.issues).toBeUndefined();
  });

  it("小写 wikilink 命中大写标题页（解析不区分大小写）", async () => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const lowerLink = TOPIC_PAGE.replace("[[LLM 记账#摘要]]", "[[llm 记账]]");
    const result = await callApply({
      changes: [
        { path: "wiki/LLM 记账.md", content: SOURCE_PAGE },
        { path: "wiki/个人知识管理.md", content: lowerLink },
      ],
      log: { title: "小写链接" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.issues).toBeUndefined();
  });

  it.each([
    ["冒号", "wiki/时间线:2026.md"],
    ["竖线", "wiki/A|B.md"],
    ["尖括号", "wiki/<占位>.md"],
  ])("wiki 文件名含 Windows 非法字符拒绝（%s）", async (_label, badPath) => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [{ path: badPath, content: TOPIC_PAGE }],
      log: { title: "非法文件名" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.issues?.some((i) => i.code === "invalid_path")).toBe(true);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });

  it("删除不存在的页面拒绝", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [{ path: "wiki/幽灵.md", content: null }],
      log: { title: "删除幽灵" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.issues).toContainEqual(
      expect.objectContaining({ code: "delete_missing", path: "wiki/幽灵.md" }),
    );
  });

  it.each([
    ["op 非法（init）", { op: "init", title: "标题" }],
    ["op 非法（edit）", { op: "edit", title: "标题" }],
    ["title 为空", { title: "  " }],
    ["title 含 |", { title: "坏|标题" }],
  ])("日志条目非法拒绝（%s）", async (_label, log) => {
    fixture = await createCorpusFixture({ raw: { [RAW_NAME]: "原文" } });
    session = await connectTestClient(fixture.root);

    const result = await callApply({ changes: [{ path: "wiki/A.md", content: TOPIC_PAGE }], log });

    expect(result.isError).toBe(true);
    expect(result.payload.issues?.some((i) => i.code === "invalid_log")).toBe(true);
    expect(await gitLog(fixture.root)).toHaveLength(1);
  });

  it("op=refactor：log 条目与 commit 消息前缀联动（#24）", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "待改写.md": ["---", "type: topic", "created: 2026-10-01", "title: 待改写", "---", "旧正文。", ""].join("\n"),
      },
    });
    session = await connectTestClient(fixture.root);

    const updated = ["---", "type: topic", "created: 2026-10-01", "title: 待改写", "---", "改写后的正文。", ""].join("\n");
    const result = await callApply({
      changes: [{ path: "wiki/待改写.md", content: updated }],
      log: { op: "refactor", title: "改写待改写页", note: "纯重组，不涉及新材料" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.commit?.message).toBe("refactor: 改写待改写页");
    expect(result.payload.log).toEqual({ op: "refactor", object: "改写待改写页" });

    const log = await readRootFile("log.md");
    expect(log).toMatch(/\] refactor \| 改写待改写页$/mu);
    expect(log).toContain("纯重组，不涉及新材料");
    expect((await gitLog(fixture.root)).slice(0, 1)[0]?.subject).toBe("refactor: 改写待改写页");
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });

  it("title 与文件名不一致拒绝（title_filename_mismatch）", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const mismatch = [
      "---",
      "type: topic",
      "created: 2026-11-05",
      "title: 与文件名不同的标题",
      "---",
      "正文。",
      "",
    ].join("\n");
    const result = await callApply({
      changes: [{ path: "wiki/页面文件.md", content: mismatch }],
      log: { title: "标题文件名不符" },
    });

    expect(result.isError).toBe(true);
    expect(result.payload.issues).toContainEqual(
      expect.objectContaining({ code: "title_filename_mismatch", path: "wiki/页面文件.md", field: "title" }),
    );
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });

  it("新建页别名撞既有页标题拒绝，错误建议消歧义后缀（duplicate_name）", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "既有概念.md": ["---", "type: topic", "created: 2026-10-01", "---", "正文。", ""].join("\n"),
      },
    });
    session = await connectTestClient(fixture.root);

    // title=文件名下两页同名 title 已不可能（文件名唯一）；重名只能经别名引入
    const withAlias = [
      "---",
      "type: topic",
      "created: 2026-11-05",
      "aliases: [既有概念]",
      "---",
      "另一个概念，别名撞了别人。",
      "",
    ].join("\n");
    const result = await callApply({
      changes: [{ path: "wiki/新概念.md", content: withAlias }],
      log: { title: "别名撞名" },
    });

    expect(result.isError).toBe(true);
    const issue = result.payload.issues?.find((i) => i.code === "duplicate_name");
    expect(issue).toMatchObject({ target: "既有概念" });
    expect(issue?.message).toContain("消歧义后缀");
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });

  it("本批两页别名互撞拒绝；纯存量互撞不阻塞本批", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const pageA = [
      "---",
      "type: topic",
      "created: 2026-11-05",
      "aliases: [共用别名]",
      "---",
      "A。",
      "",
    ].join("\n");
    const pageB = [
      "---",
      "type: topic",
      "created: 2026-11-05",
      "aliases: [共用别名]",
      "---",
      "B。",
      "",
    ].join("\n");
    const both = await callApply({
      changes: [
        { path: "wiki/页面A.md", content: pageA },
        { path: "wiki/页面B.md", content: pageB },
      ],
      log: { title: "互撞" },
    });
    expect(both.isError).toBe(true);
    expect(both.payload.issues?.some((i) => i.code === "duplicate_name" && i.target === "共用别名")).toBe(true);

    // 存量互撞（人手改造成，不归 apply 管）+ 本批只动无关页面 → 不因存量冲突而拒
    fixture = await createCorpusFixture({
      wiki: {
        "存量A.md": ["---", "type: topic", "created: 2026-10-01", "aliases: [存量撞名]", "---", "旧A。", ""].join("\n"),
        "存量B.md": ["---", "type: topic", "created: 2026-10-01", "aliases: [存量撞名]", "---", "旧B。", ""].join("\n"),
      },
    });
    session = await connectTestClient(fixture.root);
    const unrelated = await callApply({
      changes: [
        { path: "wiki/无关页.md", content: ["---", "type: topic", "created: 2026-11-05", "---", "正文。", ""].join("\n") },
      ],
      log: { title: "无关批次" },
    });
    expect(unrelated.isError).toBe(false);
  });
});

describe("apply：删除走 .trash/", () => {
  it("content:null 删除：文件入 .trash/、索引行消失、单 commit", async () => {
    fixture = await createCorpusFixture({
      raw: { [RAW_NAME]: "原文" },
      wiki: { "LLM 记账.md": SOURCE_PAGE },
    });
    await seedRootFile("index.md", `## Sources\n\n[[LLM 记账]] — raw/${RAW_NAME}\n\n## Topics\n`);
    await seedRootFile("log.md", "## [2026-11-01 09:00] init | corpus\n");
    await fixture.commitSeed();
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [{ path: "wiki/LLM 记账.md", content: null }],
      log: { title: "移除来源页", note: "内容并入主题页" },
    });

    expect(result.isError).toBe(false);
    expect(result.payload.applied).toEqual([
      { path: "wiki/LLM 记账.md", action: "deleted", trashPath: ".trash/LLM 记账.md" },
    ]);

    // 文件移入 .trash/ 且内容不变
    expect(await readRootFile("wiki/LLM 记账.md")).toBeNull();
    const trashed = await readRootFile(".trash/LLM 记账.md");
    expect(trashed).toBe(SOURCE_PAGE);

    // 索引行消失、节结构保留
    const index = await readRootFile("index.md");
    expect(index).not.toContain("[[LLM 记账]]");
    expect(index).toContain("## Sources");
    expect(index).toContain("## Topics");

    // 日志只增：旧条目仍在，新条目带说明行
    const log = await readRootFile("log.md");
    expect(log).toMatch(/\] init \| corpus$/mu);
    expect(log).toMatch(/\] ingest \| 移除来源页$/mu);
    expect(log).toContain("内容并入主题页");

    // 单 commit、树干净（夹具初始 1 + 预置 index/log 的 1 + apply 的 1）
    expect(await gitLog(fixture.root)).toHaveLength(3);
    expect((await gitLog(fixture.root))[0]?.subject).toBe("ingest: 移除来源页");
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });
});

describe("apply 显式暂存（#10）：commit 只含本操作产物", () => {
  const execFileAsync = promisify(execFile);

  /** 列出一个 commit 的全部文件（--no-renames 展开 rename 为删除+新增，见真实文件集）。 */
  async function commitFiles(sha: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["show", "--no-renames", "--name-only", "--pretty=format:", sha],
      { cwd: fixture!.root },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .sort();
  }

  it("新建场景：commit 文件集合恰好等于计划页面 + index + log", async () => {
    fixture = await createCorpusFixture({ raw: { "暂存材料.md": "# 暂存材料\n\n正文。" } });
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [
        {
          path: "wiki/暂存材料.md",
          content: [
            "---",
            "type: source",
            "source: raw/暂存材料.md",
            "title: 暂存材料",
            "created: 2026-11-05",
            "---",
            "",
            "摘要，链到 [[暂存主题]]。",
            "",
          ].join("\n"),
        },
        {
          path: "wiki/暂存主题.md",
          content: ["---", "type: topic", "created: 2026-11-05", "---", "", "见 [[暂存材料]]。", ""].join(
            "\n",
          ),
        },
      ],
      log: { title: "暂存材料" },
    });
    expect(result.isError).toBe(false);
    const sha = result.payload.commit!.sha;

    // 不变量：agent 的 commit 恰好只包含本操作的产物，不多不少
    expect(await commitFiles(sha)).toEqual([
      "index.md",
      "log.md",
      "wiki/暂存主题.md",
      "wiki/暂存材料.md",
    ]);
  });

  it("删除场景：commit 含被删原路径与 .trash/ 目标", async () => {
    fixture = await createCorpusFixture({
      wiki: {
        "待删主题.md": [
          "---",
          "type: topic",
          "created: 2026-11-05",
          "---",
          "",
          "独立主题，无入链。",
          "",
        ].join("\n"),
      },
    });
    session = await connectTestClient(fixture.root);

    const result = await callApply({
      changes: [{ path: "wiki/待删主题.md", content: null }],
      log: { title: "删除待删主题" },
    });
    expect(result.isError).toBe(false);
    const sha = result.payload.commit!.sha;

    expect(await commitFiles(sha)).toEqual([
      ".trash/待删主题.md",
      "index.md",
      "log.md",
      "wiki/待删主题.md",
    ]);
  });
});
