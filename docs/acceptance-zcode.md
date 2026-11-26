# obsidian-corpus 真机验收手册（ZCode）

MVP 合并后的第一轮真机验证：在一个**专用的私有测试 corpus 目录**上跑通全部六工具与安全边界。验收通过后，才把配置指向正式 corpus 开始长期使用。

> 全文中的 `<占位符>` 请替换为本机实际绝对路径。测试目录请勿复用已有 Obsidian vault。

## 0. 前置条件

- Node ≥ 20（`node -v` 确认）
- 仓库 main 已检出，依赖与构建完成：

```bash
npm install
npm run build   # 产物 dist/index.js
```

- 一个全新的空目录作为测试 corpus（例如 `~/corpora/acceptance-test`），**不要** git init（init 工具会做）
- （可选）Obsidian，用于 UC10

## 1. 配置 ZCode MCP

编辑 `~/.zcode/cli/config.json`，在 `mcp.servers` 下加入（若文件已有其他内容，只合并这一段）：

```json
{
  "mcp": {
    "servers": {
      "obsidian-corpus": {
        "type": "stdio",
        "command": "node",
        "args": ["<仓库绝对路径>/dist/index.js"],
        "env": {
          "CORPUS_DIR": "<测试corpus绝对路径>"
        }
      }
    }
  }
}
```

要点（ZCode 的 MCP schema 是严格的，违反会导致 server 被静默丢弃）：

- 用户级配置的键形是嵌套的 `mcp.servers`；顶层 `mcpServers` 只是 `.agents/mcp.json` 兼容层的形状，别混用
- `command` 是字符串，可执行文件与其参数分开写进 `args`；路径必须是绝对路径（配置文件不展开 `${...}` 模板）
- 未知键会被整体丢弃；字段名用 `env`（不是 `environment`）

改完后**重启会话**，打开 **Settings → MCP**：`obsidian-corpus` 应显示 connected，且六个工具可见（init / status / search / ingest_prepare / apply / lint）。

排障速查：`failed (spawn node ENOENT)` → command/args 路径问题；`Connection closed` 或缺 `CORPUS_DIR` 报错 → 在终端手动跑 `CORPUS_DIR=<目录> node <仓库>/dist/index.js` 看错误输出（server 启动后静默等待 stdin 属正常，Ctrl+C 退出）；列表里根本没有 → JSON 语法或键形错误。

## 2. 验收用例

以下均为对 ZCode 里的 agent 说自然语言，工具由 agent 调用。每个用例给出预期与判定标准；涉及文件与 git 的，在 corpus 目录用命令行核对。

### UC1 init：冷启动初始化

> 说：「调用 init 初始化这个 corpus」

判定（全部满足才通过）：

- corpus 根出现 `AGENTS.md`（**正式约定文本**：三层结构、来源页/实体页/概念页 frontmatter、Ingest/Query/Lint 工作流、git 纪律——不是一句话占位）、`index.md`、`log.md`、`raw/`、`wiki/`、`.trash/`
- `log.md` 含一行 `## [...] init | corpus`
- `git log` 恰好一条：`init: corpus`
- **再跑一次 init**：返回的 created 为空、`git log` 无新 commit（幂等）
- `AGENTS.md` 首行为版本标记 `<!-- corpus-agents: vN -->`

### UC2 status：概览

> 说：「看下 corpus 状态」

判定：`gitClean: true`、`sourcePages: 0`、`entityPages: 0`、`conceptPages: 0`、`legacyTopicPages: 0`、`recentLog` 里有 init 条目（字段为 camelCase）。

### UC3 ingest 全流程（核心用例）

先放一份测试材料（自选一篇**带小标题**的中文 markdown 笔记，内容最好含 1-2 个可提炼的主题，最好有具体数字或配置），保存为 corpus 的 `raw/<文件名>.md`——**无需先 git 提交**：未跟踪的新材料视为待灌材料（`status` 的 `pendingRaw`），`apply` 会把它随本次 ingest 一并带入同一个 commit（ADR-0005）。

> 说：「把 raw/<文件名>.md ingest 进 wiki」

agent 应走 `ingest_prepare` → 起草变更集 → 覆盖核对 → `apply`。判定：

- `ingest_prepare` 的返回体含 `outline`：材料的标题清单，每条带层级与行号区间，与原文标题一一对应（代码块里的 `#` 行不算）
- `wiki/` 出现**来源页**：frontmatter `type: source`、`source: raw/<文件名>.md`、`title`、`created`（ISO 日期）
- 来源页落实**最小信息集**（材料里有的才算）：环境与前提、量化参数、识别与排查、方案全貌（含被否决的方案及原因）、可操作产物（配置/关键代码用代码围栏原样保留），且要点带原文小节号或图号
- 出现至少一个**实体页**或**概念页**：`type: entity` 或 `type: concept`、`created`，title 等于文件名，与来源页以 `[[中文标题]]` 互链（具体事物归 entity，抽象主题归 concept）
- `index.md` 的 `## Sources` 与 `## Entities` / `## Concepts` 节多了对应行
- `log.md` 追加一行 `## [...] ingest | <标题>`
- `git log` 恰好多**一条** commit（消息 `ingest: <标题>`）
- 说「看下状态」：`gitClean: true`（agent 操作后树恢复干净）

