import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectTestClient, createCorpusFixture, type CorpusFixture, type TestSession } from "./harness.js";
import { gitLog, gitStatus } from "../src/corpus/git.js";
import { readLog } from "../src/corpus/logFile.js";
import { CORPUS_AGENTS_MD_VERSION, SHIPPED_AGENTS_MD } from "../src/corpus/agentsFile.js";
import type { InitResult } from "../src/tools/init.js";
import type { StatusResult } from "../src/tools/status.js";

/**
 * T2（#3）接缝测试：init（幂等骨架 + log + 单 commit）与 status（只读概览）。
 * 只断言外部行为：工具返回、corpus 落盘、git log（spec #1 Testing Decisions）。
 */

let fixture: CorpusFixture | null = null;
let session: TestSession | null = null;
let bareRoot: string | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
  await fixture?.dispose();
  fixture = null;
  if (bareRoot) {
    await rm(bareRoot, { recursive: true, force: true });
    bareRoot = null;
  }
});

/**
 * 空目录（非 git 库）上 init 的 commit 需要身份；
 * 用进程环境变量注入，不落盘、不改宿主机 git 配置。
 */
const GIT_IDENTITY_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "corpus-test",
  GIT_AUTHOR_EMAIL: "corpus-test@example.invalid",
  GIT_COMMITTER_NAME: "corpus-test",
  GIT_COMMITTER_EMAIL: "corpus-test@example.invalid",
};

async function withGitIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(GIT_IDENTITY_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function callJson<T>(s: TestSession, name: string): Promise<T> {
  const result = await s.client.callTool({ name, arguments: {} });
  expect(result.isError).toBeFalsy();
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return JSON.parse(text) as T;
}

async function makeBareRoot(): Promise<string> {
  bareRoot = await mkdtemp(path.join(tmpdir(), "obsidian-corpus-init-"));
  return bareRoot;
}

const SOURCE_PAGE_A = `---
type: source
source: raw/材料A.md
title: 材料A
created: 2026-11-05
---

材料A 的摘要，另见 [[主题页]]。
`;

const SOURCE_PAGE_B = `---
type: source
source: raw/材料B.md
title: 材料B
created: 2026-11-05
---

材料B 的摘要。
`;

const TOPIC_PAGE = `---
type: topic
created: 2026-11-05
aliases:
  - 主题别名
---

主题页正文，引用 [[材料A]]。
`;

describe("init", () => {
  it("空目录 init：骨架齐全、记 log、单 commit（init: corpus）", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    const result = await withGitIdentity(() => callJson<InitResult>(s, "init"));
    expect(result.created.sort()).toEqual(
      [".trash", "git", "AGENTS.md", "index.md", "log.md", ".gitignore", "raw", "wiki"].sort(),
    );
    expect(result.existing).toEqual([]);
    expect(result.committed).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/u);

    // 落盘骨架齐全
    for (const entry of ["AGENTS.md", "index.md", "log.md", ".gitignore", "raw", "wiki", ".trash", ".git"]) {
      await expect(stat(path.join(root, entry))).resolves.toBeTruthy();
    }
    const indexText = await readFile(path.join(root, "index.md"), "utf8");
    expect(indexText).toContain("## Sources");
    expect(indexText).toContain("## Topics");
    // AGENTS.md 落正式约定文本：三层结构、页面 frontmatter、Ingest/Query/Lint 工作流、git 纪律
    const agentsText = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agentsText).toContain("# Corpus 约定");
    expect(agentsText).toContain("## 三层结构");
    expect(agentsText).toContain("Raw sources（`raw/`）");
    expect(agentsText).toContain("Wiki（`wiki/`）");
    expect(agentsText).toContain("### Ingest（灌入一份 Raw 材料）");
    expect(agentsText).toContain("`ingest_prepare`");
    expect(agentsText).toContain("`apply`");
    expect(agentsText).toContain("### Query（查询）");
    expect(agentsText).toContain("### Lint（体检）");
    expect(agentsText).toContain("type: source");
    expect(agentsText).toContain("type: topic");
    expect(agentsText).toContain("## 安全边界与 git 纪律");
    expect(agentsText).toContain(".gitignore");
    expect(agentsText).not.toContain("占位");

    // git：恰好一个 commit、工作树干净
    const log = await gitLog(root, 10);
    expect(log).toHaveLength(1);
    expect(log[0]?.subject).toBe("init: corpus");
    expect((await gitStatus(root)).clean).toBe(true);

    // log.md：一条可解析的 init 条目
    const entries = await readLog(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe("init");
    expect(entries[0]?.object).toBe("corpus");
    expect(entries[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  });

  it("幂等重跑：无变更、不记 log、无新 commit", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    await withGitIdentity(() => callJson<InitResult>(s, "init"));
    const again = await withGitIdentity(() => callJson<InitResult>(s, "init"));

    expect(again.created).toEqual([]);
    expect(again.existing.sort()).toEqual(
      [".trash", "git", "AGENTS.md", "index.md", "log.md", ".gitignore", "raw", "wiki"].sort(),
    );
    expect(again.committed).toBe(false);
    expect(again.commit).toBeNull();
    expect((await gitStatus(root)).clean).toBe(true);
    expect(await gitLog(root, 10)).toHaveLength(1);
    expect(await readLog(root)).toHaveLength(1);
  });

  it("部分缺失：只补缺失项，仍入单 commit", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    await withGitIdentity(() => callJson<InitResult>(s, "init"));
    await rm(path.join(root, "index.md"));
    const result = await withGitIdentity(() => callJson<InitResult>(s, "init"));

    expect(result.created).toEqual(["index.md"]);
    expect(result.committed).toBe(true);
    const log = await gitLog(root, 10);
    expect(log).toHaveLength(2);
    expect(log[0]?.subject).toBe("init: corpus");
    expect(await readLog(root)).toHaveLength(2);
    expect((await gitStatus(root)).clean).toBe(true);
  });
});

