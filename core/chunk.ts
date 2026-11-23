// Splits reviewed files into chunks small enough for one LLM call (design §5, review item 3).
// Files are chunked, never truncated: each chunk holds at most MAX_CHUNK_CHARS of rendered code,
// split at line boundaries, with CHUNK_OVERLAP_LINES of overlap so a construct crossing a boundary
// is seen whole by at least one chunk. Past MAX_CHUNKS, the rest is a coverage gap.
import type { Coverage, FileChunk, ParsedInput, SourceLine } from "./types.ts";

export const MAX_CHUNK_CHARS = 8_000;
export const CHUNK_OVERLAP_LINES = 15;
export const MAX_CHUNKS = 40;

export interface CodeChunk {
  path: string;
  /** 1-based index within the file, and how many chunks the file has. */
  part: number;
  parts: number;
  lines: SourceLine[];
}

export interface ChunkPlan {
  chunks: CodeChunk[];
  skipped: Coverage["skipped"];
}

/** How a line is shown to the model: number, a `+` on lines the change adds, then the code. */
export function renderLine(l: SourceLine): string {
  return `${l.n}${l.added ? "+" : " "}| ${l.text}`;
}

export function chunkFile(file: FileChunk, maxChars = MAX_CHUNK_CHARS, overlap = CHUNK_OVERLAP_LINES): CodeChunk[] {
  const out: SourceLine[][] = [];
  let start = 0;
  while (start < file.lines.length) {
    let end = start;
    let size = 0;
    // Always take at least one line, even a very long one, so the loop makes progress.
    while (end < file.lines.length && (end === start || size + renderLine(file.lines[end]!).length + 1 <= maxChars)) {
      size += renderLine(file.lines[end]!).length + 1;
      end++;
    }
    out.push(file.lines.slice(start, end));
    if (end >= file.lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return out.map((lines, i) => ({ path: file.path, part: i + 1, parts: out.length, lines }));
}

/**
 * Chunks to send to the model. A chunk with no added line is not sent: in a diff, unchanged context
 * can only ever produce "pre-existing" suggestions, so it isn't worth a model call or a budget slot.
 * That is not a coverage gap, because nothing the change adds goes unread.
 */
export function planChunks(input: ParsedInput, maxChunks = MAX_CHUNKS): ChunkPlan {
  const chunks: CodeChunk[] = [];
  const skipped: Coverage["skipped"] = [];
  for (const file of input.files) {
    const parts = chunkFile(file).filter((c) => c.lines.some((l) => l.added));
    for (const c of parts) {
      if (chunks.length < maxChunks) chunks.push(c);
      else skipped.push({ file: chunkLabel(c), reason: `over the ${maxChunks}-chunk limit for AI review` });
    }
  }
  return { chunks, skipped };
}

export function chunkLabel(c: Pick<CodeChunk, "path" | "part" | "parts">): string {
  return c.parts > 1 ? `${c.path}#${c.part}/${c.parts}` : c.path;
}
