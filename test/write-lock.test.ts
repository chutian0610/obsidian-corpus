import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectTestClient,
  createCorpusFixture,
  type CorpusFixture,
  type TestSession,
} from "./harness.js";
import { gitLog, gitStatus } from "../src/corpus/git.js";
import { corpusLockPath } from "../src/corpus/lockfile.js";

/**
 * 写级互斥锁（#8）接缝测试：经 MCP 边界直调 init/apply，
 * 只断言外部行为——工具返回值、corpus 零变更（git status/log）、锁文件的生灭。
 * 锁文件在系统临时目录、按 corpus 路径哈希命名，测试用 corpusLockPath 预置/检查。
 */

/** 超出常见 pid_max 的占位 PID：kill 必返 ESRCH，稳当的"已死进程"。 */
const DEAD_PID = 400000;

let fixture: CorpusFixture | null = null;
let session: TestSession | null = null;

afterEach(async () => {
  delete process.env.CORPUS_LOCK_TIMEOUT_MS;
  await session?.close();
  session = null;
  await fixture?.dispose();
  fixture = null;
});

async function callTool(name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
  const result = await session!.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: result.isError === true, text };
}

/** 预置一把指定 PID 的锁，返回锁文件绝对路径。 */
async function presetLock(root: string, pid: number): Promise<string> {
  const lockPath = await corpusLockPath(root);
  await writeFile(lockPath, JSON.stringify({ pid, acquiredAt: new Date().toISOString() }), "utf8");
  return lockPath;
}

async function lockExists(lockPath: string): Promise<boolean> {
  try {
    await readFile(lockPath, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function validApplyArgs(): unknown {
  return {
    changes: [
      {
        path: "wiki/锁测试来源页.md",
        content: [
          "---",
          "type: source",
          "source: raw/锁测试材料.md",
          "title: 锁测试材料",
          "created: 2026-11-05",
          "---",
          "",
          "摘要，链到 [[锁测试主题]]。",
          "",
        ].join("\n"),
      },
      {
        path: "wiki/锁测试主题.md",
        content: ["---", "type: topic", "created: 2026-11-05", "---", "", "见 [[锁测试材料]]。", ""].join(
          "\n",
        ),
      },
    ],
    log: { title: "锁测试材料" },
  };
}

describe("corpus 写级锁（#8）", () => {
  it("陈旧锁（持锁进程已死）：apply 破锁接管，事务成功且锁正常释放", async () => {
    fixture = await createCorpusFixture({ raw: { "锁测试材料.md": "# 锁测试材料\n\n正文。" } });
    session = await connectTestClient(fixture.root);
    await callTool("init", {});
    const lockPath = await presetLock(fixture.root, DEAD_PID);

    const { isError, text } = await callTool("apply", validApplyArgs());
    expect(isError).toBe(false);
    const payload = JSON.parse(text) as { ok: boolean; applied?: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.applied).toHaveLength(2);

    // 成功事务结束后锁已释放
    expect(await lockExists(lockPath)).toBe(false);
    expect((await gitStatus(fixture.root)).clean).toBe(true);
  });

  it("活锁（其他进程持有）：apply 等待超时后拒绝，corpus 零变更", async () => {
    fixture = await createCorpusFixture({ raw: { "锁测试材料.md": "# 锁测试材料\n\n正文。" } });
    session = await connectTestClient(fixture.root);
    await callTool("init", {});
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    const commitsBefore = (await gitLog(fixture.root)).length;
    try {
      const lockPath = await presetLock(fixture.root, child.pid!);
      process.env.CORPUS_LOCK_TIMEOUT_MS = "400";

      const { isError, text } = await callTool("apply", validApplyArgs());
      expect(isError).toBe(true);
      const payload = JSON.parse(text) as { ok: boolean; code?: string };
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe("lock_busy");
      expect(text).toContain(`PID ${child.pid}`);

      // 拒绝后：锁仍在（属于持锁者）、树干净、无新 commit
      expect(await lockExists(lockPath)).toBe(true);
      expect((await gitStatus(fixture.root)).clean).toBe(true);
      expect((await gitLog(fixture.root))).toHaveLength(commitsBefore);
    } finally {
      child.kill();
    }
  });

  it("无锁正常路径：apply 成功后不留锁文件", async () => {
    fixture = await createCorpusFixture({ raw: { "锁测试材料.md": "# 锁测试材料\n\n正文。" } });
    session = await connectTestClient(fixture.root);
    await callTool("init", {});

    const { isError } = await callTool("apply", validApplyArgs());
    expect(isError).toBe(false);
    expect(await lockExists(await corpusLockPath(fixture.root))).toBe(false);
  });

  it("init 同样受锁保护：活锁拒绝、陈旧锁破锁", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    // 先 init 一次建立基线 commit 数
    await callTool("init", {});
    const commits = (await gitLog(fixture.root)).length;

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      process.env.CORPUS_LOCK_TIMEOUT_MS = "400";
      await presetLock(fixture.root, child.pid!);
      const busy = await callTool("init", {});
      expect(busy.isError).toBe(true);
      expect(busy.text).toContain("锁");
      expect((await gitLog(fixture.root))).toHaveLength(commits);
    } finally {
      child.kill();
    }

    // 陈旧锁：init 幂等（骨架已全），破锁后正常返回
    await presetLock(fixture.root, DEAD_PID);
    const stale = await callTool("init", {});
    expect(stale.isError).toBe(false);
    expect(JSON.parse(stale.text).committed).toBe(false);
  });
});