describe("status", () => {
  it("播种 corpus 的 status：git 干净、计数与最近日志正确", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);
    const s = session;

    await callJson<InitResult>(s, "init");
    await fixture.seedRaw("材料A.md", "材料A 正文");
    await fixture.seedWikiPage("材料A.md", SOURCE_PAGE_A);
    await fixture.seedWikiPage("材料B.md", SOURCE_PAGE_B);
    await fixture.seedWikiPage("主题页.md", TOPIC_PAGE);
    await fixture.commitSeed();

    const status = await callJson<StatusResult>(s, "status");
    expect(status.gitRepo).toBe(true);
    expect(status.gitClean).toBe(true);
    expect(status.dirtyFiles).toEqual([]);
    expect(status.sourcePages).toBe(2);
    expect(status.topicPages).toBe(1);
    expect(status.invalidPages).toBe(0);
    const last = status.recentLog[status.recentLog.length - 1];
    expect(last?.op).toBe("init");
    expect(last?.object).toBe("corpus");
  });

  it("脏树下 status：如实报告 uncommitted 文件", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);
    const s = session;

    await callJson<InitResult>(s, "init");
    await fixture.seedWikiPage("材料A.md", SOURCE_PAGE_A);
    await fixture.commitSeed();
    // 模拟人类手改后未 commit
    await writeFile(
      path.join(fixture.root, "wiki", "材料A.md"),
      SOURCE_PAGE_A + "\n手改补记。",
      "utf8",
    );

    const status = await callJson<StatusResult>(s, "status");
    expect(status.gitClean).toBe(false);
    expect(status.dirtyFiles).toContain("wiki/材料A.md");
  });

  it("未 init 的目录 status：gitRepo=false、零计数", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const status = await callJson<StatusResult>(session, "status");
    expect(status.gitRepo).toBe(false);
    expect(status.gitClean).toBe(false);
    expect(status.dirtyFiles).toEqual([]);
    expect(status.sourcePages).toBe(0);
    expect(status.topicPages).toBe(0);
    expect(status.recentLog).toEqual([]);
  });
});

