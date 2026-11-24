// Exceptions from the reviewed repository (design D7): `.guardrail/exceptions.yaml`, read at the base
// commit like the standards, so adding one takes a reviewed merge.
//
//   exceptions:
//     - standard: SEC-002
//       path: scripts/**
//       reason: Build script, input is a constant list. At least 10 characters.
//       approved-by: octocat
//       expires: 2027-01-31        # at most 90 days from the day it is read
//
// An entry that is wrong, expired or unknown is ignored and listed in the summary, never applied: the
// safe direction, and one bad entry doesn't stop reviews (a broken standards file does, because
// without standards there's nothing to review against).
import { parse } from "yaml";
import { MAX_EXCEPTION_DAYS, MAX_JUSTIFICATION_CHARS, MIN_JUSTIFICATION_CHARS, type ActiveException } from "../core/exceptions.ts";
import type { Standard } from "../core/types.ts";

export const MAX_EXCEPTIONS = 200;
export const MAX_EXCEPTIONS_BYTES = 100_000;
export const DEFAULT_EXCEPTIONS_PATH = ".guardrail/exceptions.yaml";

const DAY = 86_400_000;
const PATTERN = /^[\w./*?@+-]{1,200}$/;
const KNOWN = new Set(["standard", "path", "reason", "approved-by", "expires"]);

export interface RepoException extends ActiveException {
  reason: string;
  approvedBy: string;
  /** YYYY-MM-DD; valid through the end of that day (UTC). */
  expires: string;
}

export interface LoadedExceptions {
  active: RepoException[];
  /** Entries that aren't applied, each with the reason; shown in the summary. */
  ignored: string[];
}

export const NO_EXCEPTIONS: LoadedExceptions = { active: [], ignored: [] };

export function parseExceptions(text: string, standards: Pick<Standard, "id">[], now: Date): LoadedExceptions {
  if (new TextEncoder().encode(text).byteLength > MAX_EXCEPTIONS_BYTES) return { active: [], ignored: [`${DEFAULT_EXCEPTIONS_PATH} is over ${MAX_EXCEPTIONS_BYTES / 1000} KB; no exception was applied`] };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { active: [], ignored: [`the exceptions file is not valid YAML (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); no exception was applied`] };
  }
  if (doc === null || doc === undefined) return NO_EXCEPTIONS; // empty file
  const list = (doc as { exceptions?: unknown })?.exceptions;
  if (!Array.isArray(list)) return { active: [], ignored: ['the exceptions file needs a top-level "exceptions:" list; no exception was applied'] };

  const known = new Set(standards.map((s) => s.id));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: LoadedExceptions = { active: [], ignored: [] };
  list.slice(0, MAX_EXCEPTIONS).forEach((raw, i) => {
    const id = `exception-${i + 1}`;
    const bad = (why: string) => void out.ignored.push(`${id}: ${why}`);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not a mapping");
    const e = raw as Record<string, unknown>;
    const unknown = Object.keys(e).filter((k) => !KNOWN.has(k));
    if (unknown.length) return bad(`unknown field(s) ${unknown.join(", ")}`);
    const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
    const standardId = str("standard");
    if (!known.has(standardId)) return bad(`"${standardId || "standard"}" is not one of this repository's standards`);
    const path = str("path");
    if (!PATTERN.test(path) && path !== "*") return bad('"path" must be a path glob (letters, digits, . / _ - and * ? wildcards), or "*"');
    const reason = str("reason");
    if (reason.length < MIN_JUSTIFICATION_CHARS || reason.length > MAX_JUSTIFICATION_CHARS) return bad(`"reason" must be ${MIN_JUSTIFICATION_CHARS} to ${MAX_JUSTIFICATION_CHARS} characters`);
    const approvedBy = str("approved-by");
    if (!approvedBy) return bad('"approved-by" is required');
    const expires = str("expires");
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expires);
    const end = day ? Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!) : NaN;
    if (!day || Number.isNaN(end) || new Date(end).toISOString().slice(0, 10) !== expires) return bad('"expires" must be a date like 2027-01-31');
    if (end + DAY <= now.getTime()) return bad(`expired on ${expires}`);
    if (end > today + MAX_EXCEPTION_DAYS * DAY) return bad(`"expires" is more than ${MAX_EXCEPTION_DAYS} days away`);
    out.active.push({ id, standardId, pathPattern: path, reason, approvedBy, expires });
  });
  if (list.length > MAX_EXCEPTIONS) out.ignored.push(`only the first ${MAX_EXCEPTIONS} exceptions were read`);
  return out;
}

/** Read the file at the base commit. A missing file means no exceptions. */
export async function loadExceptions(
  gh: { getFileText(path: string, ref: string): Promise<string> },
  path: string,
  baseSha: string,
  standards: Pick<Standard, "id">[],
  now: Date,
): Promise<LoadedExceptions> {
  let text: string;
  try {
    text = await gh.getFileText(path, baseSha);
  } catch (e) {
    if ((e as { status?: number })?.status === 404) return NO_EXCEPTIONS;
    throw e;
  }
  return parseExceptions(text, standards, now);
}
