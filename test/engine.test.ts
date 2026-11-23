import { describe, expect, it } from "vitest";
import { dedupe, review, type Detector } from "../core/engine.ts";
import { computeVerdict } from "../core/verdict.ts";
import { canToggleStandard } from "../core/policy.ts";
import type { Coverage, Finding } from "../core/types.ts";
import { ALL_RULES } from "./helpers.ts";

const complete: Coverage = { filesTotal: 1, filesReviewed: 1, skipped: [] };
const partial: Coverage = { filesTotal: 2, filesReviewed: 1, skipped: [{ file: "b.ts", reason: "x" }] };
const f = (over: Partial<Finding>): Finding => ({
  standardId: "SEC-001", standardHash: "h", classification: "violation", severity: "major", source: "rule",
  file: "a.ts", lineStart: 1, lineEnd: 1, evidence: "e", explanation: "", impact: "", remediation: "", ...over,
});

describe("computeVerdict", () => {
  it("fails on any blocker violation, even with incomplete coverage", () => {
    expect(computeVerdict([f({ severity: "blocker" })], partial)).toBe("fail");
  });
  it("is incomplete, never pass, when code was not fully read", () => {
    expect(computeVerdict([], partial)).toBe("incomplete");
    expect(computeVerdict([f({ severity: "minor" })], partial)).toBe("incomplete");
  });
  it("warns on non-blocker violations and passes when clean", () => {
    expect(computeVerdict([f({ severity: "major" })], complete)).toBe("warn");
    expect(computeVerdict([], complete)).toBe("pass");
  });
  it("ignores suggestions, whatever their severity", () => {
    expect(computeVerdict([f({ classification: "suggestion", severity: "blocker" })], complete)).toBe("pass");
  });
});

describe("dedupe", () => {
  it("keeps the rule finding when rule and LLM report the same lines", () => {
    const out = dedupe([f({ source: "llm", lineStart: 2, lineEnd: 4 }), f({ source: "rule", lineStart: 3, lineEnd: 3 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("rule");
  });
  it("never merges two rule findings (e.g. two secrets on one line)", () => {
    expect(dedupe([f({ explanation: "a" }), f({ explanation: "b" })])).toHaveLength(2);
  });
  it("keeps findings on different lines, files or standards", () => {
    expect(dedupe([f({}), f({ lineStart: 9, lineEnd: 9 }), f({ file: "b.ts" }), f({ standardId: "MNT-001" })])).toHaveLength(4);
  });
});

describe("review", () => {
  it("runs end to end on a diff and reports engine, coverage and verdict", async () => {
    const r = await review(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", "+// TODO: later", '+const apiKey = "demo-0000-not-a-real-key-9f8e7d";'].join("\n"),
      ALL_RULES,
    );
    expect(r.engine).toBe("rules");
    expect(r.findings.map((x) => x.standardId)).toEqual(["MNT-001", "SEC-001"]);
    expect(r.verdict).toBe("fail");
  });

  it("turns a detector's skipped files into an incomplete verdict", async () => {
    const flaky: Detector = { name: "flaky", detect: async () => ({ findings: [], skipped: [{ file: "snippet", reason: "model unavailable" }] }) };
    const r = await review("const a = 1;", ALL_RULES, [flaky]);
    expect(r.verdict).toBe("incomplete");
    expect(r.coverage.skipped).toEqual([{ file: "snippet", reason: "model unavailable" }]);
  });

  it("does not run disabled standards", async () => {
    const r = await review("// TODO: x", ALL_RULES.map((s) => ({ ...s, enabled: false })));
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("pass");
  });
});

describe("policy", () => {
  it("only approvers can toggle standards", () => {
    expect(canToggleStandard({ id: "a", name: "A", role: "approver" })).toEqual({ ok: true });
    expect(canToggleStandard({ id: "d", name: "D", role: "developer" })).toMatchObject({ ok: false, code: "forbidden" });
  });
});
