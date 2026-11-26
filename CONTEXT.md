# obsidian-corpus

参考 Karpathy llm-wiki 思路的个人知识库工具：AI agent 通过 MCP 长期维护一个 markdown 构成、Obsidian 可浏览的 corpus。

## Language

### 结构

**Corpus（语料库）**:
一个知识库的根，包含 Raw 层与 Wiki 层；对外呈现为一个 Obsidian vault。
_Avoid_: vault（仅限 Obsidian 语境）、知识库、库

**Raw sources（原始材料）**:
不可变的源文档，LLM 只读不写。包含新采集的材料与重新灌入的旧笔记。
_Avoid_: 素材、原文

**Wiki**:
Corpus 中由 LLM 维护的互链 markdown 层：内容是对 Raw 材料的归纳与提炼，不引入材料之外的知识。
_Avoid_: 笔记（泛指时）、知识库（与 Corpus 混淆时）

**来源页（Source page）**:
Wiki 中对应一份 Raw 材料的页面：承载该材料的要点、方案与可操作产物，并指回原文。
_Avoid_: 摘要页、材料页

**实体页（Entity page）**:
Wiki 中承载可专名化的具体事物（框架、组件、项目、人、组织、论文）的页面，由 Ingest 惰性创建、持续累积。
_Avoid_: 条目页

**概念页（Concept page）**:
Wiki 中承载抽象主题（现象、方法、模式）的页面，由 Ingest 惰性创建、持续累积。
_Avoid_: 主题页（旧词，已拆分为实体页/概念页）

**Index（索引）**:
Corpus 的内容目录（`index.md`），按 Sources / Entities / Concepts 三节登记全部页面，随 Ingest 更新。
_Avoid_: 目录（文件夹义）、catalog

**Log（日志）**:
只增的时间线（`log.md`），逐条记录对 Corpus 的操作。
_Avoid_: 历史、记录

### 操作

**Ingest（灌入）**:
读取一份原始材料并更新 Wiki 的操作：产出摘要页、更新索引与相关页面、追加日志。
_Avoid_: import、导入

**Query（查询）**:
经索引与 Wiki 页面合成带引用的回答；优质回答可回填为 Wiki 页面。
_Avoid_: 检索（指底层搜索动作）、RAG

**Lint（体检）**:
对 Corpus 的健康检查：矛盾、孤儿页、断链、索引一致性。
_Avoid_: 检查、清理
