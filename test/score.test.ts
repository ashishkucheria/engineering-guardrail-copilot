import { describe, expect, it } from "vitest";
import { LINE_TOLERANCE, metrics, scoreCase, summarize, type EvalCase } from "../eval/score.ts";
import type { Finding } from "../core/types.ts";

const scope = new Set(["SEC-001", "MNT-001"]);
const pred = (standardId: string, line: number, over: Partial<Finding> = {}): Finding => ({
  standardId, standardHash: "h", classification: "violation", severity: "major", source: "rule",
  file: "snippet", lineStart: line, lineEnd: line, evidence: "e", explanation: "", impact: "", remediation: "", ...over,
});
const kase = (over: Partial<EvalCase>): EvalCase => ({ id: "c", description: "", input: "x", expected: [], ...over });

describe("scoreCase", () => {
  it(`matches on standard and lines within ±${LINE_TOLERANCE}`, () => {
    const c = kase({ expected: [{ standard_id: "SEC-001", lines: [10, 10] }] });
    expect(scoreCase(c, [pred("SEC-001", 10 + LINE_TOLERANCE)], scope)).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(scoreCase(c, [pred("SEC-001", 10 + LINE_TOLERANCE + 1)], scope)).toMatchObject({ tp: 0, fp: 1, fn: 1 });
    expect(scoreCase(c, [pred("MNT-001", 10)], scope)).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });

  it("matches each expectation at most once", () => {
    const c = kase({ expected: [{ standard_id: "SEC-001", lines: [3, 3] }] });
    expect(scoreCase(c, [pred("SEC-001", 3), pred("SEC-001", 4)], scope)).toMatchObject({ tp: 1, fp: 1, fn: 0 });
  });

  it("respects the expected file when given", () => {
    const c = kase({ expected: [{ standard_id: "SEC-001", file: "a.ts", lines: [1, 1] }] });
    expect(scoreCase(c, [pred("SEC-001", 1, { file: "b.ts" })], scope)).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });

  it("ignores out-of-scope standards on both sides, and never counts suggestions as false positives", () => {
    const c = kase({ expected: [{ standard_id: "REL-002", lines: [1, 1] }] });
    const s = scoreCase(c, [pred("REL-002", 9), pred("SEC-001", 5, { classification: "suggestion" })], scope);
    expect(s).toMatchObject({ tp: 0, fp: 0, fn: 0, suggestions: 1 });
  });

  it("reports must_not_flag violations", () => {
    const c = kase({ must_not_flag: ["SEC-001", "REL-001"] });
    expect(scoreCase(c, [pred("SEC-001", 1)], scope).mustNotFlagViolated).toEqual(["SEC-001"]);
  });
});

describe("metrics and summarize", () => {
  it("computes precision, recall and F1, with n/a when undefined", () => {
    expect(metrics(3, 1, 2)).toMatchObject({ precision: 0.75, recall: 0.6 });
    expect(metrics(3, 1, 2).f1).toBeCloseTo(2 / 3);
    expect(metrics(0, 0, 0)).toMatchObject({ precision: null, recall: null, f1: null });
  });

  it("counts only fully clean cases as clean", () => {
    const cases = [kase({ id: "clean" }), kase({ id: "llm-only", expected: [{ standard_id: "REL-002", lines: [1, 1] }] })];
    const scores = [scoreCase(cases[0]!, [pred("SEC-001", 1)], scope), scoreCase(cases[1]!, [], scope)];
    const s = summarize(cases, scores, scope);
    expect(s.cleanCases).toEqual({ total: 1, withFalsePositive: 1 });
    expect(s.overall).toMatchObject({ tp: 0, fp: 1, fn: 0 });
  });
});
