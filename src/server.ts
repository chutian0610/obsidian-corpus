import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "obsidian-corpus";
export const SERVER_VERSION = "0.1.0";

/**
 * 组装 MCP server（transport 无关：stdio 入口与测试的 InMemoryTransport 共用此工厂）。
 * 分工遵循 ADR-0001：server 只做机械一致性，内容判断交给 agent。
 */
export function createServer(corpusDir: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "本 server 长期维护一个 markdown 构成、Obsidian 可浏览的本地私有 corpus。" +
        "分工：agent 做内容判断，server 做记账（索引联动、日志追加、链接校验、git 提交）。" +
        "约定见 corpus 根的 AGENTS.md。",
    },
  );
  registerTools(server, { corpusDir });
  return server;
}
