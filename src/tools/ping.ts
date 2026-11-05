import type { ToolDefinition } from "./registry.js";

/** 连通性探针：验证 MCP 接缝贯通（客户端 → server → 工具注册表）。 */
export const pingTool: ToolDefinition = {
  name: "ping",
  description: "连通性探针：返回 pong。用于确认 obsidian-corpus server 已挂载并可响应工具调用。",
  register(server) {
    server.registerTool(
      this.name,
      {
        description: this.description,
        inputSchema: {},
      },
      async () => ({
        content: [{ type: "text", text: "pong" }],
      }),
    );
  },
};
