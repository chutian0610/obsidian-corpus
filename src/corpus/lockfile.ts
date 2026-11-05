import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * corpus 写级互斥锁（#8）：同一 corpus 同时只允许一个写事务临界区（init/apply）。
 *
 * 锁文件放在系统临时目录（按 corpus 绝对路径 sha256 命名），不落在 corpus 内——
 * 零 git 足迹，存量 corpus 无需迁移。内容为 JSON {pid, acquiredAt}；
 * 持有进程已死（kill(pid,0) 抛 ESRCH）视为崩溃残留，下一持有者破锁接管。
 * 读工具不加锁：并发只读无害，仅写串行。
 */

const LOCK_DIR = path.join(tmpdir(), "obsidian-corpus-locks");
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 150;
const MAX_BREAK_ATTEMPTS = 3;

/** 拿锁等待上限（毫秒），环境变量 CORPUS_LOCK_TIMEOUT_MS 可覆盖。 */
function lockTimeoutMs(): number {
  const raw = Number(process.env.CORPUS_LOCK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** 锁文件路径；导出供测试预置/检查。corpus 尚不存在时 realpath 退化为 resolve（init 冷启动）。 */
export async function corpusLockPath(corpusRoot: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(corpusRoot);
  } catch {
    resolved = path.resolve(corpusRoot);
  }
  const hash = createHash("sha256").update(resolved).digest("hex");
  return path.join(LOCK_DIR, `${hash}.lock`);
}

interface LockInfo {
  pid: number;
  acquiredAt: string;
}

/** 持锁进程是否存活；EPERM 视为存活（进程存在但无权限发信号）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 拿锁等待超时：中文错误并附手动破锁指引。 */
export class LockBusyError extends Error {
  constructor(holderPid: number, lockPath: string, waitedMs: number) {
    super(
      `另一个写操作正持有本 corpus 的锁（PID ${holderPid}，已等待 ${waitedMs}ms 未释放）。` +
        `若确认没有并发（如持锁进程异常退出），删除锁文件后重试：${lockPath}`,
    );
    this.name = "LockBusyError";
  }
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockInfo>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return { pid: parsed.pid, acquiredAt: String(parsed.acquiredAt ?? "") };
  } catch {
    return null; // 空/损坏的锁文件按崩溃残留处理
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + lockTimeoutMs();
  let breaks = 0;
  for (;;) {
    let handle: FileHandle | null = null;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (handle) {
      const info: LockInfo = { pid: process.pid, acquiredAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(info), "utf8");
      await handle.close();
      return;
    }
    const info = await readLockInfo(lockPath);
    // 自己未持锁却见到本进程 PID：只能是上次崩溃残留或 PID 复用，按可破处理
    const breakable =
      info === null || info.pid === process.pid || !isProcessAlive(info.pid);
    if (breakable) {
      // 崩溃残留：破锁后重试（限次，防两个等待者互踩死循环）
      if (++breaks > MAX_BREAK_ATTEMPTS) {
        throw new LockBusyError(info?.pid ?? 0, lockPath, 0);
      }
      await rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockBusyError(info.pid, lockPath, lockTimeoutMs());
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  const info = await readLockInfo(lockPath);
  if (info?.pid === process.pid) {
    await rm(lockPath, { force: true });
  }
}

/** 把整个写事务临界区包进锁：拿锁 → fn → finally 释放。 */
export async function withWriteLock<T>(corpusRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = await corpusLockPath(corpusRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}
