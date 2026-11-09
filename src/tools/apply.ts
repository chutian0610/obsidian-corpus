import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  INDEX_FILE,
  LOG_FILE,
  TRASH_DIR,
  WIKI_DIR,
  isRawPath,
  resolveInCorpus,
  toCorpusRel,
} from "../corpus/paths.js";
import { PAGE_TYPE_SOURCE, parseWikiPage, topicTitleFromMeta, type PageMeta } from "../corpus/frontmatter.js";
import { buildNameIndex, extractWikilinks, resolveWikilinkTarget } from "../corpus/wikilink.js";
import {
  appendIndexEntries,
  readIndex,
  removeIndexEntries,
  writeIndex,
} from "../corpus/indexFile.js";
import { appendLog } from "../corpus/logFile.js";
import { collectWikiPages, type WikiPage } from "../corpus/pages.js";
import { pathExists, readOptionalFile } from "../corpus/fs.js";
import { gitAdd, gitCommit, gitStatus } from "../corpus/git.js";
import { LockBusyError, withWriteLock } from "../corpus/lockfile.js";
import type { ToolDefinition } from "./registry.js";

/**
 * apply：唯一写入口（spec #1、#5）。
 * 整批提交 wiki/ 页面变更（整页内容；content:null = 删除→移入 .trash/），
 * 校验（frontmatter 必填、wikilink 目标存在或本批新建、路径约束、不碰 raw/、文件名合法字符）
 * 全部通过后才落盘，变更 + index.md 联动 + log.md 追加进单个 commit（`<op>: <标题>`，op 取
 * ingest 或 refactor——refactor 用于不涉及新材料的纯 wiki 重组，#24）。
 * `![[嵌入]]` 不要求目标是 wiki 页面；代码块/行内代码里的 `[[ ]]` 不算链接（#21）。
 * all-or-nothing：任一步失败整批拒绝，corpus 零变更、零残留。
 */

const inputSchema = {
  changes: z
    .array(
      z.object({
        /** corpus 内相对路径，限 wiki/ 下平铺 .md。 */
        path: z.string(),
        /** 整页新内容；null 表示删除（移入 .trash/）。 */
        content: z.string().nullable(),
      }),
    )
    .min(1),
  log: z.object({
    /** 日志操作类型：ingest（灌入新材料）或 refactor（纯 wiki 重组，#24）；缺省 ingest。 */
    op: z.string().optional(),
    /** 日志对象（也是 commit 消息标题）。 */
    title: z.string().optional(),
    /** 可选说明行。 */
    note: z.string().optional(),
  }),
};

/** apply 允许的操作类型（#24）：ingest=知识灌入；refactor=不涉及新材料的 wiki 重组（拆并页/改写/修正）。 */
const APPLY_OPS = new Set(["ingest", "refactor"]);

type ApplyArgs = {
  changes: Array<{ path: string; content: string | null }>;
  log: { op?: string; title?: string; note?: string };
};

/** 校验问题：code 可直接被 agent/测试分类消费。 */
interface Issue {
  code:
    | "invalid_log"
    | "invalid_path"
    | "duplicate_path"
    | "delete_missing"
    | "frontmatter"
    | "broken_wikilink"
    | "duplicate_name"
    | "title_filename_mismatch";
  message: string;
  path?: string;
  target?: string;
  field?: string;
}

