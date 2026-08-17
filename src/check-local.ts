import { lstat, readFile, stat } from "node:fs/promises";
import { extractHeadingAnchors } from "./extract.ts";

export type LocalStatus = "ok" | "broken";

export interface CheckLocalResult {
  status: LocalStatus;
  reason: string;
}

export type LocalCache = Map<string, Promise<CheckLocalResult>>;

/**
 * Checks whether a local path exists on disk. Results are cached by
 * absolute path in the provided Map (pass the same Map across calls within
 * one run to dedupe `stat` syscalls; omit it to check without caching).
 */
export function checkLocal(absPath: string, cache: LocalCache = new Map()): Promise<CheckLocalResult> {
  let cached = cache.get(absPath);
  if (!cached) {
    cached = statPath(absPath);
    cache.set(absPath, cached);
  }
  return cached;
}

async function statPath(absPath: string): Promise<CheckLocalResult> {
  try {
    const stats = await stat(absPath);
    return { status: "ok", reason: stats.isDirectory() ? "DIRECTORY" : "FILE" };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      const dangling = await isDanglingSymlink(absPath);
      return dangling
        ? { status: "broken", reason: "BROKEN_SYMLINK" }
        : { status: "broken", reason: "NOT_FOUND" };
    }
    if (err.code === "EACCES" || err.code === "EPERM") {
      return { status: "broken", reason: "NO_ACCESS" };
    }
    return { status: "broken", reason: "NOT_FOUND" };
  }
}

async function isDanglingSymlink(absPath: string): Promise<boolean> {
  try {
    const link = await lstat(absPath);
    return link.isSymbolicLink();
  } catch {
    return false;
  }
}

export type AnchorCache = Map<string, Promise<Set<string>>>;

/**
 * Checks whether `anchor` matches one of the heading slugs in the file at
 * `absPath`. Results are cached by absolute path (one read per file per run).
 */
export async function checkAnchor(absPath: string, anchor: string, cache: AnchorCache = new Map()): Promise<boolean> {
  let cached = cache.get(absPath);
  if (!cached) {
    cached = readFile(absPath, "utf8")
      .then((content) => extractHeadingAnchors(content))
      .catch(() => new Set<string>());
    cache.set(absPath, cached);
  }
  const slugs = await cached;
  return slugs.has(anchor);
}
