import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "./registry.js";
import { AGENTS_FILE, INDEX_FILE, LOG_FILE, RAW_DIR, WIKI_DIR, TRASH_DIR } from "../corpus/paths.js";
import { renderIndex } from "../corpus/indexFile.js";
import { appendLog } from "../corpus/logFile.js";
import { gitAdd, gitCommit, gitInit } from "../corpus/git.js";

/** init 的 commit 消息（spec #1：`init: corpus`）。 */
export const INIT_COMMIT_MESSAGE = "init: corpus";

/**
 * init 生成的 AGENTS.md 占位骨架（#3）：文件必须就位，正式约定文本归 #6。
 */
export const AGENTS_PLACEHOLDER = [
  "# Corpus 维护约定",
  "",
  "本文件（AGENTS.md）承载本 Corpus 的维护约定，供人类与 AI agent 共同阅读、共同演进：",
  "页面类型（来源页/主题页）、frontmatter 要求、index.md 与 log.md 格式、ingest/query/lint 工作流。",
  "",
  "> 当前为 init 生成的占位骨架；完整约定文本将在后续维护中写入本文件。",
  "",
].join("\n");

/** 骨架目录（git 不跟踪空目录，仅落盘；幂等判断按存在性）。 */
const SKELETON_DIRS = [RAW_DIR, WIKI_DIR, TRASH_DIR];

/** 骨架文件及其初始内容。 */
function skeletonFiles(): Array<{ relPath: string; content: string }> {
  return [
    { relPath: AGENTS_FILE, content: AGENTS_PLACEHOLDER },
    { relPath: INDEX_FILE, content: renderIndex({ sources: [], topics: [] }) },
    { relPath: LOG_FILE, content: "" },
  ];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface InitResult {
  /** 本次创建的骨架项（文件相对路径、目录名与 `git`）。 */
  created: string[];
  /** 已存在而跳过的骨架项。 */
  existing: string[];
  /** 是否产生 commit（仅有骨架文件落地时记 log 并提交）。 */
  committed: boolean;
  /** 新 commit 的完整 sha；未提交为 null。 */
  commit: string | null;
}

/**
 * 幂等初始化 corpus 骨架（spec #1）：
 * AGENTS.md/index.md/log.md/raw//wiki//.trash/ 缺什么补什么，非 git 库则 `git init`；
 * 只要有骨架文件落地，就追加 Log（op=init）并入单个 commit（`init: corpus`）。
 * 已完整则无操作（不记 Log、不提交），幂等重跑零变更。
 */
export async function initCorpus(corpusDir: string): Promise<InitResult> {
  const root = path.resolve(corpusDir);
  const created: string[] = [];
  const existing: string[] = [];

  for (const dir of SKELETON_DIRS) {
    if (await exists(path.join(root, dir))) {
      existing.push(dir);
    } else {
      await mkdir(path.join(root, dir), { recursive: true });
      created.push(dir);
    }
  }

  // 非 git 库才 init（reinit 本身无副作用，但清单要如实区分创建/已存在）
  const gitDir = await exists(path.join(root, ".git"));
  if (gitDir) {
    existing.push("git");
  } else {
    await gitInit(root);
    created.push("git");
  }

  const createdFiles: string[] = [];
  for (const file of skeletonFiles()) {
    const abs = path.join(root, file.relPath);
    if (await exists(abs)) {
      existing.push(file.relPath);
    } else {
      await writeFile(abs, file.content, "utf8");
      created.push(file.relPath);
      createdFiles.push(file.relPath);
    }
  }

  if (createdFiles.length === 0) {
    // 目录/git 的补齐不产生工作树变化；无文件落地即无操作，不记 Log、不提交
    return { created, existing, committed: false, commit: null };
  }

  await appendLog(root, {
    op: "init",
    object: "corpus",
    note: `初始化骨架：${createdFiles.join("、")}`,
  });
  // 只提交 server 自己创建的骨架文件，绝不代人类提交其余改动（ADR-0004）
  await gitAdd(root, [AGENTS_FILE, INDEX_FILE, LOG_FILE]);
  const sha = await gitCommit(root, INIT_COMMIT_MESSAGE);
  return { created, existing, committed: true, commit: sha };
}

/** init 工具：幂等初始化 Corpus（冷启动零手工步骤）。 */
export const initTool: ToolDefinition = {
  name: "init",
  description:
    "幂等初始化 corpus 骨架（AGENTS.md/index.md/log.md/raw//wiki//.trash/，非 git 库则 git init）。" +
    "缺什么补什么；已有骨架文件落地时追加 log 并生成单个 commit（`init: corpus`）；已完整则无操作。",
  register(server, ctx) {
    server.registerTool(
      this.name,
      {
        description: this.description,
        inputSchema: {},
      },
      async () => {
        const result = await initCorpus(ctx.corpusDir);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  },
};
