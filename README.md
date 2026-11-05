# obsidian-corpus

参考 Karpathy llm-wiki 思路的个人知识库工具：AI agent 通过 MCP 长期维护一个 markdown 构成、Obsidian 可浏览的 corpus。

规范见 GitHub issue #1（spec）、`CONTEXT.md`（领域词汇表）与 `docs/adr/`。

## 开发

```bash
npm install
npm run build   # tsc → dist/
npm test        # vitest（经 MCP 接缝的测试）
```

## 运行（MCP server，stdio）

corpus 路径经环境变量注入，server 对位置零假设：

```bash
CORPUS_DIR=/path/to/corpus node dist/index.js
```

## 测试范式

单一接缝：MCP 工具边界。测试经 SDK 内存传输（`InMemoryTransport`）同进程直连 server，
打到临时 corpus 夹具（mkdtemp + `git init` + 按需播种 raw/wiki）上，只断言外部行为
（工具返回值、corpus 落盘结果、git log）。内部模块不设独立测面，全部透过接缝覆盖。
