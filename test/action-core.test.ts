// The core changes the PR reviewer needs (design: docs/pr-reviewer-design.md §4 and §5): per-file
// limits, generated files left out of model calls, standards from YAML text, and no retries for
// errors a retry can't fix.
import { describe, expect, it } from "vitest";
import { isGeneratedPath, MAX_FILES, parseInput } from "../core/diff.ts";
import { review } from "../core/engine.ts";
import { llmDetector, type LlmClient } from "../core/llm.ts";
import { parseStandardFiles } from "../core/standards-yaml.ts";
import { diff, std } from "./helpers.ts";

const fileDiff = (path: string, ...added: string[]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`)];

describe("input limits", () => {
  it("keeps today's defaults when no limits are given", () => {
    const parts: string[] = [];
    for (let i = 0; i < MAX_FILES + 1; i++) parts.push(...fileDiff(`f${i}.ts`, "x"));
    expect(parseInput(diff(...parts)).files).toHaveLength(MAX_FILES);
  });

  it("takes a higher file limit", () => {
    const parts: string[] = [];
    for (let i = 0; i < 30; i++) parts.push(...fileDiff(`f${i}.ts`, "x"));
    const p = parseInput(diff(...parts), { maxFiles: 50 });
    expect(p.files).toHaveLength(30);
    expect(p.coverage.skipped).toEqual([]);
  });

  it("skips a file over the per-file size limit and records why, without affecting the others", () => {
    const big = "y".repeat(2_000);
    const p = parseInput(diff(...fileDiff("big.ts", big), ...fileDiff("small.ts", "x")), { maxFileBytes: 1_000 });
    expect(p.files.map((f) => f.path)).toEqual(["small.ts"]);
    expect(p.coverage).toMatchObject({ filesTotal: 2, filesReviewed: 1, skipped: [{ file: "big.ts", reason: "over the 1 KB per-file limit" }] });
  });

  it("exempts generated files from the per-file size limit, so a big lock file isn't a coverage gap", async () => {
    const lock = Array.from({ length: 500 }, (_, i) => `"pkg${i}": { "version": "1.0.${i}" },`);
    const input = diff(...fileDiff("package-lock.json", ...lock), ...fileDiff("src/big.ts", "y".repeat(2_000)));
    const p = parseInput(input, { maxFileBytes: 1_000 });
    expect(p.files.map((f) => f.path)).toEqual(["package-lock.json"]); // kept, so the rules still see it
    expect(p.coverage.skipped).toEqual([{ file: "src/big.ts", reason: "over the 1 KB per-file limit" }]); // a written file over the limit still is a gap
    expect((await review(diff(...fileDiff("package-lock.json", ...lock)), [], undefined, { maxFileBytes: 1_000 })).verdict).toBe("pass");
  });

  it("passes limits through review()", async () => {
    const r = await review(diff(...fileDiff("big.ts", "y".repeat(2_000))), [], undefined, { maxFileBytes: 1_000 });
    expect(r.verdict).toBe("incomplete");
  });
});

describe("isGeneratedPath", () => {
  it("matches lock files, minified files, source maps and build output", () => {
    for (const p of ["package-lock.json", "web/yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock", "app.min.js", "a.js.map", "dist/action/index.js", "vendor/x/y.go"]) expect(isGeneratedPath(p), p).toBe(true);
  });
  it("leaves written code alone", () => {
    for (const p of ["src/lock.ts", "package.json", "src/distance.ts", "builder/x.ts", "README.md"]) expect(isGeneratedPath(p), p).toBe(false);
  });
});

describe("llmDetector", () => {
  const REL2 = std("REL-002", { detector: "llm", severity: "major" });
  const input = diff(...fileDiff("src/a.ts", 'fetch("https://x.example");'), ...fileDiff("package-lock.json", '"lockfileVersion": 3'));

  it("doesn't ask the model about skipped paths, and doesn't count them as gaps", async () => {
    const seen: string[] = [];
    const client: LlmClient = {
      model: "test",
      async json(messages) {
        seen.push(messages.at(-1)!.content);
        return { findings: [] };
      },
    };
    const r = await review(input, [REL2], [llmDetector(client, { skipPath: isGeneratedPath })]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("src/a.ts");
    expect(r.coverage.skipped).toEqual([]);
  });

  it("stops retrying a chunk when the error says a retry can't help", async () => {
    let calls = 0;
    const client: LlmClient = {
      model: "test",
      async json() {
        calls++;
        throw Object.assign(new Error("HTTP 401: invalid key"), { retryable: false });
      },
    };
    const r = await review(diff(...fileDiff("src/a.ts", "x")), [REL2], [llmDetector(client, { attempts: 3 })]);
    expect(calls).toBe(1);
    expect(r.coverage.skipped[0]!.reason).toBe("AI review failed: HTTP 401: invalid key");
  });

  it("still retries other errors", async () => {
    let calls = 0;
    const client: LlmClient = {
      model: "test",
      async json() {
        calls++;
        throw Object.assign(new Error("HTTP 429"), { retryable: true });
      },
    };
    await review(diff(...fileDiff("src/a.ts", "x")), [REL2], [llmDetector(client, { attempts: 3 })]);
    expect(calls).toBe(3);
  });
});

describe("parseStandardFiles", () => {
  const yaml = (id: string, extra = "") => `id: ${id}\ntitle: T\nseverity: major\ndetector: llm\nrule: R\n${extra}`;

  it("validates, hashes and sorts standards, ignoring files that aren't .yaml", async () => {
    const s = await parseStandardFiles([
      { name: "REL-002.yaml", text: yaml("REL-002") },
      { name: "README.md", text: "# notes" },
      { name: "REL-001.yaml", text: yaml("REL-001") },
    ]);
    expect(s.map((x) => x.id)).toEqual(["REL-001", "REL-002"]);
    expect(s.every((x) => x.enabled && /^[0-9a-f]{16}$/.test(x.contentHash))).toBe(true);
  });

  it("fails loudly, naming the file, on bad YAML, a bad field, a name mismatch, or no standards", async () => {
    await expect(parseStandardFiles([{ name: "REL-001.yaml", text: "id: [unclosed" }])).rejects.toThrow(/REL-001.yaml: invalid YAML/);
    await expect(parseStandardFiles([{ name: "REL-001.yaml", text: yaml("REL-001", "owner: me\n") }])).rejects.toThrow(/unknown field/);
    await expect(parseStandardFiles([{ name: "other.yaml", text: yaml("REL-001") }])).rejects.toThrow(/must match id/);
    await expect(parseStandardFiles([{ name: "README.md", text: "" }])).rejects.toThrow(/no standards/);
  });
});
