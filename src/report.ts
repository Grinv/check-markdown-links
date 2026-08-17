import path from "node:path";
import type { LinkKind } from "./extract.ts";
import type { LinkType } from "./resolve.ts";

export type ResultStatus = "ok" | "broken" | "warning" | "skipped";

export interface LinkResult {
  file: string; // relative to root, '/'-separated
  line: number;
  column: number;
  kind: LinkKind;
  text: string;
  rawUrl: string | null;
  type: LinkType;
  target: string | null;
  anchor: string | null;
  status: ResultStatus;
  httpStatus: number | null;
  reason: string | null;
}

export interface Summary {
  ok: number;
  broken: number;
  warning: number;
  skipped: number;
}

export interface ReportData {
  root: string;
  scannedFiles: number;
  totalLinks: number;
  uniqueExternalUrls: number;
  durationMs: number;
  results: LinkResult[];
  warnings: string[];
}

export interface ReportOptions {
  json?: boolean;
  color?: boolean;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const STATUS_COLOR: Record<ResultStatus, string> = {
  ok: "\x1b[32m",
  broken: "\x1b[31m",
  warning: "\x1b[33m",
  skipped: "\x1b[90m",
};

export function computeSummary(results: LinkResult[]): Summary {
  const summary: Summary = { ok: 0, broken: 0, warning: 0, skipped: 0 };
  for (const r of results) {
    summary[r.status]++;
  }
  return summary;
}

export function sortResults(results: LinkResult[]): LinkResult[] {
  return [...results].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
}

export function toJson(data: ReportData): string {
  const sorted = sortResults(data.results);
  const summary = computeSummary(sorted);
  return JSON.stringify(
    {
      root: data.root,
      scannedFiles: data.scannedFiles,
      totalLinks: data.totalLinks,
      uniqueExternalUrls: data.uniqueExternalUrls,
      durationMs: data.durationMs,
      summary,
      results: sorted,
      warnings: data.warnings,
    },
    null,
    2,
  );
}

export function printReport(data: ReportData, options: ReportOptions = {}): void {
  if (options.json) {
    process.stdout.write(toJson(data) + "\n");
    return;
  }
  process.stdout.write(renderText(data, options.color ?? true) + "\n");
}

function colorize(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${RESET}` : text;
}

function truncateUrl(url: string, max = 80): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + "…";
}

function padCell(raw: string, width: number, colored: string): string {
  return colored + " ".repeat(Math.max(0, width - raw.length));
}

function statusLabel(r: LinkResult): string {
  if (r.httpStatus != null) return String(r.httpStatus);
  return r.reason ?? r.status.toUpperCase();
}

const TABLE_HEADERS = { pos: "Позиция", url: "Ссылка", status: "Статус", code: "Код" };

/** Text-mode table lists only broken links — see SPEC.md §11. */
function renderFileGroup(file: string, rows: LinkResult[], color: boolean): string {
  const broken = rows.filter((r) => r.status === "broken");
  if (broken.length === 0) return "";

  const cells = broken.map((r) => ({
    pos: `${r.line}:${r.column}`,
    url: truncateUrl(r.rawUrl ?? ""),
    statusText: r.status.toUpperCase(),
    code: statusLabel(r),
    statusColor: STATUS_COLOR[r.status],
  }));

  const posWidth = Math.max(TABLE_HEADERS.pos.length, ...cells.map((c) => c.pos.length));
  const urlWidth = Math.max(TABLE_HEADERS.url.length, ...cells.map((c) => c.url.length));
  const statusWidth = Math.max(TABLE_HEADERS.status.length, ...cells.map((c) => c.statusText.length));
  const codeWidth = Math.max(TABLE_HEADERS.code.length, ...cells.map((c) => c.code.length));

  function buildRow(pos: string, url: string, statusRaw: string, statusColored: string, code: string): string {
    const parts = [
      padCell(pos, posWidth, pos),
      padCell(url, urlWidth, url),
      padCell(statusRaw, statusWidth, statusColored),
      padCell(code, codeWidth, code),
    ];
    return `  ${parts.join(" | ")}`;
  }

  function buildSeparator(): string {
    return `  ${[posWidth, urlWidth, statusWidth, codeWidth].map((w) => "-".repeat(w)).join("-+-")}`;
  }

  const headerRow = buildRow(
    TABLE_HEADERS.pos,
    TABLE_HEADERS.url,
    TABLE_HEADERS.status,
    colorize(TABLE_HEADERS.status, BOLD, color),
    TABLE_HEADERS.code,
  );
  const separator = buildSeparator();
  const dataRows = cells.map((c) =>
    buildRow(c.pos, c.url, c.statusText, colorize(c.statusText, c.statusColor, color), c.code),
  );

  return [colorize(file, BOLD, color), headerRow, separator, ...dataRows].join("\n");
}

function renderText(data: ReportData, color: boolean): string {
  const sorted = sortResults(data.results);
  const summary = computeSummary(sorted);

  const groups = new Map<string, LinkResult[]>();
  for (const r of sorted) {
    if (!groups.has(r.file)) groups.set(r.file, []);
    groups.get(r.file)!.push(r);
  }

  const out: string[] = [];
  out.push(
    colorize(
      `Scanned ${data.root}: ${data.scannedFiles} file(s), ${data.totalLinks} link(s)`,
      BOLD,
      color,
    ),
  );
  out.push("");

  for (const [file, rows] of groups) {
    const rendered = renderFileGroup(file, rows, color);
    if (rendered) {
      out.push(rendered);
      out.push("");
    }
  }

  for (const warning of data.warnings) {
    out.push(colorize(`warning: ${warning}`, STATUS_COLOR.warning, color));
  }
  if (data.warnings.length > 0) out.push("");

  const externalCount = sorted.filter((r) => r.type === "external").length;

  out.push(
    `Files: ${data.scannedFiles}  Links: ${data.totalLinks}  ` +
      `External links: ${externalCount} (${data.uniqueExternalUrls} unique)  ` +
      `${colorize(`ok: ${summary.ok}`, STATUS_COLOR.ok, color)}  ` +
      `${colorize(`broken: ${summary.broken}`, STATUS_COLOR.broken, color)}  ` +
      `${colorize(`warning: ${summary.warning}`, STATUS_COLOR.warning, color)}  ` +
      `${colorize(`skipped: ${summary.skipped}`, STATUS_COLOR.skipped, color)}  ` +
      `time: ${data.durationMs}ms`,
  );

  out.push(
    summary.broken > 0
      ? colorize(`${summary.broken} broken link(s)`, STATUS_COLOR.broken, color)
      : colorize("OK", STATUS_COLOR.ok, color),
  );

  return out.join("\n");
}

export function toRelativeFile(root: string, absFile: string): string {
  return path.relative(root, absFile).split(path.sep).join("/");
}
