import { describe, expect, it } from "vitest";
import { contentHash, parseStandard, snapshotOf } from "../core/standards.ts";
import { RULES } from "../core/rules.ts";
import { loadStandards } from "../scripts/load-standards.ts";
import { std } from "./helpers.ts";

const base = { id: "ABC-001", title: "T", severity: "major", detector: "llm", rule: "R" };

describe("standards/*.yaml", () => {
  it("all load, validate and have unique hashes", async () => {
    const all = await loadStandards();
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(new Set(all.map((s) => s.contentHash)).size).toBe(all.length);
  });

  it("every rule-detected standard has a rule implementation", async () => {
    for (const s of await loadStandards()) {
      if (s.detector !== "llm") expect(RULES[s.id], s.id).toBeTypeOf("function");
    }
  });
});

describe("parseStandard", () => {
  it("rejects bad severity, detector, id and unknown fields", () => {
    expect(() => parseStandard({ ...base, severity: "critical" })).toThrow(/severity/);
    expect(() => parseStandard({ ...base, detector: "ml" })).toThrow(/detector/);
    expect(() => parseStandard({ ...base, id: "abc-1" })).toThrow(/id/);
    expect(() => parseStandard({ ...base, enabled: false })).toThrow(/unknown field/);
    expect(() => parseStandard({ ...base, rule: "  " })).toThrow(/rule/);
  });
});

describe("contentHash", () => {
  it("changes when content changes, and only then", async () => {
    const a = parseStandard(base);
    expect(await contentHash(a)).toBe(await contentHash({ ...a }));
    expect(await contentHash({ ...a, rule: "R2" })).not.toBe(await contentHash(a));
    expect(await contentHash({ ...a, severity: "minor" })).not.toBe(await contentHash(a));
  });
});

describe("snapshotOf", () => {
  it("records every standard, enabled or not, with its version", () => {
    const snap = snapshotOf([std("B-001", { enabled: false }), std("A-001")]);
    expect(snap).toEqual([
      { id: "A-001", contentHash: "hash-A-001", severity: "major", enabled: true },
      { id: "B-001", contentHash: "hash-B-001", severity: "major", enabled: false },
    ]);
  });
});
