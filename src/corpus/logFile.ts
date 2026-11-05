import { appendFile, readFile } from "node:fs/promises";
import { LOG_FILE, resolveInCorpus } from "./paths.js";

/**
 * Log（日志，log.md）格式（spec #1，一字不差）：
 * 行首 `## [YYYY-MM-DD HH:mm] <op> | <对象>`，后跟可选说明行；仅 init 与 apply 追加，只增不改。
 */
export const LOG_OPS = ["init", "ingest"] as const;
export type LogOp = (typeof LOG_OPS)[number];

/** 条目头格式：`## [YYYY-MM-DD HH:mm] <op> | <对象>`。 */
export const LOG_HEADER_PREFIX = "## [";
export const LOG_HEADER_RE = /^## \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (\S+) \| (.+)$/u;

export interface LogEntry {
  /** `YYYY-MM-DD HH:mm`（本地时间）。 */
  time: string;
  op: string;
  object: string;
  /** 头行之后、下一头行之前的说明行（可为空）。 */
  note: string;
}

/** Date → `YYYY-MM-DD HH:mm`（本地时间，补零）。 */
export function formatLogTimestamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 渲染一条日志（头行 + 可选说明行，末尾换行）。 */
export function formatLogEntry(entry: { time: string; op: string; object: string; note?: string }): string {
  const header = `${LOG_HEADER_PREFIX}${entry.time}] ${entry.op} | ${entry.object}`;
  return entry.note && entry.note.trim() !== "" ? `${header}\n${entry.note.trim()}\n` : `${header}\n`;
}

export function isLogOp(value: string): value is LogOp {
  return (LOG_OPS as readonly string[]).includes(value);
}

/** 解析整个 log.md（只增文件，全量解析，最新的在最后）。 */
export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const m = line.match(LOG_HEADER_RE);
    if (m) {
      entries.push({ time: m[1] ?? "", op: m[2] ?? "", object: m[3] ?? "", note: "" });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last && line.trim() !== "") {
      last.note = last.note === "" ? line.trim() : `${last.note}\n${line.trim()}`;
    }
  }
  return entries;
}

/** 只增追加一条日志（op 必须在 LOG_OPS 内；条目之间以空行分隔）。 */
export async function appendLog(
  corpusRoot: string,
  entry: { op: LogOp; object: string; note?: string; time?: Date },
): Promise<void> {
  if (!isLogOp(entry.op)) {
    throw new Error(`未知日志操作类型：${entry.op}`);
  }
  const abs = resolveInCorpus(corpusRoot, LOG_FILE);
  const time = entry.time ?? new Date();
  const formatted: { time: string; op: string; object: string; note?: string } = {
    time: formatLogTimestamp(time),
    op: entry.op,
    object: entry.object,
  };
  if (entry.note !== undefined) {
    formatted.note = entry.note;
  }
  let chunk = formatLogEntry(formatted);
  let existing = "";
  try {
    existing = await readFile(abs, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (existing !== "" && !existing.endsWith("\n\n")) {
    chunk = `\n${chunk}`;
  }
  await appendFile(abs, chunk, "utf8");
}

/** 读最近 count 条日志（默认全部；status 工具取尾部若干条）。 */
export async function readLog(corpusRoot: string, count?: number): Promise<LogEntry[]> {
  const abs = resolveInCorpus(corpusRoot, LOG_FILE);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const entries = parseLog(text);
  return count === undefined ? entries : entries.slice(-count);
}
