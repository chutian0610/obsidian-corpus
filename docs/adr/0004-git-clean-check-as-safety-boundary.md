# 以 git 干净检查作为人类编辑的安全边界

允许人类直接手改 wiki 页，不加 hand-edited 标记或文件锁（竞品 2 的做法）。安全机制是 git 纪律：人类改完必须自行 commit；agent 每次操作前检查 corpus 工作树是否干净，不干净即停。agent 自己的操作结果按操作原子提交（一次 ingest/lint = 一个 commit），既让树恢复干净，也提供了按操作 revert 的粒度。server 不代人类提交其改动。

## Considered Options

- frontmatter 手改标记：保护粒度更细，但标记本身是维护负担且容易漏标；git 已是事实上的变更边界
