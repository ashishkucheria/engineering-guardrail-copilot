// Exceptions (design §3, §4): the only thing that can waive a violation. Pure, so matching, expiry
// and request validation are unit-tested and the Workflow, the API and the eval share one definition.
//
// Nothing here reads feedback. Rejections, challenges and their reasons can never waive a finding.
import type { Finding } from "./types.ts";

export const MAX_EXCEPTION_DAYS = 90;
export const MAX_JUSTIFICATION_CHARS = 2_000;
export const MIN_JUSTIFICATION_CHARS = 10;
/** Pending requests one person may have waiting at once, so nobody can flood the approvers' queue. */
export const MAX_PENDING_PER_USER = 5;
const MAX_PATTERN_CHARS = 200;
const PATTERN_CHARS = /^[\w./*?@+-]+$/;

/** What the waiver step needs to know about an approved exception. */
export interface ActiveException {
  id: string;
  standardId: string;
  pathPattern: string;
}

export interface ExceptionState {
  status: "pending" | "approved" | "denied" | "revoked";
  expiresAt: string;
}

/** Active means approved and not yet expired. "Expired" is never stored, so it can't go stale. */
export function isActive(e: ExceptionState, now: Date): boolean {
  return e.status === "approved" && Date.parse(e.expiresAt) > now.getTime();
}

export function isExpired(e: ExceptionState, now: Date): boolean {
  return e.status === "approved" && Date.parse(e.expiresAt) <= now.getTime();
}

type GlobToken = { kind: "char"; c: string } | { kind: "one" } | { kind: "seg" } | { kind: "any" } | { kind: "dirs" };

function tokenize(pattern: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      while (pattern[i + 1] === "*") i++; // "***" is the same as "**"
      if (pattern[i + 1] === "/") {
        i++;
        out.push({ kind: "dirs" }); // "**/": nothing, or any run of directories
      } else out.push({ kind: "any" });
    } else if (c === "*") out.push({ kind: "seg" });
    else if (c === "?") out.push({ kind: "one" });
    else out.push({ kind: "char", c });
  }
  return out;
}

/**
 * Path globs: `*` alone means every path; otherwise `**` matches across directories, `*` within one
 * path segment and `?` one character. A pasted snippet's path is "snippet".
 *
 * No regex: the pattern comes from users, and a backtracking regex built from `*a*a*a*a*b` takes
 * exponential time (review of PR #4). This walks the set of reachable path positions one token at
 * a time, so it costs O(pattern length × path length) whatever the pattern is.
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  const n = path.length;
  let cur = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  cur[0] = 1;
  for (const t of tokenize(pattern)) {
    next.fill(0);
    let any = false;
    if (t.kind === "char" || t.kind === "one") {
      for (let j = 0; j < n; j++) {
        if (cur[j] && (t.kind === "char" ? path[j] === t.c : path[j] !== "/")) next[j + 1] = 1;
      }
    } else if (t.kind === "seg" || t.kind === "any") {
      // From any reachable position, extend over any run of characters (no "/" for a segment star).
      let run = false;
      for (let j = 0; j <= n; j++) {
        if (cur[j]) run = true;
        if (run) next[j] = 1;
        if (t.kind === "seg" && j < n && path[j] === "/") run = false;
      }
    } else {
      // "**/": stay put, or jump to just after any later "/".
      let seen = false;
      for (let j = 0; j <= n; j++) {
        if (cur[j] || (seen && j > 0 && path[j - 1] === "/")) next[j] = 1;
        if (cur[j]) seen = true;
      }
    }
    for (let j = 0; j <= n; j++) if (next[j]) { any = true; break; }
    if (!any) return false;
    [cur, next] = [next, cur];
  }
  return cur[n] === 1;
}

/**
 * Mark each finding waived by the first active exception for its standard whose pattern matches its
 * file. Returns new objects; findings are otherwise unchanged (the original stays on record).
 */
export function applyExceptions<F extends Pick<Finding, "standardId" | "file" | "waivedBy">>(findings: F[], active: ActiveException[]): F[] {
  if (active.length === 0) return findings;
  return findings.map((f) => {
    if (f.waivedBy) return f;
    const e = active.find((x) => x.standardId === f.standardId && globMatch(x.pathPattern, f.file));
    return e ? { ...f, waivedBy: e.id } : f;
  });
}

/**
 * A pattern made only of wildcards and slashes, with no literal path text, covers every file (or
 * every file at some depth): treat it as "everywhere". Examples are in the unit tests.
 */
export function isBroadPattern(pattern: string): boolean {
  return /^[*?/]+$/.test(pattern);
}

/**
 * Approving a broad pattern, or any exception to a blocker standard, needs a written decision note
 * (prompt 11). Both stay possible; the approver has to say why on the record.
 */
export function approvalNoteRequirement(pattern: string, severity: string): string | null {
  const reasons = [isBroadPattern(pattern) && `the pattern "${pattern}" covers every path`, severity === "blocker" && "the standard is a blocker"].filter(Boolean);
  return reasons.length ? `Approving needs a decision note because ${reasons.join(" and ")}.` : null;
}

export interface ExceptionRequest {
  findingId: string | null;
  standardId: string;
  pathPattern: string;
  justification: string;
  expiresInDays: number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

/** Shape checks for POST /api/exceptions. Checks that need the database (does the finding exist?) are the caller's. */
export function validateExceptionRequest(body: Record<string, unknown>): Validation<ExceptionRequest> {
  const fail = (message: string): Validation<ExceptionRequest> => ({ ok: false, message });
  const findingId = body.finding_id === undefined || body.finding_id === null ? null : body.finding_id;
  if (findingId !== null && (typeof findingId !== "string" || !findingId)) return fail('"finding_id" must be a finding id when given.');
  if (typeof body.standard_id !== "string" || !/^[A-Z]+-\d{3}$/.test(body.standard_id)) return fail('"standard_id" must be a standard id such as SEC-001.');
  const pattern = typeof body.path_pattern === "string" ? body.path_pattern.trim() : "";
  if (!pattern || pattern.length > MAX_PATTERN_CHARS || !PATTERN_CHARS.test(pattern)) {
    return fail(`"path_pattern" must be a path glob of up to ${MAX_PATTERN_CHARS} characters (letters, digits, . / _ - and * ? wildcards), or "*" for every path.`);
  }
  const justification = typeof body.justification === "string" ? body.justification.trim() : "";
  if (justification.length < MIN_JUSTIFICATION_CHARS || justification.length > MAX_JUSTIFICATION_CHARS) {
    return fail(`"justification" must be ${MIN_JUSTIFICATION_CHARS} to ${MAX_JUSTIFICATION_CHARS} characters explaining why the exception is safe.`);
  }
  const days = body.expires_in_days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_EXCEPTION_DAYS) {
    return fail(`"expires_in_days" is required: a whole number from 1 to ${MAX_EXCEPTION_DAYS}. Every exception expires.`);
  }
  return { ok: true, value: { findingId: findingId as string | null, standardId: body.standard_id, pathPattern: pattern, justification, expiresInDays: days } };
}

export function expiresAt(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
