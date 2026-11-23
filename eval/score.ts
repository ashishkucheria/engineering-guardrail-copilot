// Pure scoring for the eval harness. No I/O, so the scorer itself is unit-tested.
//
// Matching rule: a predicted VIOLATION is a true positive when an unmatched expected entry has the
// same standard and the predicted lines overlap the expected range widened by LINE_TOLERANCE.
// Suggestions are counted separately and never as false positives. Standards outside the config's
// scope (e.g. LLM standards when only rules run) are ignored on both sides.
import type { Finding } from "../core/types.ts";

export const LINE_TOLERANCE = 2;

export interface ExpectedFinding {
  standard_id: string;
  file?: string;
  lines: [number, number];
}

export interface EvalCase {
  id: string;
  description: string;
  input: string;
  expected: ExpectedFinding[];
  /** Standards that must produce no violation in this case (a labelled clean area). */
  must_not_flag?: string[];
  tags?: string[];
}

export interface CaseScore {
  caseId: string;
  tp: number;
  fp: number;
  fn: number;
  suggestions: number;
  /** Per-standard counts within this case. */
  byStandard: Record<string, { tp: number; fp: number; fn: number }>;
  falsePositives: Pick<Finding, "standardId" | "file" | "lineStart" | "lineEnd" | "evidence">[];
  missed: ExpectedFinding[];
  mustNotFlagViolated: string[];
}

export function scoreCase(c: EvalCase, predicted: Finding[], inScope: Set<string>): CaseScore {
  const expected = c.expected.filter((e) => inScope.has(e.standard_id));
  const violations = predicted.filter((f) => f.classification === "violation" && inScope.has(f.standardId));
  const suggestions = predicted.filter((f) => f.classification === "suggestion" && inScope.has(f.standardId)).length;

  const byStandard: CaseScore["byStandard"] = {};
  const bump = (id: string, k: "tp" | "fp" | "fn") => ((byStandard[id] ??= { tp: 0, fp: 0, fn: 0 })[k] += 1);

  const matched = new Set<number>();
  const falsePositives: CaseScore["falsePositives"] = [];
  for (const f of violations) {
    const i = expected.findIndex(
      (e, idx) =>
        !matched.has(idx) &&
        e.standard_id === f.standardId &&
        (e.file === undefined || e.file === f.file) &&
        f.lineStart <= e.lines[1] + LINE_TOLERANCE &&
        f.lineEnd >= e.lines[0] - LINE_TOLERANCE,
    );
    if (i >= 0) {
      matched.add(i);
      bump(f.standardId, "tp");
    } else {
      bump(f.standardId, "fp");
      falsePositives.push({ standardId: f.standardId, file: f.file, lineStart: f.lineStart, lineEnd: f.lineEnd, evidence: f.evidence });
    }
  }
  const missed = expected.filter((_, idx) => !matched.has(idx));
  for (const m of missed) bump(m.standard_id, "fn");

  const mustNotFlagViolated = (c.must_not_flag ?? []).filter((id) => inScope.has(id) && violations.some((v) => v.standardId === id));

  return {
    caseId: c.id,
    tp: matched.size,
    fp: falsePositives.length,
    fn: missed.length,
    suggestions,
    byStandard,
    falsePositives,
    missed,
    mustNotFlagViolated,
  };
}

export interface Metrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function metrics(tp: number, fp: number, fn: number): Metrics {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

export interface Summary {
  overall: Metrics;
  byStandard: Record<string, Metrics>;
  /** Cases labelled with no findings: how many produced any in-scope violation. */
  cleanCases: { total: number; withFalsePositive: number };
  mustNotFlagFailures: { caseId: string; standards: string[] }[];
}

export function summarize(cases: EvalCase[], scores: CaseScore[], inScope: Set<string>): Summary {
  const totals: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const s of scores) {
    for (const [id, c] of Object.entries(s.byStandard)) {
      const t = (totals[id] ??= { tp: 0, fp: 0, fn: 0 });
      t.tp += c.tp;
      t.fp += c.fp;
      t.fn += c.fn;
    }
  }
  const byStandard = Object.fromEntries([...inScope].sort().map((id) => [id, metrics(totals[id]?.tp ?? 0, totals[id]?.fp ?? 0, totals[id]?.fn ?? 0)]));
  const sum = (k: "tp" | "fp" | "fn") => scores.reduce((n, s) => n + s[k], 0);
  // A clean case is one labelled with no findings at all. (A case whose only expectations are out of
  // scope is not "clean"; it just isn't scored by this config.)
  const clean = cases.filter((c) => c.expected.length === 0);
  return {
    overall: metrics(sum("tp"), sum("fp"), sum("fn")),
    byStandard,
    cleanCases: { total: clean.length, withFalsePositive: clean.filter((c) => (scores.find((s) => s.caseId === c.id)?.fp ?? 0) > 0).length },
    mustNotFlagFailures: scores.filter((s) => s.mustNotFlagViolated.length).map((s) => ({ caseId: s.caseId, standards: s.mustNotFlagViolated })),
  };
}
