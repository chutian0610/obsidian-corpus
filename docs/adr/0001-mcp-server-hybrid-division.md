# MCP server 形态与混合分工

产品要在不同 AI agent 中通用，决定以 MCP server 交付（协议级通用；参考竞品均为 skill/CLI 形态，MCP 是空着的生态位），并采用混合分工：server 只负责机械一致性（索引、日志、链接校验、原子写、模板），内容判断（摘要质量、主题页组织、链接决策）交给 agent。Karpathy 的"LLM 做所有记账"在此精确为"LLM 做判断，server 做记账"。

## Considered Options

- 纯 skill 包：跨 agent 靠格式移植，但批量写操作全靠 prompt 约束，长期跑在个人笔记上确定性不足
- 厚 server（ingest 编排全部进代码）：把摘要与组织这类 LLM 强项写死进代码，质量受限
