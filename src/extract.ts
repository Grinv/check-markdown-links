export type LinkKind = "inline" | "image" | "reference" | "autolink" | "bare";

export interface Link {
  file: string;
  line: number;
  column: number;
  text: string;
  rawUrl: string | null;
  kind: LinkKind;
}

const WHITESPACE_RE = /\s/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const DEFINITION_RE = /^ {0,3}\[([^\]]+)\]:\s*(\S.*)?$/;
const AUTOLINK_RE = /^<(https?:\/\/[^\s<>]+)>/;
const BARE_FILE_RE = /^file:\/\/\/[^\s)>\]]*/;

/**
 * Extracts links from Markdown content using a simplified, line-based
 * parser (not a full CommonMark implementation) — see SPEC.md §7.
 */
export function extractLinks(content: string, filePath: string): Link[] {
  const lines = content.split(/\r\n|\r|\n/);
  const fenced = computeFencedLineMask(lines);

  const definitions = new Map<string, string>();
  const definitionLines = new Array<boolean>(lines.length).fill(false);

  for (let idx = 0; idx < lines.length; idx++) {
    if (fenced[idx]) continue;
    const match = DEFINITION_RE.exec(lines[idx]);
    if (!match) continue;
    definitionLines[idx] = true;
    const id = normalizeReferenceId(match[1]);
    const url = parseDestinationAndTitle(match[2] ?? "");
    if (url !== null && !definitions.has(id)) {
      definitions.set(id, url);
    }
  }

  const results: Link[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (fenced[idx] || definitionLines[idx]) continue;
    scanLine(lines[idx], idx + 1, filePath, definitions, results);
  }

  return results;
}

const ATX_HEADING_RE = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const HTML_ID_RE = /\bid\s*=\s*["']([^"']+)["']/g;

/**
 * Extracts the set of anchor slugs this file's headings resolve to:
 * auto-generated slugs from heading text (ATX-style `#`..`######` only,
 * approximating GitHub's algorithm — lowercase, strip punctuation, spaces
 * become hyphens, duplicates get a `-1`, `-2`, ... suffix), plus any
 * explicit `id="..."` / `id='...'` HTML anchors authored directly in the
 * document (a common manual-TOC pattern, e.g. `## <a id="foo">Title</a>`).
 */
export function extractHeadingAnchors(content: string): Set<string> {
  const lines = content.split(/\r\n|\r|\n/);
  const fenced = computeFencedLineMask(lines);
  const counts = new Map<string, number>();
  const slugs = new Set<string>();

  for (let idx = 0; idx < lines.length; idx++) {
    if (fenced[idx]) continue;

    const idRe = new RegExp(HTML_ID_RE);
    let idMatch: RegExpExecArray | null;
    while ((idMatch = idRe.exec(lines[idx])) !== null) {
      slugs.add(idMatch[1].toLowerCase());
    }

    const match = ATX_HEADING_RE.exec(lines[idx]);
    if (!match) continue;
    let slug = slugifyHeading(match[1]);
    if (slug === "") continue;
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    slugs.add(slug);
  }

  return slugs;
}

export function slugifyHeading(heading: string): string {
  let text = heading.trim();
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Asterisk emphasis can appear intraword; underscore emphasis (CommonMark)
  // cannot, so a mid-word underscore like in `run_tests` is left alone.
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  text = text.replace(/(?<!\w)_{1,3}([^_]+)_{1,3}(?!\w)/g, "$1");
  text = text.toLowerCase();
  text = text.replace(/[^\p{L}\p{N}_\s-]/gu, "");
  // GitHub's slugger replaces each space with a hyphen without collapsing
  // runs, so removed punctuation that leaves adjacent spaces (e.g. "A / B"
  // -> "a  b") produces double hyphens ("a--b") — that's expected, not a bug.
  text = text.trim().replace(/ /g, "-");
  return text;
}

function computeFencedLineMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (fenceChar) {
      mask[idx] = true;
      const closeMatch = FENCE_CLOSE_RE.exec(line);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const openMatch = FENCE_OPEN_RE.exec(line);
    if (openMatch) {
      mask[idx] = true;
      fenceChar = openMatch[1][0];
      fenceLen = openMatch[1].length;
    }
  }

  return mask;
}

function normalizeReferenceId(id: string): string {
  return id.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Extracts the URL from a destination string, discarding any title. */
function parseDestinationAndTitle(str: string): string | null {
  const s = str.trim();
  if (s.length === 0) return null;

  if (s[0] === "<") {
    let end = -1;
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\") {
        i++;
        continue;
      }
      if (s[i] === ">") {
        end = i;
        break;
      }
    }
    if (end === -1) return null;
    return s.slice(1, end);
  }

  let i = 0;
  while (i < s.length && !WHITESPACE_RE.test(s[i])) i++;
  return s.slice(0, i);
}

/** Masks inline code span contents (and their backtick delimiters) with spaces,
 * preserving line length/positions so column numbers stay accurate. */
