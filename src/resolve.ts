import path from "node:path";
import { fileURLToPath } from "node:url";

export type LinkType = "external" | "local" | "skipped" | "invalid";

export interface ClassifyOptions {
  sourceFile: string;
  rootDir: string;
}

export interface ClassifyResult {
  type: LinkType;
  target: string | null;
  reason: string | null;
  /** Fragment identifier to check against the target file's headings.
   * `null` when the link has no fragment, `""` for a bare `#` (top of
   * document — always considered valid). */
  anchor: string | null;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Classifies a raw link URL and computes its resolution target.
 * See SPEC.md §8 for the rule order (first match wins).
 */
export function classify(rawUrl: string | null, options: ClassifyOptions): ClassifyResult {
  if (rawUrl == null) {
    return { type: "invalid", target: null, reason: "UNDEFINED_REFERENCE", anchor: null };
  }

  const value = rawUrl.trim();
  if (value === "") {
    return { type: "invalid", target: null, reason: "EMPTY_URL", anchor: null };
  }

  if (value.startsWith("#")) {
    return {
      type: "local",
      target: options.sourceFile,
      reason: null,
      anchor: normalizeAnchor(value.slice(1)),
    };
  }

  const schemeMatch = SCHEME_RE.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();

    if (scheme === "http" || scheme === "https") {
      const url = new URL(value);
      url.hash = "";
      return { type: "external", target: url.toString(), reason: null, anchor: null };
    }

    if (scheme === "file") {
      const url = new URL(value);
      const anchor = normalizeAnchor(url.hash ? url.hash.slice(1) : null);
      url.hash = "";
      url.search = "";
      return { type: "local", target: fileURLToPath(url), reason: null, anchor };
    }

    return { type: "skipped", target: null, reason: "UNSUPPORTED_SCHEME", anchor: null };
  }

  if (value.startsWith("//")) {
    return { type: "external", target: `https:${value}`, reason: null, anchor: null };
  }

  const isRootRelative = value.startsWith("/");
  const hashIdx = value.indexOf("#");
  const anchorRaw = hashIdx !== -1 ? value.slice(hashIdx + 1) : null;
  const normalized = normalizeUrlPath(value);
  if (normalized === null) {
    return { type: "invalid", target: null, reason: "EMPTY_URL", anchor: null };
  }

  const target = isRootRelative
    ? path.join(options.rootDir, normalized)
    : path.resolve(path.dirname(options.sourceFile), normalized);

  return { type: "local", target, reason: null, anchor: normalizeAnchor(anchorRaw) };
}

/** Strips fragment/query, percent-decodes, and normalizes slashes — SPEC.md §8/§9. */
function normalizeUrlPath(raw: string): string | null {
  let s = raw;

  const hashIdx = s.indexOf("#");
  if (hashIdx !== -1) s = s.slice(0, hashIdx);

  const queryIdx = s.indexOf("?");
  if (queryIdx !== -1) s = s.slice(0, queryIdx);

  if (s === "") return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    decoded = s;
  }

  return decoded.replace(/\\/g, "/");
}

/** Percent-decodes and lowercases a fragment for anchor comparison; `""` marks "top of document". */
function normalizeAnchor(raw: string | null): string | null {
  if (raw == null) return null;
  if (raw === "") return "";

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }

  return decoded.toLowerCase();
}
