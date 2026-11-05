import { afterEach, describe, expect, it } from "vitest";
import { connectTestClient, createCorpusFixture, type CorpusFixture, type TestSession } from "./harness.js";

/**
 * 冒烟（spec #1 验收：经 MCP 接缝连接 server、列工具）。
 * 本票工具面仅 ping 占位；后续工具票在此接缝上扩展。
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
  it("客户端连接 server 并列出工具", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const tools = await session.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("ping");
    expect(tools.tools.every((tool) => tool.description.length > 0)).toBe(true);
  });

  it("调用 ping 工具得到 pong", async () => {
    fixture = await createCorpusFixture();
    session = await connectTestClient(fixture.root);

    const result = await session.client.callTool({ name: "ping", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
  });
});
