import type { Coverage, Finding, Verdict } from "./types.ts";

export function isComplete(c: Coverage): boolean {
  return c.skipped.length === 0;
}

/**
 * The verdict is decided here, in code, never by the LLM:
 *   fail        any blocker violation
 *   incomplete  otherwise, if any file was not fully checked (never a silent pass on unread code)
 *   warn        otherwise, if any violation
 *   pass        otherwise
 * Suggestions never affect the verdict. Callers pass only findings that are not waived by an
 * approved exception (PR 3-C); feedback and challenges are not inputs at all.
 */
export function computeVerdict(findings: Pick<Finding, "classification" | "severity">[], coverage: Coverage): Verdict {
  const violations = findings.filter((f) => f.classification === "violation");
  if (violations.some((f) => f.severity === "blocker")) return "fail";
  if (!isComplete(coverage)) return "incomplete";
  if (violations.length > 0) return "warn";
  return "pass";
}
