# 新建 vault，存量笔记经 ingest 重灌

corpus 是全新 vault，不在既有 Obsidian 库上原地改造（adopt）。老笔记作为 raw 材料逐篇重新 ingest。理由：避免存量结构映射的复杂度（竞品 2 的主要复杂度来源），Karpathy 三层结构可纯净落地；逐篇重灌本身也是一次内容清洗。

## Considered Options

- 原地改造（竞品 2 的 adopt 模式）：要兼容任意既有组织方式，复杂度高
- 旁路双库：维护两个库，违背"长期维护一个 corpus"的初衷