interface PlannedChange {
  /** corpus 内相对路径（wiki/xxx.md，POSIX 风格）。 */
  rel: string;
  action: "created" | "updated" | "deleted";
  content: string | null;
  /** 写入页的 frontmatter 解析结果（删除页为 null）。 */
  meta: PageMeta | null;
  /** 写入页解析出的正文（wikilink 校验用；删除页为空串）。 */
  body: string;
  /** 应用后标题（写入页为新标题，删除页为旧标题）。 */
  title: string;
  /** 删除页落盘后的 .trash/ 内相对路径。 */
  trashRel: string | null;
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function fail(code: string, message: string, details?: Record<string, unknown>) {
  return textResult({ ok: false, code, message, ...(details ?? {}) }, true);
}

/** 路径约束：corpus 内、wiki/ 下、平铺 .md、不碰 raw/。 */
function normalizeWikiPath(corpusRoot: string, rawPath: string): { rel: string } | { error: string } {
  let abs: string;
  try {
    abs = resolveInCorpus(corpusRoot, rawPath);
  } catch {
    return { error: `路径越出 corpus 根：${rawPath}` };
  }
  const rel = toCorpusRel(corpusRoot, abs);
  if (isRawPath(rel)) {
    return { error: `raw/ 是不可变的源材料层，禁止写入：${rel}` };
  }
  const prefix = `${WIKI_DIR}/`;
  if (!rel.startsWith(prefix)) {
    return { error: `只接受 ${prefix} 内的页面路径：${rawPath}` };
  }
  if (!rel.endsWith(".md")) {
    return { error: `只接受 .md 页面：${rel}` };
  }
  if (rel.slice(prefix.length).includes("/")) {
    return { error: `wiki/ 为平铺布局，不接受子目录路径：${rel}` };
  }
  // Windows 非法文件名字符：corpus 可能被拷贝到任何机器，提前拒（#21）
  if (/[:*?"<>|]/u.test(rel.slice(prefix.length))) {
    return { error: `wiki 页文件名不得包含 Windows 非法字符 : * ? " < > |：${rel}` };
  }
  return { rel };
}

/** .trash/ 目标名：保留原文件名，同名冲突时追加序号（.1、.2 …）。 */
async function planTrashTarget(trashAbs: string, fileName: string): Promise<string> {
  const base = fileName.replace(/\.md$/u, "");
  let candidate = path.join(trashAbs, fileName);
  let n = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(trashAbs, `${base}.${n}.md`);
    n += 1;
  }
  return candidate;
}

async function handleApply(corpusRoot: string, args: ApplyArgs) {
  // ① git 干净检查（ADR-0004：脏即整批拒绝，绝不代人类提交）
  const status = await gitStatus(corpusRoot);
  if (!status.clean) {
    return fail("dirty_tree", "corpus 工作树不干净，整批拒绝；请先提交你的手改再调用 apply。", {
      dirtyFiles: status.dirtyFiles,
    });
  }

  const issues: Issue[] = [];

  // ② 日志条目校验（op 词表见 APPLY_OPS；title 兼作 log 对象与 commit 标题）
  const opRaw = args.log.op ?? "ingest";
  const title = (args.log.title ?? "").trim();
  if (!APPLY_OPS.has(opRaw)) {
    issues.push({
      code: "invalid_log",
      message: `apply 的日志 op 只能为 ingest 或 refactor（实际：${opRaw}）`,
    });
  }
  if (title === "") {
    issues.push({ code: "invalid_log", message: "log.title 不能为空" });
  }
  if (title.includes("|") || title.includes("\n")) {
    issues.push({ code: "invalid_log", message: "log.title 不能包含 | 或换行（破坏 log 行格式与 commit 消息）" });
  }

  const existingPages = await collectWikiPages(corpusRoot);
  const existingByPath = new Map(existingPages.map((p) => [p.pagePath, p]));

  // ② 路径约束 + 重复 + 删除存在性 + frontmatter 必填
  const planned: PlannedChange[] = [];
  const seenPaths = new Set<string>();
  for (const change of args.changes) {
    const norm = normalizeWikiPath(corpusRoot, change.path);
    if ("error" in norm) {
      issues.push({ code: "invalid_path", message: norm.error });
      continue;
    }
    const rel = norm.rel;
    if (seenPaths.has(rel)) {
      issues.push({ code: "duplicate_path", path: rel, message: `变更集内路径重复：${rel}` });
      continue;
    }
    seenPaths.add(rel);

    const existing = existingByPath.get(rel);
    if (change.content === null) {
      if (!existing) {
        issues.push({ code: "delete_missing", path: rel, message: `删除目标不存在：${rel}` });
        continue;
      }
      planned.push({
        rel,
        action: "deleted",
        content: null,
        meta: null,
        body: "",
        title: existing.title,
        trashRel: null,
      });
      continue;
    }

    const parsed = parseWikiPage(change.content);
    if (!parsed.ok) {
      for (const i of parsed.issues) {
        issues.push({ code: "frontmatter", path: rel, field: i.field, message: i.message });
      }
      continue;
    }
    const fileName = path.basename(rel, ".md");
    const pageTitle =
      parsed.meta.type === "source" ? parsed.meta.title : topicTitleFromMeta(parsed.meta, fileName);
    planned.push({
      rel,
      action: existing ? "updated" : "created",
      content: change.content,
      meta: parsed.meta,
      body: parsed.body,
      title: pageTitle,
      trashRel: null,
    });
  }

  // ③ wikilink 目标校验：目标是「应用后仍存在的页面」的标题或别名
  const postPages = new Map<string, Pick<WikiPage, "pagePath" | "names">>(
    existingPages.map((page) => [page.pagePath, { pagePath: page.pagePath, names: page.names }]),
  );
  for (const c of planned) {
    if (c.action === "deleted") {
      postPages.delete(c.rel);
    }
  }
  for (const c of planned) {
    if (c.action !== "deleted" && c.meta) {
      postPages.set(c.rel, { pagePath: c.rel, names: [c.title, ...c.meta.aliases] });
    }
  }
  const postNameIndex = buildNameIndex([...postPages.values()]);

  for (const c of planned) {
    if (c.action === "deleted" || !c.meta) {
      continue;
    }
    for (const link of extractWikilinks(c.body)) {
      // 嵌入（![[...]]）目标是附件或页面：附件不是 wiki 页面，不要求存在（#21）
      if (link.embed) {
        continue;
      }
      if (resolveWikilinkTarget(postNameIndex, link.target) === null) {
        issues.push({
          code: "broken_wikilink",
          path: c.rel,
          target: link.target,
          message: `wikilink 目标不存在且不在本批新建内：[[${link.target}]]（页面 ${c.rel}）`,
        });
      }
    }
  }

  // ③ 删除的入链检查：未随批更新的现存页面若链接被删页，删除会造成断链
  //（正文复用 collectWikiPages 已剥好的 page.body，与 lint 的断链检查同形）
  const deletedRels = new Set(planned.filter((c) => c.action === "deleted").map((c) => c.rel));
  if (deletedRels.size > 0) {
    const preNameIndex = buildNameIndex(existingPages);
    for (const page of existingPages) {
      if (deletedRels.has(page.pagePath) || seenPaths.has(page.pagePath)) {
        continue;
      }
      for (const link of extractWikilinks(page.body)) {
        const targetPath = resolveWikilinkTarget(preNameIndex, link.target);
        if (targetPath !== null && deletedRels.has(targetPath)) {
          issues.push({
            code: "broken_wikilink",
            path: page.pagePath,
            target: link.target,
            message: `删除 ${targetPath} 会在 ${page.pagePath} 留下断链 [[${link.target}]]；请在同一变更集内更新引用页`,
          });
        }
      }
    }
  }

  // ③ title=文件名（#22）：server 按 title+别名解析 wikilink、Obsidian 按文件名解析，
  // 两者必须同名互证；title 之外的其他叫法一律放 aliases
  const plannedRels = new Set(planned.filter((c) => c.action !== "deleted").map((c) => c.rel));
  for (const c of planned) {
    if (c.action === "deleted" || !c.meta) {
      continue;
    }
    const fileName = path.basename(c.rel, ".md");
    if (c.title !== fileName) {
      issues.push({
        code: "title_filename_mismatch",
        path: c.rel,
        field: "title",
        message: `title 必须等于文件名（去 .md）：title「${c.title}」≠ 文件名「${fileName}」（页面 ${c.rel}）；其他名字放 aliases`,
      });
    }
  }

  // ③ 名字唯一性（#22）：应用后"名字→页面"必须一对一，否则 wikilink 解析静默取第一个命中（不确定性）。
  // 只拒"本批引入/维持"的冲突；纯存量互撞（本批未触碰）不阻塞，由 lint 的 duplicate-name 兜底
  const namesToPages = new Map<string, Map<string, string>>(); // 小写名 → (pagePath → 原名)
  for (const page of postPages.values()) {
    for (const name of page.names) {
      if (name.trim() === "") {
        continue;
      }
      const key = name.toLowerCase();
      let byPage = namesToPages.get(key);
      if (!byPage) {
        byPage = new Map();
        namesToPages.set(key, byPage);
      }
      byPage.set(page.pagePath, name);
    }
  }
  for (const [key, byPage] of namesToPages) {
    if (byPage.size < 2) {
      continue;
    }
    const paths = [...byPage.keys()];
    const involved = paths.filter((p) => plannedRels.has(p));
    if (involved.length === 0) {
      continue;
    }
    const displayName = byPage.values().next().value ?? key;
    issues.push({
      code: "duplicate_name",
      path: involved[0]!,
      target: displayName,
      message:
        `名字「${displayName}」同时指向多个页面（${paths.join("、")}）；` +
        `同名不同概念请用消歧义后缀，如「${displayName}（限定词）」`,
    });
  }

  if (issues.length > 0) {
    // 校验失败时尚未落盘任何内容，天然零残留
    return fail("validation_failed", "变更集校验失败，整批拒绝。", { issues });
  }

  // 校验已拒非法 op，这里收窄为 LogOp 词表成员
  const op = opRaw === "refactor" ? "refactor" : "ingest";

  // ④ index 联动：按变更前的页面元数据移除旧行，再追加新行（联动逻辑见 indexFile.ts）
  const indexData = await readIndex(corpusRoot);
  for (const c of planned) {
    const old = existingByPath.get(c.rel);
    if (old) {
      removeIndexEntries(indexData, old);
    }
    if (c.action !== "deleted" && c.meta) {
      appendIndexEntries(indexData, { title: c.title, meta: c.meta });
    }
  }

  // ⑤ 落盘事务：全部变更 + index + log 进单个 commit；任一步失败逆序回滚
  const undos: Array<() => Promise<void>> = [];
  const rootAbs = path.resolve(corpusRoot);
  try {
    for (const c of planned) {
      if (c.action === "deleted") {
        continue;
      }
      const abs = resolveInCorpus(corpusRoot, c.rel);
      const oldText = await readOptionalFile(abs);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, c.content as string, "utf8");
      undos.push(
        oldText === null
          ? () => rm(abs, { force: true })
          : () => writeFile(abs, oldText, "utf8"),
      );
    }
    for (const c of planned) {
      if (c.action !== "deleted") {
        continue;
      }
      const fromAbs = resolveInCorpus(corpusRoot, c.rel);
      const trashAbs = path.join(rootAbs, TRASH_DIR);
      const toAbs = await planTrashTarget(trashAbs, path.basename(c.rel));
      await mkdir(trashAbs, { recursive: true });
      await rename(fromAbs, toAbs);
      c.trashRel = toCorpusRel(corpusRoot, toAbs);
      undos.push(() => rename(toAbs, fromAbs));
    }

    const indexAbs = resolveInCorpus(corpusRoot, INDEX_FILE);
    const oldIndex = await readOptionalFile(indexAbs);
    await writeIndex(corpusRoot, indexData);
    undos.push(
      oldIndex === null
        ? () => rm(indexAbs, { force: true })
        : () => writeFile(indexAbs, oldIndex, "utf8"),
    );

    const logAbs = resolveInCorpus(corpusRoot, LOG_FILE);
    const oldLog = await readOptionalFile(logAbs);
    await appendLog(corpusRoot, {
      op,
      object: title,
      ...(args.log.note !== undefined ? { note: args.log.note } : {}),
    });
    undos.push(
      oldLog === null
        ? () => rm(logAbs, { force: true })
        : () => writeFile(logAbs, oldLog, "utf8"),
    );

    // 显式暂存本操作的全部产物：计划页面（含删除的原路径）、.trash/ 移动目标、被引用的
    // 待灌原料、index、log。不用 add "."：窗口期人类手改不得被卷进 agent 的 commit（ADR-0004）。
    // 待灌原料携带（ADR-0005）：本批来源页 source 引用、且尚未跟踪的 raw 文件与 wiki 产物
    // 进同一个 commit——一次 ingest = 原料 + 知识编译原子入库。
    const sourceRefs = new Set(
      planned.flatMap((c) =>
        c.meta?.type === PAGE_TYPE_SOURCE && c.meta.source ? [c.meta.source] : [],
      ),
    );
    const carryRaw = status.pendingRaw.filter((p) => sourceRefs.has(p));
    const stagePaths = [
      ...planned.flatMap((c) =>
        c.action === "deleted" && c.trashRel ? [c.rel, c.trashRel] : [c.rel],
      ),
      ...carryRaw,
      INDEX_FILE,
      LOG_FILE,
    ];
    await gitAdd(corpusRoot, stagePaths);
    const sha = await gitCommit(corpusRoot, `${op}: ${title}`);

    return textResult({
      ok: true,
      applied: planned.map((c) => ({
        path: c.rel,
        action: c.action,
        ...(c.action === "deleted" && c.trashRel ? { trashPath: c.trashRel } : {}),
      })),
      index: { sources: indexData.sources.length, topics: indexData.topics.length },
      log: { op, object: title },
      commit: { sha, message: `${op}: ${title}` },
    });
  } catch (error) {
    // 回滚：逆序恢复已落盘内容，尽力让工作树与暂存区回到 HEAD；
    // 不做任何 gitAdd——失败路径绝不触碰暂存区，保证零残留
    for (const undo of [...undos].reverse()) {
      try {
        await undo();
      } catch {
        // 尽力而为；corpus 受 git 管理，残余可人工恢复
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail("write_failed", `写入阶段失败，已回滚全部变更：${message}`);
  }
}

export const applyTool: ToolDefinition = {
  name: "apply",
  description:
    "唯一写入口：整批提交 wiki/ 页面变更并原子落库。入参为变更集（path 限 wiki/ 内平铺 .md、" +
    "整页内容；content 为 null 表示删除，文件移入 .trash/）与日志条目（op 取 ingest 或 refactor（纯 wiki 重组）、" +
    "title 兼作 commit 标题）。流程：git 干净检查（脏即拒绝并列出文件）→ 校验（frontmatter 必填、" +
    "wikilink 目标存在或本批新建、title=文件名、名字唯一（重名建议消歧义后缀）、路径约束与文件名合法字符、不碰 raw/）" +
    "→ 变更 + index.md 联动 + log.md 追加进单个 commit（<op>: <标题>）。任一步失败整批拒绝，corpus 零变更。",
  register(server, ctx) {
    server.registerTool(
      this.name,
      { description: this.description, inputSchema },
      async (args) => {
        // 写事务整体（干净检查→写→commit）包进 corpus 写锁，与其他 server 实例串行（#8）
        try {
          return await withWriteLock(ctx.corpusDir, () =>
            handleApply(ctx.corpusDir, args as ApplyArgs),
          );
        } catch (error) {
          if (error instanceof LockBusyError) {
            return fail("lock_busy", error.message);
          }
          throw error;
        }
      },
    );
  },
};
