import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolDefinition } from "./registry.js";
import { initTool } from "./init.js";
import { statusTool } from "./status.js";
import { searchTool } from "./search.js";
import { ingestPrepareTool } from "./ingestPrepare.js";
import { applyTool } from "./apply.js";
import { lintTool } from "./lint.js";

/** 工具注册表：MCP 工具面唯一入口（六工具，spec #1）。 */
export const TOOLS: ToolDefinition[] = [
  initTool,
  statusTool,
  searchTool,
  ingestPrepareTool,
  applyTool,
  lintTool,
];

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const tool of TOOLS) {
    tool.register(server, ctx);
  }
}
