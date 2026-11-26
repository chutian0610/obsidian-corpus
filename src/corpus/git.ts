import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RAW_DIR } from "./paths.js";

/**
 * git 封装（ADR-0004）：shell git、只在 init/apply 中提交 server 自己的操作结果、
 * status/apply 前置检查工作树、一 op 一 commit。
 * 所有命令统一 `core.quotepath=false`，中文文件名原样输出（corpus 页面为中文文件名）；
 * 它只免除非 ASCII 字符的转义，不保证路径无引号——解析路径输出的命令须配 `-z`（见 gitStatus）。
 */
const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} 失败：${message}`);
    this.name = "GitError";
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message?: string; code?: unknown };
    throw new GitError(err.stderr?.trim() || err.message || String(err.code), args, err.stderr ?? "");
  }
}

/** `git init`（对已初始化的目录幂等，reinit 无副作用）。 */
export async function gitInit(cwd: string): Promise<void> {
  await runGit(cwd, ["init"]);
}

export interface GitStatus {
  /** 工作树是否干净（阻塞性变更为零；未跟踪的 raw/ 待灌材料不算脏，见 ADR-0005）。 */
  clean: boolean;
  /** 阻塞性脏文件清单（含暂存、修改、删除、未跟踪；rename/copy 显示为 `old -> new`）。 */
  dirtyFiles: string[];
  /** 未跟踪的 raw/ 待灌材料（不阻塞写操作；apply 引用即携带入库，见 ADR-0005）。 */
  pendingRaw: string[];
}

/**
 * `git status --porcelain -z --untracked-files=all`；干净检查是 apply 的前置安全边界。
 * 未跟踪目录展开到文件（`-uall`），否则 `?? raw/` 折叠成目录无法逐文件分类。
 * 必须带 `-z`：路径以 NUL 分隔、原样输出。按行解析时 git 会把含空格、引号、反斜杠或控制字符的路径
 * 整体加引号并转义（`?? "raw/新材料 v2.md"`），而 `core.quotepath=false` 只免除非 ASCII 字符——
 * 带引号的路径匹配不上 `raw/` 前缀，待灌材料会被误判为脏树。
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const out = await runGit(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  // porcelain v1 记录为 `XY <path>`（X/Y 为状态码，固定两字符 + 一空格），每条以 NUL 结尾；
  // 未暂存改动的 X 为空格。不能先 trim 再切：前导空格是状态码的一部分，trim 后 slice(3) 会吃掉路径首字符
  const records = out.split("\0").filter((record) => record !== "");
  const dirtyFiles: string[] = [];
  const pendingRaw: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? "";
    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    // 暂存的 rename/copy 在 -z 下省去 ` -> ` 且字段反转（`XY new\0old\0`），源路径是紧随的一条记录
    if (xy.startsWith("R") || xy.startsWith("C")) {
      dirtyFiles.push(`${records[i + 1] ?? ""} -> ${filePath}`);
      i += 1;
      continue;
    }
    // 未跟踪的 raw/ 新材料是「待灌材料」而非「未保存的手改」（ADR-0005）；
    // 已跟踪 raw 文件被改动仍属阻塞——Raw 层不可变。
    const isPendingRaw =
      xy === "??" && (filePath === RAW_DIR || filePath.startsWith(RAW_DIR + "/"));
    if (isPendingRaw) {
      pendingRaw.push(filePath);
    } else {
      dirtyFiles.push(filePath);
    }
  }
  return { clean: dirtyFiles.length === 0, dirtyFiles, pendingRaw };
}

/** 暂存指定路径（pathspec 限 corpus 内相对路径或 `.`）。 */
export async function gitAdd(cwd: string, paths: string[]): Promise<void> {
  await runGit(cwd, ["add", "--", ...paths]);
}

/** 提交暂存区并返回新 commit 的完整 sha。无暂存内容时抛 GitError（调用方保证先 add）。 */
export async function gitCommit(cwd: string, message: string): Promise<string> {
  await runGit(cwd, ["commit", "-m", message]);
  return (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
}

export interface GitLogEntry {
  sha: string;
  subject: string;
  /** ISO 严格格式时间。 */
  date: string;
  author: string;
}

/** `git log`（新到旧）；尚无任何 commit 时返回空列表。 */
export async function gitLog(cwd: string, maxCount = 10): Promise<GitLogEntry[]> {
  let out: string;
  try {
    out = await runGit(cwd, [
      "log",
      "-n",
      String(maxCount),
      "--pretty=format:%H%x1f%s%x1f%ad%x1f%an",
      "--date=iso-strict",
    ]);
  } catch (error) {
    if (error instanceof GitError && error.stderr.includes("does not have any commits yet")) {
      return [];
    }
    throw error;
  }
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", subject = "", date = "", author = ""] = line.split("\x1f");
      return { sha, subject, date, author };
    });
}
