// The review engine: parse → run detectors → de-duplicate → verdict.
// The Worker, the eval runner and the tests all call `review()`, so what the eval measures is what
// the app runs. PR 3-B adds an LLM detector behind the same `Detector` interface.
import { parseInput } from "./diff.ts";
import { runRules } from "./rules.ts";
import { computeVerdict } from "./verdict.ts";
import type { Coverage, Finding, ParsedInput, Standard, Verdict } from "./types.ts";

export interface DetectorResult {
  findings: Finding[];
  /** Files the detector could not fully check; they make the verdict `incomplete`. */
  skipped?: Coverage["skipped"];
}

export interface Detector {
  name: string;
  detect(input: ParsedInput, enabled: Standard[]): Promise<DetectorResult>;
}

export const ruleDetector: Detector = {
  name: "rules",
  async detect(input, enabled) {
    return { findings: runRules(input, enabled) };
  },
};

export interface ReviewResult {
  input: ParsedInput;
  findings: Finding[];
  coverage: Coverage;
  verdict: Verdict;
  engine: string;
}

export async function review(raw: string, standards: Standard[], detectors: Detector[] = [ruleDetector]): Promise<ReviewResult> {
  const input = parseInput(raw);
  const enabled = standards.filter((s) => s.enabled);
  const coverage: Coverage = { ...input.coverage, skipped: [...input.coverage.skipped] };
  const all: Finding[] = [];
  for (const d of detectors) {
    const r = await d.detect(input, enabled);
    all.push(...r.findings);
    for (const s of r.skipped ?? []) coverage.skipped.push(s);
  }
  const findings = dedupe(all).sort((a, b) => a.file.localeCompare(b.file) || a.lineStart - b.lineStart || a.standardId.localeCompare(b.standardId));
  return { input, findings, coverage, verdict: computeVerdict(findings, coverage), engine: detectors.map((d) => d.name).join("+") };
}

/**
 * Same standard, same file, overlapping lines → one finding. A rule finding wins over an LLM one
 * (it is deterministic), then a violation over a suggestion. Rule findings are never merged with
 * each other: a rule reports each distinct hit (e.g. two secrets on one line) on purpose.
 */
export function dedupe(findings: Finding[]): Finding[] {
  const rank = (f: Finding) => (f.source === "rule" ? 0 : 2) + (f.classification === "violation" ? 0 : 1);
  const sorted = [...findings].sort((a, b) => rank(a) - rank(b));
  const kept: Finding[] = [];
  for (const f of sorted) {
    const dup = kept.some(
      (k) =>
        !(k.source === "rule" && f.source === "rule") &&
        k.standardId === f.standardId &&
        k.file === f.file &&
        k.lineStart <= f.lineEnd &&
        f.lineStart <= k.lineEnd,
    );
    if (!dup) kept.push(f);
  }
  return kept;
}
