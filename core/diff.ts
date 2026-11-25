import type { Coverage, FileChunk, ParsedInput, SourceLine } from "./types.ts";

export const MAX_INPUT_BYTES = 100_000;
export const MAX_FILES = 20;
export const SNIPPET_PATH = "snippet";

/** Captures: old line count, new start line, new line count (a count left out means 1). */
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A unified diff has file headers or hunk headers; anything else is treated as a snippet. */
export function looksLikeDiff(input: string): boolean {
  return /^diff --git /m.test(input) || (/^--- /m.test(input) && /^\+\+\+ /m.test(input)) || /^@@ -\d+/m.test(input);
}

export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|spec)\//i.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
    /_test\.(go|py)$/i.test(path) ||
    /(^|\/)test_[^/]+\.py$/i.test(path)
  );
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|cs|php|swift|scala)$/i;
export function isCodePath(path: string): boolean {
  return CODE_EXT.test(path);
}

/**
 * Lock files, minified bundles and build output: generated, not written, so the model isn't asked
 * about them (the Action passes this as the LLM detector's skipPath).
 */
export function isGeneratedPath(path: string): boolean {
  return (
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/.test(path) ||
    /\.min\.(js|css)$/i.test(path) ||
    /\.map$/i.test(path) ||
    /(^|\/)(dist|build|vendor|node_modules)\//.test(path)
  );
}

export interface InputLimits {
  /** Files reviewed; the rest are coverage gaps. Default MAX_FILES (the app's pasted-input limit). */
  maxFiles?: number;
  /** Per-file limit on the new code's size, for the Action (generated files are exempt). Default: none (the app limits the whole input). */
  maxFileBytes?: number;
}

/**
 * Parse pasted input into files with new-file line numbers.
 * - Snippet: one file, every line counts as added.
 * - Diff: removed lines are dropped (they are not in the new code), context lines are kept with
 *   `added: false`, deleted files are ignored, binary files are listed as not reviewed (not a gap:
 *   no standard reads them), and files past the file limit (or over the per-file size limit, when one
 *   is set) are recorded as skipped.
 */
export function parseInput(input: string, limits: InputLimits = {}): ParsedInput {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const text = input.replace(/\r\n?/g, "\n");
  if (!looksLikeDiff(text)) {
    const lines = text.split("\n").map((t, i): SourceLine => ({ n: i + 1, text: t, added: true }));
    while (lines.length && lines[lines.length - 1]!.text === "") lines.pop();
    return {
      kind: "snippet",
      files: [{ path: SNIPPET_PATH, lines, isTest: false }],
      coverage: { filesTotal: 1, filesReviewed: 1, skipped: [] },
    };
  }

  const raw = splitDiffFiles(text);
  const coverage: Coverage = { filesTotal: 0, filesReviewed: 0, skipped: [] };
  const files: FileChunk[] = [];
  for (const f of raw) {
    if (f.deleted) continue; // nothing left to review
    coverage.filesTotal++;
    if (f.binary) {
      (coverage.notReviewed ??= []).push({ file: f.path, reason: "binary file" });
      continue;
    }
    if (files.length >= maxFiles) {
      coverage.skipped.push({ file: f.path, reason: `over the ${maxFiles}-file limit` });
      continue;
    }
    // Generated files (a big lock file) are exempt: the model skips them anyway, so the size limit
    // would only turn every PR that touches one into a coverage gap.
    if (limits.maxFileBytes !== undefined && !isGeneratedPath(f.path) && fileBytes(f.lines) > limits.maxFileBytes) {
      coverage.skipped.push({ file: f.path, reason: `over the ${Math.round(limits.maxFileBytes / 1000)} KB per-file limit` });
      continue;
    }
    files.push({ path: f.path, lines: f.lines, isTest: isTestPath(f.path) });
    coverage.filesReviewed++;
  }
  return { kind: "diff", files, coverage };
}

interface RawFile {
  path: string;
  lines: SourceLine[];
  deleted: boolean;
  binary: boolean;
}

function splitDiffFiles(text: string): RawFile[] {
  const out: RawFile[] = [];
  let cur: RawFile | null = null;
  let newLine = 0;
  let inHunk = false;
  // Lines the current hunk's header still promises, old side and new side.
  let oldLeft = 0;
  let newLeft = 0;

  const start = (path: string) => {
    cur = { path, lines: [], deleted: false, binary: false };
    out.push(cur);
    inHunk = false;
  };

  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop(); // the newline that ends the last line is not a line
  let headerOpen = false; // a "diff --git" line was seen and its "---/+++" pair hasn't been yet
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      start(git[2]!);
      headerOpen = true;
      continue;
    }
    // "--- x" followed by "+++ y" is a file header, even straight after another file's hunk. Inside a
    // hunk that still expects a removed and an added line it is exactly those: a removed "-- x" and an
    // added "++ y". Reading that pair as a header would let a change rename the rest of its own file
    // (to a path the model skips, or one an exception waives).
    const insideHunk = inHunk && oldLeft > 0 && newLeft > 0;
    if (!insideHunk && line.startsWith("--- ") && all[i + 1]?.startsWith("+++ ")) {
      const target = all[i + 1]!.slice(4).trim();
      if (!headerOpen) start(stripPrefix(target === "/dev/null" ? line.slice(4) : target));
      headerOpen = false;
      inHunk = false;
      if (target === "/dev/null") cur!.deleted = true;
      else cur!.path = stripPrefix(target);
      i++; // consume the "+++" line
      continue;
    }
    if (!cur) {
      if (HUNK.test(line)) start(SNIPPET_PATH);
      else continue;
    }
    const c: RawFile = cur!;
    if (/^Binary files .* differ$/.test(line) || line.startsWith("GIT binary patch")) {
      c.binary = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      c.deleted = true;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // index lines, mode lines, etc.
    // The counts only decide the header question above; a hunk with more lines than its header says
    // (a hand-edited diff) is still read to its end.
    if (line.startsWith("+")) {
      c.lines.push({ n: newLine++, text: line.slice(1), added: true });
      newLeft--;
    } else if (line.startsWith(" ") || line === "") {
      c.lines.push({ n: newLine++, text: line.slice(1), added: false });
      oldLeft--;
      newLeft--;
    } else if (line.startsWith("-")) oldLeft--; // removed line
    else if (line.startsWith("\\")) continue; // "No newline at end of file"
    else inHunk = false; // something else: the hunk is over
  }
  return out;
}

function fileBytes(lines: SourceLine[]): number {
  const enc = new TextEncoder();
  return lines.reduce((n, l) => n + enc.encode(l.text).byteLength + 1, 0);
}

function stripPrefix(p: string): string {
  return p.trim().replace(/^[ab]\//, "").split("\t")[0]!;
}