function maskCodeSpans(line: string): string {
  const chars = line.split("");
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "`") {
      let j = i;
      while (j < chars.length && chars[j] === "`") j++;
      const runLen = j - i;
      let k = j;
      let closeStart = -1;
      let closeEnd = -1;
      while (k < chars.length) {
        if (chars[k] === "`") {
          let m = k;
          while (m < chars.length && chars[m] === "`") m++;
          if (m - k === runLen) {
            closeStart = k;
            closeEnd = m;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      if (closeStart !== -1) {
        for (let p = i; p < closeEnd; p++) chars[p] = " ";
        i = closeEnd;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  return chars.join("");
}

/** Finds the index of the `]` matching the `[` at `start`, honoring nesting and escapes. */
function findMatchingBracket(line: string, start: number): number {
  let depth = 1;
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      depth++;
      i++;
      continue;
    }
    if (c === "]") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/** Finds the next unescaped `]` starting at `start` (no nesting). */
function findSimpleBracketEnd(line: string, start: number): number {
  let i = start;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "]") return i;
    i++;
  }
  return -1;
}

interface InlineDestination {
  url: string;
  endIndex: number; // index of the closing ')'
}

/** Parses a `(url "title")`-style destination starting right after '('. */
function parseInlineDestination(line: string, start: number): InlineDestination | null {
  const len = line.length;
  let i = start;
  let url: string;

  if (line[i] === "<") {
    let end = -1;
    let j = i + 1;
    while (j < len) {
      if (line[j] === "\\") {
        j += 2;
        continue;
      }
      if (line[j] === ">") {
        end = j;
        break;
      }
      j++;
    }
    if (end === -1) return null;
    url = line.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    let j = i;
    let urlEnd = -1;
    while (j < len) {
      const c = line[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "(") {
        depth++;
        j++;
        continue;
      }
      if (c === ")") {
        if (depth === 0) {
          urlEnd = j;
          break;
        }
        depth--;
        j++;
        continue;
      }
      if (WHITESPACE_RE.test(c) && depth === 0) {
        urlEnd = j;
        break;
      }
      j++;
    }
    if (urlEnd === -1) return null;
    url = line.slice(i, urlEnd);
    i = urlEnd;
  }

  while (i < len && WHITESPACE_RE.test(line[i])) i++;

  if (i < len && (line[i] === '"' || line[i] === "'")) {
    const quote = line[i];
    let j = i + 1;
    let closed = false;
    while (j < len) {
      if (line[j] === "\\") {
        j += 2;
        continue;
      }
      if (line[j] === quote) {
        closed = true;
        j++;
        break;
      }
      j++;
    }
    if (!closed) return null;
    i = j;
  } else if (i < len && line[i] === "(") {
    let depth = 1;
    let j = i + 1;
    let closed = false;
    while (j < len) {
      if (line[j] === "\\") {
        j += 2;
        continue;
      }
      if (line[j] === "(") {
        depth++;
        j++;
        continue;
      }
      if (line[j] === ")") {
        depth--;
        j++;
        if (depth === 0) {
          closed = true;
          break;
        }
        continue;
      }
      j++;
    }
    if (!closed) return null;
    i = j;
  }

  while (i < len && WHITESPACE_RE.test(line[i])) i++;
  if (line[i] !== ")") return null;

  return { url: url.trim(), endIndex: i };
}

function makeLink(
  file: string,
  line: number,
  column: number,
  text: string,
  rawUrl: string | null,
  kind: LinkKind,
): Link {
  return { file, line, column, text, rawUrl, kind };
}

/** Tries to parse a `[text](...)` or `[text][id]` link starting at the `[`.
 * Returns the index to resume scanning from, or null if not a valid link. */
function tryParseBracketLink(
  line: string,
  startCol: number,
  bracketIndex: number,
  isImage: boolean,
  lineNo: number,
  filePath: string,
  definitions: Map<string, string>,
  results: Link[],
): number | null {
  const closeIdx = findMatchingBracket(line, bracketIndex);
  if (closeIdx === -1) return null;
  const text = line.slice(bracketIndex + 1, closeIdx);
  const next = line[closeIdx + 1];

  if (next === "(") {
    const dest = parseInlineDestination(line, closeIdx + 2);
    if (!dest) return null;
    const kind: LinkKind = isImage ? "image" : "inline";
    results.push(makeLink(filePath, lineNo, startCol + 1, text, dest.url, kind));
    return dest.endIndex + 1;
  }

  if (next === "[") {
    const idEnd = findSimpleBracketEnd(line, closeIdx + 2);
    if (idEnd === -1) return null;
    const idRaw = line.slice(closeIdx + 2, idEnd);
    const id = normalizeReferenceId(idRaw === "" ? text : idRaw);
    const url = definitions.has(id) ? definitions.get(id)! : null;
    results.push(makeLink(filePath, lineNo, startCol + 1, text, url, "reference"));
    return idEnd + 1;
  }

  return null;
}

function scanLine(
  rawLine: string,
  lineNo: number,
  filePath: string,
  definitions: Map<string, string>,
  results: Link[],
): void {
  const line = maskCodeSpans(rawLine);
  const len = line.length;
  let i = 0;

  while (i < len) {
    const c = line[i];

    if (c === "\\" && i + 1 < len && "[]()".includes(line[i + 1])) {
      i += 2;
      continue;
    }

    if (c === "!" && line[i + 1] === "[") {
      const next = tryParseBracketLink(line, i, i + 1, true, lineNo, filePath, definitions, results);
      if (next !== null) {
        i = next;
        continue;
      }
      i += 1;
      continue;
    }

    if (c === "[") {
      const next = tryParseBracketLink(line, i, i, false, lineNo, filePath, definitions, results);
      if (next !== null) {
        i = next;
        continue;
      }
      i += 1;
      continue;
    }

    if (c === "<") {
      const match = AUTOLINK_RE.exec(line.slice(i));
      if (match) {
        results.push(makeLink(filePath, lineNo, i + 1, match[1], match[1], "autolink"));
        i += match[0].length;
        continue;
      }
      i += 1;
      continue;
    }

    if (line.startsWith("file:///", i)) {
      const match = BARE_FILE_RE.exec(line.slice(i));
      if (match) {
        results.push(makeLink(filePath, lineNo, i + 1, match[0], match[0], "bare"));
        i += match[0].length;
        continue;
      }
      i += 1;
      continue;
    }

    i += 1;
  }
}
