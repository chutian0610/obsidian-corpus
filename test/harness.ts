import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { gitAdd, gitCommit, gitInit, gitStatus } from "../src/corpus/git.js";
import { RAW_DIR, WIKI_DIR } from "../src/corpus/paths.js";

const execFileAsync = promisify(execFile);

/**
 * 测试 harness（spec #1 Testing Decisions）：
 * MCP 客户端经 InMemoryTransport 同进程直连 server，打到临时 corpus 夹具上
 * （mkdtemp + git init + 按需播种 raw/wiki + 初始 commit 保证工作树干净）。
 */

export interface CorpusFixture {
  /** 临时 corpus 根（绝对路径）。 */
  root: string;
  /** 播种一份 raw 材料（relPath 相对 raw/）。 */
  seedRaw(relPath: string, content: string): Promise<void>;
  /** 播种一个 wiki 页（fileName 形如 `xxx.md`）。 */
  seedWikiPage(fileName: string, content: string): Promise<void>;
  /** 把当前播种内容提交，恢复工作树干净（模拟人类手改后自行 commit）。 */
  commitSeed(message?: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface TestSession {
  client: Client;
  close(): Promise<void>;
}

/** 建临时 corpus 夹具；播种内容会作为初始 commit 落库。 */
export async function createCorpusFixture(
  seed: { raw?: Record<string, string>; wiki?: Record<string, string> } = {},
): Promise<CorpusFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-corpus-test-"));
  await gitInit(root);
  // 夹具仓库局部身份，隔离宿主机全局 git 配置
  await execFileAsync("git", ["config", "user.name", "corpus-test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "corpus-test@example.invalid"], { cwd: root });

  const fixture: CorpusFixture = {
    root,
    async seedRaw(relPath, content) {
      const abs = path.join(root, RAW_DIR, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    },
    async seedWikiPage(fileName, content) {
      const abs = path.join(root, WIKI_DIR, fileName);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    },
    async commitSeed(message = "test: seed corpus fixture") {
      const status = await gitStatus(root);
      // 待灌 raw 材料（ADR-0005）不算脏，但夹具播种仍需入库（模拟库主人提交全部初始内容）
      if (status.clean && status.pendingRaw.length === 0) {
        return "";
      }
      await gitAdd(root, ["."]);
      return gitCommit(root, message);
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };

  for (const [relPath, content] of Object.entries(seed.raw ?? {})) {
    await fixture.seedRaw(relPath, content);
  }
  for (const [fileName, content] of Object.entries(seed.wiki ?? {})) {
    await fixture.seedWikiPage(fileName, content);
  }
  await fixture.commitSeed();
  return fixture;
}

/** 同进程把 MCP 客户端接到 server 上（不拉子进程）。 */
export async function connectTestClient(corpusDir: string): Promise<TestSession> {
  const server = createServer(corpusDir);
  const client = new Client({ name: "corpus-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
