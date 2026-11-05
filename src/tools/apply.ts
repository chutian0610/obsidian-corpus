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
import { parseWikiPage, topicTitleFromMeta, type PageMeta } from "../corpus/frontmatter.js";
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
 * 校验（frontmatter 必填、wikilink 目标存在或本批新建、路径约束、不碰 raw/）
 * 全部通过后才落盘，变更 + index.md 联动 + log.md 追加进单个 commit（`ingest: <标题>`）。
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
    /** 日志操作类型，apply 固定 ingest。 */
    op: z.string().optional(),
    /** 日志对象（也是 commit 消息标题）。 */
    title: z.string().optional(),
    /** 可选说明行。 */
    note: z.string().optional(),
  }),
};

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
    | "broken_wikilink";
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

  // ② 日志条目校验（op 固定 ingest；title 兼作 log 对象与 commit 标题）
  const op = args.log.op ?? "ingest";
  const title = (args.log.title ?? "").trim();
  if (op !== "ingest") {
    issues.push({ code: "invalid_log", message: `apply 的日志 op 只能为 ingest（实际：${op}）` });
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

  if (issues.length > 0) {
    // 校验失败时尚未落盘任何内容，天然零残留
    return fail("validation_failed", "变更集校验失败，整批拒绝。", { issues });
  }

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
      op: "ingest",
      object: title,
      ...(args.log.note !== undefined ? { note: args.log.note } : {}),
    });
    undos.push(
      oldLog === null
        ? () => rm(logAbs, { force: true })
        : () => writeFile(logAbs, oldLog, "utf8"),
    );

    // 前置脏树检查保证此刻树上只有本操作的产物，add "." 即只暂存自己的结果
    await gitAdd(corpusRoot, ["."]);
    const sha = await gitCommit(corpusRoot, `ingest: ${title}`);

    return textResult({
      ok: true,
      applied: planned.map((c) => ({
        path: c.rel,
        action: c.action,
        ...(c.action === "deleted" && c.trashRel ? { trashPath: c.trashRel } : {}),
      })),
      index: { sources: indexData.sources.length, topics: indexData.topics.length },
      log: { op: "ingest", object: title },
      commit: { sha, message: `ingest: ${title}` },
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
    "整页新内容；content 为 null 表示删除，文件移入 .trash/）与日志条目（op 固定 ingest、title 兼作 commit 标题）。" +
    "流程：git 干净检查（脏即拒绝并列出文件）→ 校验（frontmatter 必填、wikilink 目标存在或本批新建、路径约束、不碰 raw/）" +
    "→ 变更 + index.md 联动 + log.md 追加进单个 commit（ingest: <标题>）。任一步失败整批拒绝，corpus 零变更。",
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
