import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { stat as statAsync, readFile as readFileAsync } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanMarkdownFiles } from "./scan.ts";
import { extractLinks } from "./extract.ts";
import { classify } from "./resolve.ts";
import { checkLocal, checkAnchor, type LocalCache, type AnchorCache } from "./check-local.ts";
import { createHttpChecker, type HttpCache } from "./check-http.ts";
import { printReport, toRelativeFile, computeSummary, type LinkResult, type ReportData } from "./report.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

function usage(): string {
  return [
    "Usage: checkmdlinks <folder> [options]",
    "",
    "Options:",
    "  --timeout <ms>       HTTP request timeout in ms (default: 5000)",
    "  --concurrency <n>    Max concurrent HTTP requests (default: 8)",
    "  --no-external        Do not check http(s) links (marked as skipped)",
    "  --only-external      Do not check local links",
    "  --ignore <name>      Extra directory/name to exclude (repeatable)",
    "  --json               Machine-readable JSON output",
    "  --no-color           Disable ANSI colors",
    "  -h, --help           Show this help",
    "  -v, --version        Show version",
  ].join("\n");
}

function parseTimeout(raw: string | undefined): number | null {
  if (raw === undefined) return 5000;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseConcurrency(raw: string | undefined): number | null {
  if (raw === undefined) return 8;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function shouldUseColor(noColorFlag: boolean, jsonFlag: boolean): boolean {
  if (jsonFlag) return false;
  if (noColorFlag) return false;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "") return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

/** Runs the CLI for the given argv (excluding `node`/script path) and returns the exit code. */
export async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        timeout: { type: "string" },
        concurrency: { type: "string" },
        "no-external": { type: "boolean", default: false },
        "only-external": { type: "boolean", default: false },
        ignore: { type: "string", multiple: true, default: [] },
        json: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err: any) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (values.version) {
    process.stdout.write(readPackageVersion() + "\n");
    return 0;
  }

  if (positionals.length !== 1) {
    process.stderr.write(`Error: expected exactly one <folder> argument\n\n${usage()}\n`);
    return 2;
  }

  const folderArg = positionals[0];
  const rootDir = path.resolve(process.cwd(), folderArg);

  let dirStat;
  try {
    dirStat = await statAsync(rootDir);
  } catch {
    process.stderr.write(`Error: path does not exist: ${folderArg}\n`);
    return 2;
  }
  if (!dirStat.isDirectory()) {
    process.stderr.write(`Error: not a directory: ${folderArg}\n`);
    return 2;
  }

  const timeoutMs = parseTimeout(values.timeout as string | undefined);
  if (timeoutMs === null) {
    process.stderr.write(`Error: invalid --timeout value: ${values.timeout}\n\n${usage()}\n`);
    return 2;
  }

  const concurrency = parseConcurrency(values.concurrency as string | undefined);
  if (concurrency === null) {
    process.stderr.write(`Error: invalid --concurrency value: ${values.concurrency}\n\n${usage()}\n`);
    return 2;
  }

  const noExternal = Boolean(values["no-external"]);
  const onlyExternal = Boolean(values["only-external"]);
  const jsonOutput = Boolean(values.json);
  const color = shouldUseColor(Boolean(values["no-color"]), jsonOutput);
  const ignore = (values.ignore as string[]) ?? [];

  const startedAt = Date.now();
  const warnings: string[] = [];

  const files = await scanMarkdownFiles(rootDir, {
    ignore,
    onWarning: (message) => warnings.push(message),
  });

  const pending: Array<{ link: ReturnType<typeof extractLinks>[number]; classification: ReturnType<typeof classify> }> = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFileAsync(file, "utf8");
    } catch (err: any) {
      warnings.push(`${err.code ?? "READ_ERROR"}: ${toRelativeFile(rootDir, file)}`);
      continue;
    }
    for (const link of extractLinks(content, file)) {
      const classification = classify(link.rawUrl, { sourceFile: file, rootDir });
      pending.push({ link, classification });
    }
  }

  const version = readPackageVersion();
  const httpCache: HttpCache = new Map();
  const checkExternal = createHttpChecker({
    timeoutMs,
    concurrency,
    userAgent: `checkmdlinks/${version}`,
    cache: httpCache,
  });
  const localCache: LocalCache = new Map();
  const anchorCache: AnchorCache = new Map();

  const results: LinkResult[] = await Promise.all(
    pending.map(async ({ link, classification }): Promise<LinkResult> => {
      const base = {
        file: toRelativeFile(rootDir, link.file),
        line: link.line,
        column: link.column,
        kind: link.kind,
        text: link.text,
        rawUrl: link.rawUrl,
        type: classification.type,
        target: classification.target,
        anchor: classification.anchor,
      };

      if (classification.type === "invalid") {
        return { ...base, status: "broken", httpStatus: null, reason: classification.reason };
      }

      if (classification.type === "skipped") {
        return { ...base, status: "skipped", httpStatus: null, reason: classification.reason };
      }

      if (classification.type === "local") {
        if (onlyExternal) {
          return { ...base, status: "skipped", httpStatus: null, reason: "LOCAL_DISABLED" };
        }
        const localResult = await checkLocal(classification.target!, localCache);
        if (localResult.status === "ok" && classification.anchor) {
          if (localResult.reason === "DIRECTORY") {
            return { ...base, status: "broken", httpStatus: null, reason: "ANCHOR_NOT_FOUND" };
          }
          const found = await checkAnchor(classification.target!, classification.anchor, anchorCache);
          if (!found) {
            return { ...base, status: "broken", httpStatus: null, reason: "ANCHOR_NOT_FOUND" };
          }
        }
        return { ...base, status: localResult.status, httpStatus: null, reason: localResult.reason };
      }

      // external
      if (noExternal) {
        return { ...base, status: "skipped", httpStatus: null, reason: "EXTERNAL_DISABLED" };
      }
      const httpResult = await checkExternal(classification.target!);
      return { ...base, status: httpResult.status, httpStatus: httpResult.httpStatus, reason: httpResult.reason };
    }),
  );

  const durationMs = Date.now() - startedAt;

  const reportData: ReportData = {
    root: rootDir,
    scannedFiles: files.length,
    totalLinks: pending.length,
    uniqueExternalUrls: httpCache.size,
    durationMs,
    results,
    warnings,
  };

  printReport(reportData, { json: jsonOutput, color });

  const summary = computeSummary(results);
  return summary.broken > 0 ? 1 : 0;
}
