import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** 工具共享上下文：corpus 路径经 MCP 配置注入（环境变量 CORPUS_DIR），server 对位置零假设。 */
export interface ToolContext {
  corpusDir: string;
}

/**
 * 工具注册表条目。生产工具面固定六工具
 * （init/status/search/ingest_prepare/apply/lint，spec #1），逐个挂入 TOOLS。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  register(server: McpServer, ctx: ToolContext): void;
}
