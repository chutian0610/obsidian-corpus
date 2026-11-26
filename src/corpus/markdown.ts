import { unified } from "unified";
import remarkParse from "remark-parse";

/**
 * 共享的 markdown 解析器（remark-parse 纯函数、无状态）：wikilink 提取与原文大纲共用。
 * 只解析结构、不序列化——两处都只读 AST。
 */
export const markdownParser = unified().use(remarkParse);
