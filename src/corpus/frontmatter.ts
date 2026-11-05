import { parse as parseYaml } from "yaml";

/**
 * frontmatter 契约（spec #1，一字不差）：
 * - 来源页必填 `type: source` / `source`（raw 相对路径）/ `title` / `created`（ISO 日期）
 * - 主题页必填 `type: topic` / `created`，可选 `title`（缺省取文件名）、`aliases`（别名列表，参与 wikilink 解析）
 */
export const PAGE_TYPE_SOURCE = "source";
export const PAGE_TYPE_TOPIC = "topic";

export const SOURCE_REQUIRED_FIELDS = ["type", "source", "title", "created"] as const;
export const TOPIC_REQUIRED_FIELDS = ["type", "created"] as const;

export const FM_TYPE = "type";
export const FM_SOURCE = "source";
export const FM_TITLE = "title";
export const FM_CREATED = "created";
export const FM_ALIASES = "aliases";

/** `created` 取 ISO 日期（YYYY-MM-DD）。 */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SourcePageMeta {
  type: typeof PAGE_TYPE_SOURCE;
  /** raw 相对路径。 */
  source: string;
  title: string;
  /** ISO 日期（YYYY-MM-DD）。 */
  created: string;
  /** 存在时归一为列表（来源页非 spec 要求，仅透传）。 */
  aliases: string[];
}

export interface TopicPageMeta {
  type: typeof PAGE_TYPE_TOPIC;
  /** 缺省时取文件名（去扩展名），由解析调用方补齐。 */
  title: string | null;
  created: string;
  aliases: string[];
}

export type PageMeta = SourcePageMeta | TopicPageMeta;

/** 校验问题：字段级、可直接进 lint/apply 报告。 */
export interface FrontmatterIssue {
  field: string;
  message: string;
}

export type FrontmatterResult<T> =
  | { ok: true; meta: T; body: string }
  | { ok: false; issues: FrontmatterIssue[] };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface SplitResult {
  raw: Record<string, unknown> | null;
  body: string;
}

/**
 * 拆出 YAML frontmatter 块与正文。
 * frontmatter 必须从首行 `---` 开始（Obsidian 语义）；无 frontmatter 返回 raw: null。
 */
export function splitFrontmatter(text: string): SplitResult {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return { raw: null, body: text };
  }
  let raw: Record<string, unknown> | null = null;
  try {
    const data = parseYaml(match[1] ?? "") as unknown;
    if (data == null) {
      raw = {};
    } else if (typeof data === "object" && !Array.isArray(data)) {
      raw = data as Record<string, unknown>;
    } else {
      return { raw: null, body: text.slice(match[0].length) };
    }
  } catch {
    // YAML 语法错误视为无合法 frontmatter，交给字段校验报告
    return { raw: null, body: text };
  }
  return { raw, body: text.slice(match[0].length) };
}

function checkType(raw: Record<string, unknown> | null, expected: string): FrontmatterIssue[] {
  const type = raw?.[FM_TYPE];
  if (type !== expected) {
    return [
      {
        field: FM_TYPE,
        message: `type 必须为 ${expected}${type === undefined ? "（缺失）" : `（实际：${JSON.stringify(type)}）`}`,
      },
    ];
  }
  return [];
}

function checkCreated(raw: Record<string, unknown> | null): FrontmatterIssue[] {
  const created = raw?.[FM_CREATED];
  if (typeof created !== "string" || !ISO_DATE_RE.test(created)) {
    return [
      {
        field: FM_CREATED,
        message: `created 必须为 ISO 日期（YYYY-MM-DD）${
          created === undefined ? "（缺失）" : `（实际：${JSON.stringify(created)}）`
        }`,
      },
    ];
  }
  return [];
}

function checkStringField(
  raw: Record<string, unknown> | null,
  field: string,
): FrontmatterIssue[] {
  const value = raw?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    return [
      {
        field,
        message: `${field} 必须为非空字符串${value === undefined ? "（缺失）" : ""}`,
      },
    ];
  }
  return [];
}

/** aliases 接受 YAML 列表或单个字符串，统一归一为列表。 */
function normalizeAliases(raw: Record<string, unknown> | null): {
  aliases: string[];
  issues: FrontmatterIssue[];
} {
  const value = raw?.[FM_ALIASES];
  if (value === undefined) {
    return { aliases: [], issues: [] };
  }
  const list = Array.isArray(value) ? value : [value];
  const aliases: string[] = [];
  const issues: FrontmatterIssue[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.trim() !== "") {
      aliases.push(item.trim());
    } else {
      issues.push({ field: FM_ALIASES, message: "aliases 的每一项必须为非空字符串" });
    }
  }
  return { aliases, issues };
}

/** 解析来源页：必填 type/source/title/created 全部就位才 ok。 */
export function parseSourcePage(text: string): FrontmatterResult<SourcePageMeta> {
  const { raw, body } = splitFrontmatter(text);
  const issues: FrontmatterIssue[] = [
    ...checkType(raw, PAGE_TYPE_SOURCE),
    ...checkStringField(raw, FM_SOURCE),
    ...checkStringField(raw, FM_TITLE),
    ...checkCreated(raw),
  ];
  if (raw === null && issues.length === 0) {
    issues.push({ field: "frontmatter", message: "缺少 frontmatter" });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const r = raw as Record<string, unknown>;
  return {
    ok: true,
    meta: {
      type: PAGE_TYPE_SOURCE,
      source: String(r[FM_SOURCE]).replaceAll("\\", "/"),
      title: String(r[FM_TITLE]).trim(),
      created: String(r[FM_CREATED]),
      aliases: normalizeAliases(r).aliases,
    },
    body,
  };
}

/** 解析主题页：必填 type/created；title 可选（缺省取文件名）；aliases 可选。 */
export function parseTopicPage(text: string): FrontmatterResult<TopicPageMeta> {
  const { raw, body } = splitFrontmatter(text);
  const issues: FrontmatterIssue[] = [
    ...checkType(raw, PAGE_TYPE_TOPIC),
    ...checkCreated(raw),
  ];
  if (raw === null && issues.length === 0) {
    issues.push({ field: "frontmatter", message: "缺少 frontmatter" });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const r = raw as Record<string, unknown>;
  const title =
    typeof r[FM_TITLE] === "string" && r[FM_TITLE] !== "" ? (r[FM_TITLE] as string) : null;
  const { aliases, issues: aliasIssues } = normalizeAliases(r);
  if (aliasIssues.length > 0) {
    return { ok: false, issues: aliasIssues };
  }
  return {
    ok: true,
    meta: { type: PAGE_TYPE_TOPIC, title, created: String(r[FM_CREATED]), aliases },
    body,
  };
}

/** 按页面类型分发解析（type 字段决定走向，二者都不是则按来源页报必填缺失）。 */
export function parseWikiPage(text: string): FrontmatterResult<PageMeta> {
  const { raw } = splitFrontmatter(text);
  if (raw?.[FM_TYPE] === PAGE_TYPE_TOPIC) {
    return parseTopicPage(text);
  }
  return parseSourcePage(text);
}

/** 主题页缺省标题：取文件名去扩展名。 */
export function topicTitleFromMeta(meta: TopicPageMeta, fileName: string): string {
  return meta.title ?? fileName.replace(/\.md$/u, "");
}
