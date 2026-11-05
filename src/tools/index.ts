import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolDefinition } from "./registry.js";
import { pingTool } from "./ping.js";

/** 工具注册表：MCP 工具面唯一入口，逐票扩展。 */
export const TOOLS: ToolDefinition[] = [pingTool];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of TOOLS) {
    tool.register(server, ctx);
  }
}
