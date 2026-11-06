# 未跟踪的 raw 新材料不算脏树，apply 携带原料入库

真机验收发现：「放材料进 raw/ → 触发 ingest」是核心入口，但未跟踪的新材料让 git 干净检查直接拒绝 apply（dirty_tree），脏树检查分不清「待灌材料」和「未保存的人类手改」，逼库主人每次手动 git 提交。决定细化 ADR-0004 的边界：**未跟踪的 `raw/` 文件归类为待灌材料（pendingRaw），不算脏、不阻塞写操作**；`apply` 把本批来源页 `source` 引用的待灌原料带进同一个 commit（一次 ingest = 原料 + 知识编译原子入库）；`status` 透出 `pendingRaw` 清单。已跟踪 Raw 文件被改动仍是阻塞项（Raw 层不可变）；未跟踪的 wiki 文件仍算脏（人类手改保护不放松）。
