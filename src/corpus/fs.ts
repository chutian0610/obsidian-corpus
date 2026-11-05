import { readFile, stat } from "node:fs/promises";

/** 共享 fs 小工具：存在性探测与可选读，收口 init/apply/index/log/search 的同形 try/catch。 */

/** 路径存在性探测（文件或目录均可；stat 报错一律按不存在处理）。 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读文本文件；不存在返回 null，其余错误照抛。
 * 幂等读（缺文件视为空）与事务回滚前的旧内容快照共用。
 */
export async function readOptionalFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
