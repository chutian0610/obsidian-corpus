#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/** corpus 路径经 MCP 配置注入（环境变量 CORPUS_DIR），server 对位置零假设。 */
const corpusDir = process.env.CORPUS_DIR;
if (!corpusDir) {
  console.error("obsidian-corpus：缺少环境变量 CORPUS_DIR（corpus 根目录），无法启动");
  process.exit(1);
}

const server = createServer(corpusDir);
await server.connect(new StdioServerTransport());
