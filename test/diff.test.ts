import { describe, expect, it } from "vitest";
import { isTestPath, looksLikeDiff, MAX_FILES, parseInput } from "../core/diff.ts";
import { diff } from "./helpers.ts";

describe("parseInput", () => {
  it("treats plain code as a single snippet where every line is added", () => {
    const p = parseInput("const a = 1;\nconst b = 2;\n\n");
    expect(p.kind).toBe("snippet");
    expect(p.files).toHaveLength(1);
    expect(p.files[0]!.lines.map((l) => [l.n, l.added])).toEqual([[1, true], [2, true]]);
    expect(p.coverage).toEqual({ filesTotal: 1, filesReviewed: 1, skipped: [] });
  });

  it("numbers diff lines by the NEW file, skipping removed lines", () => {
    const p = parseInput(
      diff("diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,3 @@", " keep", "-old", "+new", " tail"),
    );
    expect(p.kind).toBe("diff");
    expect(p.files[0]!.path).toBe("src/a.ts");
    expect(p.files[0]!.lines).toEqual([
      { n: 10, text: "keep", added: false },
      { n: 11, text: "new", added: true },
      { n: 12, text: "tail", added: false },
    ]);
  });

  it("handles several hunks and several files without git headers", () => {
    const p = parseInput(
      diff("--- a/one.ts", "+++ b/one.ts", "@@ -1,1 +1,2 @@", " a", "+b", "@@ -20,1 +21,2 @@", " c", "+d", "--- a/two.ts", "+++ b/two.ts", "@@ -5 +5 @@", "-x", "+y"),
    );
    expect(p.files.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
    expect(p.files[0]!.lines.filter((l) => l.added).map((l) => l.n)).toEqual([2, 22]);
    expect(p.files[1]!.lines).toEqual([{ n: 5, text: "y", added: true }]);
  });

  it("ignores deleted files and lists binary files as not reviewed, without a coverage gap", () => {
    const p = parseInput(
      diff(
        "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
        "diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/ok.ts b/ok.ts", "--- a/ok.ts", "+++ b/ok.ts", "@@ -1 +1 @@", "+ok",
      ),
    );
    expect(p.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(p.coverage.filesTotal).toBe(2);
    expect(p.coverage.skipped).toEqual([]);
    expect(p.coverage.notReviewed).toEqual([{ file: "logo.png", reason: "binary file" }]);
  });

  it(`records files past the ${MAX_FILES}-file limit instead of dropping them silently`, () => {
    const parts: string[] = [];
    for (let i = 0; i < MAX_FILES + 3; i++) parts.push(`diff --git a/f${i}.ts b/f${i}.ts`, `--- a/f${i}.ts`, `+++ b/f${i}.ts`, "@@ -1 +1 @@", "+x");
    const p = parseInput(diff(...parts));
    expect(p.files).toHaveLength(MAX_FILES);
    expect(p.coverage.filesTotal).toBe(MAX_FILES + 3);
    expect(p.coverage.skipped).toHaveLength(3);
  });

  it("accepts Windows line endings", () => {
    const p = parseInput("--- a/x.ts\r\n+++ b/x.ts\r\n@@ -1 +1 @@\r\n+y\r\n");
    expect(p.files[0]!.lines).toEqual([{ n: 1, text: "y", added: true }]);
  });
});

describe("helpers", () => {
  it("detects diffs", () => {
    expect(looksLikeDiff("@@ -1 +1 @@\n+x")).toBe(true);
    expect(looksLikeDiff("const x = a - b;\n// --- separator")).toBe(false);
  });

  it("recognises test files", () => {
    for (const p of ["src/a.test.ts", "tests/a.ts", "pkg/__tests__/a.js", "x_test.go", "test_x.py", "a.spec.tsx"]) expect(isTestPath(p), p).toBe(true);
    for (const p of ["src/attest.ts", "src/contest/a.ts", "testing.md"]) expect(isTestPath(p), p).toBe(false);
  });
});
