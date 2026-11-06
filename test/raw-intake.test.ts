import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { connectTestClient, type TestSession } from "./harness.js";
import { gitLog } from "../src/corpus/git.js";

const execFileAsync = promisify(execFile);

/**
 * raw 待灌材料（#15 / ADR-0005）接缝测试：
 * 「放材料进 raw/ → 触发 ingest」不再被脏树检查拦截；被引用原料随 ingest 同 commit 入库。
 * 只断言外部行为：工具返回、git 状态与 commit 文件集。
 */

let session: TestSession | null = null;
let bareRoot: string | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
  if (bareRoot) {
    await rm(bareRoot, { recursive: true, force: true });
    bareRoot = null;
  }
});

/** 空目录 commit 需要身份：进程内注入，不碰宿主机 git 配置。 */
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

async function callTool<T>(name: string, args: unknown): Promise<{ isError: boolean; payload: T }> {
  const result = await session!.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: result.isError === true, payload: JSON.parse(text) as T };
}

/** init 过的空 corpus（骨架齐全、树干净）。 */
async function makeInitedCorpus(): Promise<string> {
  bareRoot = await mkdtemp(path.join(tmpdir(), "obsidian-corpus-raw-"));
  session = await connectTestClient(bareRoot);
  await withGitIdentity(() => callTool("init", {}));
  return bareRoot;
}

/** 未经 git 提交地放入一份 raw 材料（复现库主人的真实操作）。 */
async function dropRaw(root: string, rel: string, content: string): Promise<void> {
  await writeFile(path.join(root, rel), content, "utf8");
}

interface StatusPayload {
  gitClean: boolean;
  dirtyFiles: string[];
  pendingRaw: string[];
}

interface ApplyPayload {
  ok: boolean;
  code?: string;
  commit?: { sha: string };
}

function sourcePageArgs(rawRel: string, title: string): unknown {
  return {
    changes: [
      {
        path: `wiki/${title}.md`,
        content: [
          "---",
          "type: source",
          `source: ${rawRel}`,
          `title: ${title}`,
          "created: 2026-11-06",
          "---",
          "",
          "摘要正文。",
          "",
        ].join("\n"),
      },
    ],
    log: { title },
  };
}

async function commitFiles(root: string, sha: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["show", "--no-renames", "--name-only", "--pretty=format:", sha],
    { cwd: root },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
}

describe("raw 待灌材料（#15 / ADR-0005）", () => {
  it("用户场景：未提交的新材料不阻塞 ingest，且随同一 commit 入库", async () => {
    const root = await makeInitedCorpus();
    await dropRaw(root, "raw/新材料.md", "# 新材料\n\n正文。");

    // status：新材料在 pendingRaw，不算脏
    const status = await callTool<StatusPayload>("status", {});
    expect(status.payload.gitClean).toBe(true);
    expect(status.payload.pendingRaw).toEqual(["raw/新材料.md"]);
    expect(status.payload.dirtyFiles).toEqual([]);

    // apply（来源页引用该材料）：成功，不再 dirty_tree
    const apply = await withGitIdentity(() =>
      callTool<ApplyPayload>("apply", sourcePageArgs("raw/新材料.md", "新材料")),
    );
    expect(apply.isError).toBe(false);
    expect(apply.payload.ok).toBe(true);

    // 一次 ingest = 原料 + 页面 + index + log 一个 commit
    const sha = apply.payload.commit!.sha;
    expect(await commitFiles(root, sha)).toEqual([
      "index.md",
      "log.md",
      "raw/新材料.md",
      "wiki/新材料.md",
    ]);
    // 入库后树干净、无待灌
    const after = await callTool<StatusPayload>("status", {});
    expect(after.payload.gitClean).toBe(true);
    expect(after.payload.pendingRaw).toEqual([]);
  });

  it("未被引用的待灌材料：不阻塞、不被带入，留待下次", async () => {
    const root = await makeInitedCorpus();
    await dropRaw(root, "raw/被引用.md", "# 被引用\n");
    await dropRaw(root, "raw/未被引用.md", "# 未被引用\n");

    const apply = await withGitIdentity(() =>
      callTool<ApplyPayload>("apply", sourcePageArgs("raw/被引用.md", "被引用")),
    );
    expect(apply.isError).toBe(false);
    const sha = apply.payload.commit!.sha;
    const files = await commitFiles(root, sha);
    expect(files).toContain("raw/被引用.md");
    expect(files).not.toContain("raw/未被引用.md");

    const after = await callTool<StatusPayload>("status", {});
    expect(after.payload.gitClean).toBe(true);
    expect(after.payload.pendingRaw).toEqual(["raw/未被引用.md"]);
  });

  it("已跟踪 raw 文件被改动：仍然阻塞（Raw 层不可变）", async () => {
    const root = await makeInitedCorpus();
    await dropRaw(root, "raw/入库材料.md", "# 入库材料\n");
    const first = await withGitIdentity(() =>
      callTool<ApplyPayload>("apply", sourcePageArgs("raw/入库材料.md", "入库材料")),
    );
    expect(first.isError).toBe(false);

    // 手改已入库的 raw 文件（模拟误改）
    await dropRaw(root, "raw/入库材料.md", "# 入库材料（被改动）\n");
    await dropRaw(root, "raw/另一份.md", "# 另一份\n");

    const status = await callTool<StatusPayload>("status", {});
    expect(status.payload.gitClean).toBe(false);
    expect(status.payload.dirtyFiles).toEqual(["raw/入库材料.md"]);
    expect(status.payload.pendingRaw).toEqual(["raw/另一份.md"]);

    const second = await withGitIdentity(() =>
      callTool<ApplyPayload>("apply", sourcePageArgs("raw/另一份.md", "另一份")),
    );
    expect(second.isError).toBe(true);
    expect(second.payload.code).toBe("dirty_tree");
    expect((await gitLog(root)).length).toBe(2);
  });

  it("未跟踪的 wiki 文件：仍是脏（人类手改保护不放松）", async () => {
    const root = await makeInitedCorpus();
    await dropRaw(root, "raw/材料.md", "# 材料\n");
    await dropRaw(
      root,
      "wiki/手写草稿.md",
      "---\ntype: topic\ncreated: 2026-11-06\n---\n\n手写内容。\n",
    );

    const status = await callTool<StatusPayload>("status", {});
    expect(status.payload.gitClean).toBe(false);
    expect(status.payload.dirtyFiles).toEqual(["wiki/手写草稿.md"]);
    expect(status.payload.pendingRaw).toEqual(["raw/材料.md"]);

    const apply = await withGitIdentity(() =>
      callTool<ApplyPayload>("apply", sourcePageArgs("raw/材料.md", "材料")),
    );
    expect(apply.isError).toBe(true);
    expect(apply.payload.code).toBe("dirty_tree");
  });
});
