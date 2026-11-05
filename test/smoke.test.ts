import { afterEach, describe, expect, it } from "vitest";
import { connectTestClient, createCorpusFixture, type CorpusFixture, type TestSession } from "./harness.js";

/**
 * 冒烟（spec #1 验收：经 MCP 接缝连接 server、列工具）。
 * 工具面为六工具（init/status/search/ingest_prepare/apply/lint），不再有连通性占位工具。
 */

let fixture: CorpusFixture | null = null;
let session: TestSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
  await fixture?.dispose();
  fixture = null;
});

describe("MCP 接缝冒烟", () => {
  it("客户端连接 server 并列出六工具", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const tools = await session.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["apply", "ingest_prepare", "init", "lint", "search", "status"]);
    expect(tools.tools.every((tool) => tool.description.length > 0)).toBe(true);
  });

  it("调用 status 工具返回 JSON 概览", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const result = await session.client.callTool({ name: "status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    const payload = JSON.parse(text) as { gitRepo: boolean; gitClean: boolean };
    expect(payload.gitRepo).toBe(true);
    expect(payload.gitClean).toBe(true);
  });
});
