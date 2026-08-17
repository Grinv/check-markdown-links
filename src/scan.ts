import { readdir, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "vendor",
]);

const MARKDOWN_EXT = new Set([".md", ".markdown"]);

export interface ScanOptions {
  ignore?: string[];
  onWarning?: (message: string) => void;
}

/**
 * Recursively finds Markdown files under rootDir.
 * Returns absolute paths, sorted for deterministic output.
 */
export async function scanMarkdownFiles(
  rootDir: string,
  options: ScanOptions = {},
): Promise<string[]> {
  const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
  const onWarning = options.onWarning ?? (() => {});
  const files: string[] = [];

  await walk(path.resolve(rootDir), rootDir, ignore, files, onWarning);

  files.sort();
  return files;
}

async function walk(
  dir: string,
  rootDir: string,
  ignore: Set<string>,
  files: string[],
  onWarning: (message: string) => void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      onWarning(`${err.code}: ${path.relative(rootDir, dir) || "."}`);
      return;
    }
    throw err;
  }

  for (const entry of entries) {
    const name = entry.name;
    const fullPath = path.join(dir, name);

    if (entry.isSymbolicLink()) {
      let targetStat;
      try {
        targetStat = await fsStat(fullPath);
      } catch {
        continue; // broken symlink — nothing to scan
      }
      if (targetStat.isDirectory()) continue; // don't follow directory symlinks
      if (targetStat.isFile() && MARKDOWN_EXT.has(path.extname(name).toLowerCase())) {
        files.push(fullPath);
      }
      continue;
    }

    if (entry.isDirectory()) {
      if (ignore.has(name)) continue;
      if (name.startsWith(".")) continue;
      await walk(fullPath, rootDir, ignore, files, onWarning);
      continue;
    }

    if (entry.isFile()) {
      if (MARKDOWN_EXT.has(path.extname(name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }
}
