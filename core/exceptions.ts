// Exceptions (design §3, §4): the only thing that can waive a violation. Pure, so matching, expiry
// and request validation are unit-tested and the Workflow, the API and the eval share one definition.
//
// Nothing here reads feedback. Rejections, challenges and their reasons can never waive a finding.
import type { Finding } from "./types.ts";

export const MAX_EXCEPTION_DAYS = 90;
export const MAX_JUSTIFICATION_CHARS = 2_000;
export const MIN_JUSTIFICATION_CHARS = 10;
const MAX_PATTERN_CHARS = 200;
const PATTERN_CHARS = /^[\w./*?@+-]+$/;

/** What the waiver step needs to know about an approved exception. */
export interface ActiveException {
  id: string;
  standardId: string;
  pathPattern: string;
}

export interface ExceptionState {
  status: "pending" | "approved" | "denied";
  expiresAt: string;
}

/** Active means approved and not yet expired. "Expired" is never stored, so it can't go stale. */
export function isActive(e: ExceptionState, now: Date): boolean {
  return e.status === "approved" && Date.parse(e.expiresAt) > now.getTime();
}

export function isExpired(e: ExceptionState, now: Date): boolean {
  return e.status === "approved" && Date.parse(e.expiresAt) <= now.getTime();
}

/**
 * Path globs: `*` alone means every path; otherwise `**` matches across directories, `*` within one
 * path segment and `?` one character. A pasted snippet's path is "snippet".
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
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