**覆盖度核对（本用例的重点）**：拿 `outline` 的标题清单逐节对照 wiki——每一节的知识点是否都写进了来源页或某个实体页/概念页？原文里的具体数字（版本号、阈值、默认值）是否保留？「怎么判断自己中招」的排查线索是否在？被否决的方案及原因是否在？有遗漏即不通过。

**反向核对（同样一票否决）**：逐句看 wiki 页面，有没有 Raw 材料里找不到依据的内容——agent 自己补充的背景知识、材料没讲的定义或分类框架？有即不通过，哪怕内容是对的。

### UC4 search

> 说：「在 corpus 里搜 <笔记中的某个词>」；再各来一次「只搜 wiki」「只搜 raw」

判定：命中含路径与行号摘录，另有 `filesWithHits`（每文件命中数，不受摘录上限影响）；`scope=wiki` 不返回 raw/ 的命中、`scope=raw` 反之（不渗漏）。

### UC5 query 场景

> 说：「<基于笔记内容的一个问题>」

判定：agent 的回答引用了 wiki 页面（答案来自编译后的 wiki 而非泛泛而谈）。

### UC6 lint：干净库零报告

> 说：「跑一次 lint」

判定：`findings` 为空（UC3 正常产出后应为零）。

### UC7 lint：捕获人为破坏

手动制造两个问题（每次改动后 `git add -A && git commit`）：

1. 在某概念页正文加 `[[不存在的页面]]` 并提交 → lint 应报 `broken-wikilink`
2. 删掉 `index.md` 中某一行并提交 → lint 应报 `index-mismatch`

判定：两条规则各自命中且路径正确；修复后复跑 lint 归零。

### UC8 手改保护（ADR-0004 安全边界）

1. 手动编辑任一 wiki 页（不提交）
2. 放第二份材料进 `raw/`，对 agent 说「ingest 这份」
3. **判定**：`ingest_prepare` 即被拒并列出你的脏文件（#17 后前置拦截，不再等 apply）；`git status` 确认 agent 没有写任何东西
4. `git add -A && git commit` 你的手改，再让 agent 重试 → 成功

### UC9 删除走 .trash/

> 说：「删除概念页 <某页>」

判定：文件出现在 `.trash/`（非物理消失）、`index.md` 对应行消失、`log.md` 追加、恰好一条新 commit；该页若有入链，apply 会要求同批更新引用页（或拒绝制造断链）。

### UC10 Obsidian 检查

Obsidian「打开文件夹作为仓库」指向测试 corpus：graph view 可见来源页与实体页/概念页互链、`[[链接]]` 可点击跳转、中文文件名正常显示。打开过 Obsidian 之后再跑 `status`：`gitClean` 应仍为 `true`——`.obsidian/`、`.zcode/` 等工具目录由 init 生成的 `.gitignore` 排除（若你的 corpus 在此功能之前初始化，重跑一次 `init` 即幂等补上）。

### UC11 并发与提交边界（可选）

1. **写锁串行**：开第二个 ZCode 会话（指向同一 corpus 的 MCP 配置），两边各放一份不同材料并同时说「ingest」。判定：一个成功；另一个报 `lock_busy`（等待约 15 秒超时），稍后重试即成功，corpus 全程无交叉污染。
2. **提交边界**：任取一次 ingest 的 commit（`git log` 拿 sha 后 `git show --name-only <sha>`）。判定：文件集合**恰好**等于该次操作产物（来源页/实体页/概念页、可能存在的 `.trash/` 移动、`index.md`、`log.md`），不包含任何你的手改文件——agent 永远只提交自己的操作结果。

### UC12 约定文本升级（可选）

1. **未改过 → 自动升级**：用一个旧版工具初始化过、且从未手改 `AGENTS.md` 的 corpus（或知识库本身），更新工具后重跑 init。判定：返回 `upgraded: ["AGENTS.md"]`、`AGENTS.md` 首行版本标记变为当前版、恰好多一条 `init: corpus` commit。
2. **改过 → 不覆盖**：手动在 `AGENTS.md` 末尾加一句自己的备注并提交，重跑 init。判定：返回 `customized: ["AGENTS.md"]`、文件原样（你的备注还在）、无 commit。

## 3. 通过标准

| 用例 | 关键判定 |
| --- | --- |
| UC1 | 骨架齐全 + 正式 AGENTS.md + 幂等 |
| UC2 | 概览与 camelCase 字段 |
| UC3 | 来源页（含最小信息集）+实体页/概念页+互链+索引联动+日志+单 commit+树干净 |
| UC4/UC5 | 搜索不渗漏；回答出自 wiki |
| UC6/UC7 | 零误报；人为破坏可捕获 |
| UC8 | 脏树拦截 agent，人类提交后恢复 |
| UC9 | `.trash/` 中转 + 索引/日志联动 |
| UC10 | Obsidian 原生体验完整 |
| UC12 | 约定文本：未改过自动升级、改过不覆盖 |

全部通过后：将 `CORPUS_DIR` 改指正式私有 corpus 目录（**绝不推公开 remote**），init 一次，老 vault 笔记逐篇放入 `raw/` 开始长期维护。
