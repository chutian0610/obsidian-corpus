# obsidian-corpus

参考 Karpathy llm-wiki 思路的个人知识库工具：AI agent 通过 MCP 长期维护一个 markdown 构成、git 版本化、Obsidian 可直接浏览的本地私有 corpus。分工遵循混合模型——agent 做内容判断（摘要、实体页/概念页组织、链接决策），server 做机械一致性（索引联动、日志追加、链接校验、原子写、git 提交）。

规范见 GitHub issue #1（spec）、`CONTEXT.md`（领域词汇表）与 `docs/adr/`。

## 快速开始

```bash
git clone <repo> && cd obsidian-corpus
npm install
npm run build   # tsc → dist/
```

corpus 路径经环境变量 `CORPUS_DIR` 注入，server 对位置零假设：

```bash
CORPUS_DIR=/path/to/your/corpus node dist/index.js
```

### ZCode MCP 配置示例

在用户级配置 `~/.zcode/cli/config.json` 的 `mcp.servers` 下加入（占位路径换成绝对路径；ZCode 的 MCP schema 严格，未知键会导致 server 被丢弃）：

```json
{
  "mcp": {
    "servers": {
      "obsidian-corpus": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/obsidian-corpus/dist/index.js"],
        "env": {
          "CORPUS_DIR": "/path/to/your/corpus"
        }
      }
    }
  }
}
```

（兼容层 `.agents/mcp.json` 用顶层 `mcpServers` 键形，其余字段相同。）

配置后即可在任何支持 MCP 的 agent 中使用；corpus 根的 `AGENTS.md` 记录全部维护约定（页面类型、格式、Ingest/Query/Lint 工作流、git 纪律），跟着库走。约定文本带版本标记：未被库主人修改过的旧版，重跑 `init` 时自动升级；改过的绝不覆盖。

### 并发语义

同一 corpus 配置多个 server 实例（多个会话/多个 agent）是安全的：写操作（`init`/`apply`）经系统临时目录中的 PID 锁文件互斥——写事务串行，读工具（`status`/`search`/`ingest_prepare`/`lint`）始终可用。持锁进程崩溃后，下一次写操作会自动接管残留锁。等待持锁释放的上限默认 15 秒，可用环境变量 `CORPUS_LOCK_TIMEOUT_MS`（毫秒）覆盖。agent 的 commit 只暂存本操作的产物（计划页面、`.trash/` 移动目标、`index.md`、`log.md`），人类的未提交改动永远不会被卷入。

## 工具一览

| 工具 | 读写 | 说明 |
| --- | --- | --- |
| `init` | 写 | 幂等初始化：缺什么补什么（骨架文件 + 目录 + `git init`），并把未被改过的旧版约定文本升级到当前版；已完整则无操作。有变更时记 log、记 commit。 |
| `status` | 只读 | git 干净状态与库概览：`gitClean`、脏文件清单、待灌材料清单、来源页/实体页/概念页计数（`legacyTopicPages` 为待迁移的存量 topic 页数）、最近日志。 |
| `search` | 只读 | 全文 + 索引查询（`query` + 可选 `scope`：all/wiki/raw），返回路径 + 行号 + 摘录，另有文件级命中聚合 `filesWithHits`（每文件命中数，不受摘录上限影响）。 |
| `ingest_prepare` | 只读 | 取一份 raw 材料（仅 `.md`/`.txt`）的内容（大材料按行窗口分段读）、原文大纲（`outline`：标题与行号区间，起草后据此逐节核对覆盖度）、stat、相关既有页面清单与 git 边界；脏树、非 git 库、二进制材料直接拒。 |
| `apply` | 写 | 唯一写入口：整批页面变更经校验（含 title 必须等于文件名、名字不得互撞）后与 index 联动、log 追加一起进单个 commit（`op` 取 `ingest` 或 `refactor`）；任一失败整批拒绝。 |
| `lint` | 只读 | 六规则体检：断链、孤儿页、索引不一致、frontmatter 完整性、重名、存量 topic 页，返回结构化 findings，只报告不修改。 |

## 开发

```bash
npm install
npm run build   # tsc → dist/
npm test        # vitest（经 MCP 接缝的测试）
```

## 测试范式

单一接缝：MCP 工具边界。测试经 SDK 内存传输（`InMemoryTransport`）同进程直连 server，
打到临时 corpus 夹具（mkdtemp + `git init` + 按需播种 raw/wiki）上，只断言外部行为
（工具返回值、corpus 落盘结果、git log）。内部模块不设独立测面，全部透过接缝覆盖。