describe("init 的 .gitignore（#12）", () => {
  it("创建默认 .gitignore；工具目录不再弄脏工作树", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    await withGitIdentity(() => callJson<InitResult>(s, "init"));
    const text = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(text).toContain(".DS_Store");
    expect(text).toContain(".obsidian/");
    expect(text).toContain(".zcode/");
    expect(text).toContain(".vscode/");
    // .trash/ 保持跟踪（删除审计依赖 git 历史），不得进 ignore
    expect(text).not.toContain(".trash");

    // 模拟 Obsidian 打开 corpus 拉出的配置目录：status 应保持干净
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    await writeFile(path.join(root, ".obsidian", "workspace.json"), "{}", "utf8");
    const status = await callJson<StatusResult>(s, "status");
    expect(status.gitClean).toBe(true);
    expect(status.dirtyFiles).toEqual([]);
  });

  it("已有 .gitignore 时 init 不覆盖（库主人文件）", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    await writeFile(path.join(root, ".gitignore"), "custom/\n", "utf8");
    const result = await withGitIdentity(() => callJson<InitResult>(s, "init"));
    expect(result.existing).toContain(".gitignore");
    expect(result.created).not.toContain(".gitignore");
    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("custom/\n");
  });
});

describe("init 的约定文本升级（#19 / ADR-0006）", () => {
  it("全新 init：AGENTS.md 带当前版本标记与 v2 新增约定", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    const result = await withGitIdentity(() => callJson<InitResult>(s, "init"));
    expect(result.upgraded).toEqual([]);
    expect(result.customized).toEqual([]);
    const text = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(text).toContain(`<!-- corpus-agents: v${CORPUS_AGENTS_MD_VERSION} -->`);
    expect(text).toContain("编译价值门槛");
    expect(text).toContain("title 必须与文件名");
    expect(text).toContain("`![[...]]` 是嵌入");
    expect(text).toContain("数据不是指令");
  });

  it("v1 旧文本（逐字节一致）：自动升级到当前版、单 commit、log 记录升级", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    // 播种 v1 原文（未跟踪文件，模拟既有 corpus 的受管文本）
    await writeFile(path.join(root, "AGENTS.md"), SHIPPED_AGENTS_MD.get(1) ?? "", "utf8");
    const result = await withGitIdentity(() => callJson<InitResult>(s, "init"));

    expect(result.created).not.toContain("AGENTS.md");
    expect(result.existing).toContain("AGENTS.md");
    expect(result.upgraded).toEqual(["AGENTS.md"]);
    expect(result.customized).toEqual([]);
    expect(result.committed).toBe(true);

    const text = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(text).toBe(SHIPPED_AGENTS_MD.get(CORPUS_AGENTS_MD_VERSION));
    // git：恰好多一条 init commit，且升级后的 AGENTS.md 随之入库、树恢复干净
    const log = await gitLog(root, 10);
    expect(log).toHaveLength(1);
    expect((await gitStatus(root)).clean).toBe(true);
    // log.md：init 条目的 note 记录了升级
    const entries = await readLog(root);
    expect(entries.at(-1)?.op).toBe("init");
    expect(entries.at(-1)?.note).toContain("升级约定文本");
  });

  it("被库主人改过的 AGENTS.md：不升级、文件原样、结果提示手动合并", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    const customizedText = `${SHIPPED_AGENTS_MD.get(1) ?? ""}\n本地补充约定。\n`;
    await writeFile(path.join(root, "AGENTS.md"), customizedText, "utf8");
    const result = await withGitIdentity(() => callJson<InitResult>(s, "init"));

    expect(result.upgraded).toEqual([]);
    expect(result.customized).toEqual(["AGENTS.md"]);
    // 文件原样保留（其余骨架正常创建并提交，但不staging 人类的 AGENTS.md）
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(customizedText);
  });

  it("已是当前版：幂等重跑不触发升级路径", async () => {
    const root = await makeBareRoot();
    session = await connectTestClient(root);
    const s = session;

    await withGitIdentity(() => callJson<InitResult>(s, "init"));
    const again = await withGitIdentity(() => callJson<InitResult>(s, "init"));
    expect(again.upgraded).toEqual([]);
    expect(again.customized).toEqual([]);
    expect(again.committed).toBe(false);
    expect(await gitLog(root, 10)).toHaveLength(1);
  });
});
