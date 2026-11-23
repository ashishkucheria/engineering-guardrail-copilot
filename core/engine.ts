// The review engine: parse → run detectors → finalize (de-duplicate, cap, verdict).
// The eval runner and the tests call `review()`. The Workflow runs the same pieces as separate steps
// (parseInput, runRules, the LLM detector's chunks) and then the same `finalize()`, so what the eval
// measures is what the app runs.
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
  /** `raw` is the input as pasted, for detectors that run elsewhere (the eval's remote detector). */
  detect(input: ParsedInput, enabled: Standard[], raw: string): Promise<DetectorResult>;
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
  const skipped: Coverage["skipped"] = [];
  const all: Finding[] = [];
  for (const d of detectors) {
    const r = await d.detect(input, enabled, raw);
    all.push(...r.findings);
    skipped.push(...(r.skipped ?? []));
  }
  return { input, ...finalize(input, all, skipped), engine: detectors.map((d) => d.name).join("+") };
}

/** Findings kept per review (design §5). Past this the rest are dropped and the gap is recorded. */
export const MAX_FINDINGS = 200;

/**
 * The last step for every path: de-duplicate, order, cap, and compute the verdict from what's left.
 * Dropping findings over the cap is recorded in coverage, so the verdict can't be `pass`.
 */
export function finalize(input: ParsedInput, all: Finding[], extraSkipped: Coverage["skipped"]): { findings: Finding[]; coverage: Coverage; verdict: Verdict } {
  const coverage: Coverage = { ...input.coverage, skipped: [...input.coverage.skipped, ...extraSkipped] };
  let findings = dedupe(all).sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.lineStart - b.lineStart ||
      a.standardId.localeCompare(b.standardId) ||
      a.source.localeCompare(b.source) ||
      a.evidence.localeCompare(b.evidence),
  );
  if (findings.length > MAX_FINDINGS) {
    // Keep the most important ones: violations before suggestions, then by severity.
    const sev = { blocker: 0, major: 1, minor: 2 } as const;
    const kept = new Set(
      [...findings]
        .sort((a, b) => (a.classification === b.classification ? 0 : a.classification === "violation" ? -1 : 1) || sev[a.severity] - sev[b.severity])
        .slice(0, MAX_FINDINGS),
    );
    coverage.skipped.push({ file: "(whole review)", reason: `${findings.length - MAX_FINDINGS} finding(s) over the ${MAX_FINDINGS}-finding cap were dropped` });
    findings = findings.filter((f) => kept.has(f));
  }
  return { findings, coverage, verdict: computeVerdict(findings, coverage) };
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
