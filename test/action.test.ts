// The Action end to end, with GitHub and the model mocked: reading the PR, the standards at the base
// commit, gating, the check run and comment, forks, the AI-call cap and the escaping of model text.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubClient, assembleDiff, type Annotation, type Comment, type DirEntry, type PullFile } from "../action/github.ts";
import { readInputs, readPullRequest } from "../action/main.ts";
import type { FetchFn } from "../action/providers/http.ts";
import { annotationsFor, checkTitle, clean, codeBlock, countFindings, gate, renderSummary, SUMMARY_MARKER, type Report } from "../action/publish.ts";
import { countingFetch, reviewPullRequest, upsertSummaryComment, type Deps, type Inputs, type PrContext } from "../action/run.ts";
import { getBoolean, getChoice, getInput, getPositiveInt, setOutput } from "../action/runner.ts";
import { loadStandards } from "../action/standards.ts";
import type { LlmClient } from "../core/llm.ts";
import type { Finding } from "../core/types.ts";

// --- Helpers ---------------------------------------------------------------------------------

const KEY = "sk-test-not-a-real-key";
const SECRET_LINE = 'const apiKey = "abcd1234abcd1234";';
const FETCH_LINE = 'return fetch("https://x.example/a");';

const added = (filename: string, ...lines: string[]): PullFile => ({
  filename,
  status: "added",
  changes: lines.length,
  patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
});

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  provider: "none",
  model: "",
  apiKey: "",
  baseUrl: "",
  cloudflareAccountId: "",
  standardsPath: ".guardrail/standards",
  failOn: "none",
  failOnIncomplete: false,
  checkRun: true,
  summaryComment: true,
  maxAiCalls: 20,
  maxFiles: 50,
  ...over,
});

const pr = (over: Partial<PrContext> = {}): PrContext => ({ number: 7, headSha: "h".repeat(40), baseSha: "b".repeat(40), eventName: "pull_request", isFork: false, ...over });

interface Recorded {
  checkRuns: { headSha: string; conclusion: string; title: string; summary: string; annotations: Annotation[] }[];
  created: string[];
  updated: { id: number; body: string }[];
  dirRefs: string[];
  summaries: string[];
  warnings: string[];
}

function harness(over: { files?: PullFile[]; dir?: DirEntry[] | null; fileText?: Record<string, string>; comments?: Comment[]; checkRunError?: Error; makeClient?: Deps["makeClient"]; fetch?: FetchFn } = {}) {
  const rec: Recorded = { checkRuns: [], created: [], updated: [], dirRefs: [], summaries: [], warnings: [] };
  const deps: Deps = {
    github: {
      listPullFiles: async () => over.files ?? [],
      listDirectory: async (_p, ref) => (rec.dirRefs.push(ref), over.dir === undefined ? null : over.dir),
      getFileText: async (p) => over.fileText?.[p] ?? "",
      createCheckRun: async (i) => {
        if (over.checkRunError) throw over.checkRunError;
        rec.checkRuns.push(i);
        return 1;
      },
      listIssueComments: async () => over.comments ?? [],
      createComment: async (_n, body) => void rec.created.push(body),
      updateComment: async (id, body) => void rec.updated.push({ id, body }),
    },
    summary: (md) => void rec.summaries.push(md),
    warn: (m) => void rec.warnings.push(m),
    info: () => {},
    makeClient: over.makeClient,
    fetch: over.fetch,
  };
  return { deps, rec };
}

/** A model that reports REL-002 for the first `fetch(` line it is shown, and does one HTTP request per call. */
function fetchingModel(onCall?: () => void): Deps["makeClient"] {
  return (i) => {
    const client: LlmClient = {
      model: "test-model",
      async json(messages) {
        onCall?.();
        await i.fetch!("https://provider.test/v1");
        const user = messages.find((m) => m.role === "user")!.content;
        const code = /BEGIN CODE ([0-9a-f]+)\n([\s\S]*)\nEND CODE \1/.exec(user)?.[2] ?? "";
        const line = code.split("\n").find((l) => l.includes("fetch("));
        const evidence = line?.replace(/^\d+[+ ]\| /, "").trim();
        return { findings: evidence ? [{ standard_id: "REL-002", certainty: "definite", evidence, explanation: "No timeout. @everyone [click](http://evil.test)", impact: "Hangs.", remediation: "Add a signal." }] : [] };
      },
    };
    return client;
  };
}
const okFetch: FetchFn = (async () => new Response("{}", { status: 200 })) as FetchFn;

const finding = (over: Partial<Finding> = {}): Finding => ({
  standardId: "SEC-001", standardHash: "h", classification: "violation", severity: "blocker", source: "rule", file: "a.ts", lineStart: 3, lineEnd: 3,
  evidence: "x", explanation: "Secret in code.", impact: "i", remediation: "Use env.", ...over,
});

// --- Runner ----------------------------------------------------------------------------------

describe("runner", () => {
  it("reads inputs, with defaults and clear errors", () => {
    const env = { "INPUT_FAIL-ON": " blocker ", "INPUT_CHECK-RUN": "false", "INPUT_MAX-AI-CALLS": "7" };
    expect(getInput("fail-on", env)).toBe("blocker");
    expect(getChoice("fail-on", ["none", "blocker", "major"] as const, "none", env)).toBe("blocker");
    expect(getBoolean("check-run", true, env)).toBe(false);
    expect(getBoolean("summary-comment", true, env)).toBe(true);
    expect(getPositiveInt("max-ai-calls", 20, env)).toBe(7);
    expect(() => getChoice("fail-on", ["none", "blocker"] as const, "none", { "INPUT_FAIL-ON": "all" })).toThrow(/must be one of none, blocker/);
    expect(() => getBoolean("x", true, { INPUT_X: "yes" })).toThrow(/true or false/);
    expect(() => getPositiveInt("x", 1, { INPUT_X: "0" })).toThrow(/positive whole number/);
  });

  it("writes outputs to the GITHUB_OUTPUT file with a delimiter, so a value can't inject another output", () => {
    const file = join(mkdtempSync(join(tmpdir(), "guardrail-")), "out");
    writeFileSync(file, "");
    setOutput("verdict", "fail\nviolations=0", { GITHUB_OUTPUT: file });
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^verdict<<(guardrail_[0-9a-f]+)\nfail\nviolations=0\n\1\n$/);
  });
});

describe("readInputs / readPullRequest", () => {
  it("defaults: provider none, advisory, check and summary on", () => {
    expect(readInputs({})).toMatchObject({ provider: "none", failOn: "none", checkRun: true, summaryComment: true, maxAiCalls: 20, maxFiles: 50, standardsPath: ".guardrail/standards" });
  });
  it("rejects an unknown provider", () => {
    expect(() => readInputs({ INPUT_PROVIDER: "openai" })).toThrow(/must be one of/);
  });
  it("reads the PR from the event payload and detects forks", () => {
    const dir = mkdtempSync(join(tmpdir(), "guardrail-"));
    const event = (head: string) => {
      const f = join(dir, `${head.replace("/", "_")}.json`);
      writeFileSync(f, JSON.stringify({ repository: { full_name: "o/r" }, pull_request: { number: 9, head: { sha: "H", repo: { full_name: head } }, base: { sha: "B" } } }));
      return f;
    };
    expect(readPullRequest({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event("o/r") })).toEqual({ repo: "o/r", pr: { number: 9, headSha: "H", baseSha: "B", eventName: "pull_request", isFork: false } });
    expect(readPullRequest({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event("someone/r") }).pr.isFork).toBe(true);
    expect(() => readPullRequest({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event("o/r") })).toThrow(/run it on pull_request/);
  });
});

// --- GitHub ----------------------------------------------------------------------------------

describe("assembleDiff", () => {
  it("joins patches into one parseable diff, skipping deleted and moved-only files", () => {
    const { diff, gaps } = assembleDiff([
      added("a.ts", "x = 1"),
      { filename: "gone.ts", status: "removed", changes: 3, patch: "@@ -1 +0,0 @@\n-x" },
      { filename: "new-name.ts", previous_filename: "old-name.ts", status: "renamed", changes: 0 },
      { filename: "logo.png", status: "added", changes: 0 },
      { filename: "huge.ts", status: "modified", changes: 5000 },
    ]);
    expect(diff).toContain("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+x = 1\n");
    expect(diff).not.toContain("gone.ts");
    expect(diff).not.toContain("new-name.ts");
    expect(diff).toContain("Binary files a/logo.png and b/logo.png differ");
    expect(gaps).toEqual([{ file: "huge.ts", reason: "diff too large for GitHub to return" }]);
  });
  it("is empty when there's nothing to read", () => {
    expect(assembleDiff([{ filename: "x", status: "removed", changes: 1 }]).diff).toBe("");
  });
});

describe("GitHubClient", () => {
  function mock(handler: (method: string, url: string, body: any) => Response) {
    const calls: { method: string; url: string; body: any; headers: Headers }[] = [];
    const f = (async (input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: String(init?.method), url: String(input), body, headers: new Headers(init?.headers) });
      return handler(String(init?.method), String(input), body);
    }) as FetchFn;
    return { gh: new GitHubClient({ token: "tok", repo: "o/r", fetch: f }), calls };
  }
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

  it("reads every page of the PR's files", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: "added", changes: 1 }));
    const { gh, calls } = mock((_m, url) => json(url.endsWith("&page=1") ? page1 : [{ filename: "last", status: "added", changes: 1 }]));
    expect(await gh.listPullFiles(5)).toHaveLength(101);
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/o/r/pulls/5/files?per_page=100&page=1", "https://api.github.com/repos/o/r/pulls/5/files?per_page=100&page=2"]);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("returns null for a missing standards folder, and reads files at the given commit as raw text", async () => {
    const { gh, calls } = mock((_m, url) => (url.includes("/contents/.guardrail/standards?") ? json({ message: "Not Found" }, 404) : new Response("id: X")));
    expect(await gh.listDirectory(".guardrail/standards", "abc")).toBeNull();
    expect(await gh.getFileText(".guardrail/standards/A B.yaml", "abc")).toBe("id: X");
    expect(calls[1]!.url).toBe("https://api.github.com/repos/o/r/contents/.guardrail/standards/A%20B.yaml?ref=abc");
    expect(calls[1]!.headers.get("accept")).toBe("application/vnd.github.raw+json");
  });

  it("sends annotations 50 per request: the check run first, then updates", async () => {
    const { gh, calls } = mock((method) => json(method === "POST" ? { id: 99 } : {}));
    const annotations = Array.from({ length: 120 }, (_, i) => ({ path: "a.ts", start_line: i + 1, end_line: i + 1, annotation_level: "notice" as const, title: "t", message: "m" }));
    expect(await gh.createCheckRun({ name: "Guardrail", headSha: "h", conclusion: "neutral", title: "t", summary: "s", annotations })).toBe(99);
    expect(calls.map((c) => [c.method, c.url.split("/repos/o/r")[1], c.body.output.annotations.length])).toEqual([["POST", "/check-runs", 50], ["PATCH", "/check-runs/99", 50], ["PATCH", "/check-runs/99", 20]]);
    expect(calls[0]!.body).toMatchObject({ name: "Guardrail", head_sha: "h", status: "completed", conclusion: "neutral" });
  });

  it("names the permissions on a 403", async () => {
    const { gh } = mock(() => json({ message: "Resource not accessible by integration" }, 403));
    await expect(gh.createComment(1, "x")).rejects.toThrow(/HTTP 403: Resource not accessible by integration \(does the workflow's `permissions:` allow this\?\)/);
  });
});

// --- Gating and text -------------------------------------------------------------------------

describe("gate", () => {
  const c = (blockers: number, majors: number, minors = 0) => ({ violations: blockers + majors + minors, blockers, majors, suggestions: 0 });
  it("is advisory by default", () => {
    expect(gate("fail", c(1, 0), "none", false)).toBe("neutral");
    expect(gate("warn", c(0, 1), "none", false)).toBe("neutral");
    expect(gate("pass", c(0, 0), "none", false)).toBe("success");
  });
  it("fail-on blocker fails on a blocker only", () => {
    expect(gate("fail", c(1, 0), "blocker", false)).toBe("failure");
    expect(gate("warn", c(0, 2), "blocker", false)).toBe("neutral");
  });
  it("fail-on major fails on a blocker or a major", () => {
    expect(gate("warn", c(0, 1), "major", false)).toBe("failure");
    expect(gate("warn", c(0, 0, 3), "major", false)).toBe("neutral");
  });
  it("incomplete is neutral unless fail-on-incomplete", () => {
    expect(gate("incomplete", c(0, 0), "major", false)).toBe("neutral");
    expect(gate("incomplete", c(0, 0), "none", true)).toBe("failure");
  });
  it("counts exclude waived findings and suggestions", () => {
    expect(countFindings([finding(), finding({ waivedBy: "e1" }), finding({ classification: "suggestion" })])).toEqual({ violations: 1, blockers: 1, majors: 0, suggestions: 1 });
    expect(checkTitle("fail", { violations: 2, blockers: 1, majors: 1, suggestions: 0 })).toBe("fail: 2 violations, 1 blocker");
  });
});

describe("escaping model text", () => {
  it("neutralises mentions, links, HTML, table pipes and backticks, on one line", () => {
    const out = clean("Hi @everyone [x](http://e.test)\n<img src=x> a|b `c`");
    expect(out).not.toMatch(/@everyone/);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("\n");
    expect(out).toContain("\\[x\\]");
    expect(out).toContain("a\\|b");
    expect(out).not.toContain("`");
  });
  it("fences code longer than any backtick run inside it", () => {
    expect(codeBlock("a ```` b")).toMatch(/^`{5}\n/);
    expect(codeBlock("plain")).toBe("```\nplain\n```");
  });
  it("annotation levels follow severity; suggestions are notices; waived findings are left out", () => {
    const a = annotationsFor([
      finding({ severity: "blocker" }),
      finding({ severity: "major", standardId: "REL-002" }),
      finding({ severity: "minor", standardId: "MNT-001" }),
      finding({ severity: "blocker", classification: "suggestion", preExisting: true }),
      finding({ waivedBy: "e1" }),
    ]);
    expect(a.map((x) => [x.annotation_level, x.title])).toEqual([["failure", "SEC-001"], ["warning", "REL-002"], ["notice", "MNT-001"], ["notice", "SEC-001 (suggestion) (pre-existing)"]]);
  });
});

describe("renderSummary", () => {
  const report = (over: Partial<Report> = {}): Report => ({
    verdict: "fail", findings: [finding(), finding({ classification: "suggestion", standardId: "REL-003" })], coverage: { filesTotal: 2, filesReviewed: 1, skipped: [{ file: "big.ts", reason: "over the 100 KB per-file limit" }] },
    provider: "anthropic", model: "claude-opus-5-5", standardsSource: "repository", standardsChanged: false, notChecked: [], headSha: "abcdef1234567", conclusion: "neutral", ...over,
  });
  it("has the marker, verdict, table, suggestions, gaps and the commit", () => {
    const md = renderSummary(report());
    expect(md.startsWith(SUMMARY_MARKER)).toBe(true);
    for (const s of ["## Guardrail: fail", "1 violation (1 blocker), 1 suggestion", "1 of 2 files reviewed", "| SEC-001 | blocker |", "Suggestions (1)", "`big.ts`: over the 100 KB per-file limit", "`abcdef1`", "`anthropic`, `claude-opus-5-5`"]) expect(md).toContain(s);
    expect(renderSummary(report(), { marker: false })).not.toContain(SUMMARY_MARKER);
  });
  it("says so when the standards changed in the PR, or AI didn't run", () => {
    const md = renderSummary(report({ standardsChanged: true, provider: "none", model: undefined, aiNote: "AI review didn't run: fork.", notChecked: ["REL-002 Timeouts"] }));
    expect(md).toContain("reviewed against the standards at the base commit");
    expect(md).toContain("AI review didn't run: fork.");
    expect(md).toContain("Not checked, because they need AI: REL-002 Timeouts");
    expect(md).toContain("Rules only");
  });
  it("stays under GitHub's size limit with hundreds of findings", () => {
    const many = Array.from({ length: 300 }, (_, i) => finding({ lineStart: i + 1, lineEnd: i + 1, explanation: "e".repeat(300) }));
    const md = renderSummary(report({ findings: many }));
    expect(md.length).toBeLessThan(60_100);
    expect(md).toContain("…and 260 more");
  });
});

// --- Standards -------------------------------------------------------------------------------

describe("loadStandards", () => {
  const yaml = (id: string) => `id: ${id}\ntitle: Mine\nseverity: major\ndetector: rule\nrule: R\n`;
  it("uses the built-in standards when the folder doesn't exist", async () => {
    const r = await loadStandards({ listDirectory: async () => null, getFileText: async () => "" }, ".guardrail/standards", "base");
    expect(r.source).toBe("built-in");
    expect(r.standards.map((s) => s.id)).toContain("SEC-001");
  });
  it("reads the repository's folder at the base commit", async () => {
    const refs: string[] = [];
    const r = await loadStandards(
      { listDirectory: async (_p, ref) => (refs.push(ref), [{ name: "ABC-001.yaml", type: "file" }, { name: "notes.md", type: "file" }]), getFileText: async (_p, ref) => (refs.push(ref), yaml("ABC-001")) },
      ".guardrail/standards",
      "basesha",
    );
    expect(r).toMatchObject({ source: "repository", standards: [{ id: "ABC-001" }] });
    expect(refs).toEqual(["basesha", "basesha"]);
  });
  it("fails, naming the file, on an invalid standard or an empty folder", async () => {
    const dir = [{ name: "ABC-001.yaml", type: "file" }];
    await expect(loadStandards({ listDirectory: async () => dir, getFileText: async () => "id: nope" }, "s", "b")).rejects.toThrow(/ABC-001.yaml/);
    await expect(loadStandards({ listDirectory: async () => [{ name: "README.md", type: "file" }], getFileText: async () => "" }, "s", "b")).rejects.toThrow(/no \.yaml standards/);
  });
});

// --- The flow --------------------------------------------------------------------------------

describe("reviewPullRequest", () => {
  const badFiles = [added("src/config.ts", SECRET_LINE), added("src/api.ts", "export function f() {", `  ${FETCH_LINE}`, "}")];

  it("rules and AI: fails on the secret, marks the check neutral, posts check, comment and job summary", async () => {
    const { deps, rec } = harness({ files: badFiles, makeClient: fetchingModel(), fetch: okFetch });
    const out = await reviewPullRequest(pr(), inputs({ provider: "openai-compatible", apiKey: KEY }), deps);
    expect(out).toMatchObject({ verdict: "fail", conclusion: "neutral", incomplete: false });
    expect(out.counts.blockers).toBe(1);
    expect(rec.checkRuns).toHaveLength(1);
    expect(rec.checkRuns[0]).toMatchObject({ headSha: "h".repeat(40), conclusion: "neutral" });
    const ids = rec.checkRuns[0]!.annotations.map((a) => a.title);
    expect(ids).toContain("SEC-001");
    expect(ids).toContain("REL-002");
    expect(rec.created).toHaveLength(1);
    expect(rec.created[0]).toContain(SUMMARY_MARKER);
    expect(rec.summaries).toHaveLength(1);
    expect(rec.summaries[0]).not.toContain(SUMMARY_MARKER);
    // the secret itself never appears in anything published
    expect(JSON.stringify(rec)).not.toContain("abcd1234abcd1234");
  });

  it("neutralises the model's markup in what it publishes", async () => {
    const { deps, rec } = harness({ files: badFiles, makeClient: fetchingModel(), fetch: okFetch });
    await reviewPullRequest(pr(), inputs({ provider: "openai-compatible", apiKey: KEY }), deps);
    const body = rec.created[0]!;
    expect(body).not.toContain("@everyone");
    expect(body).not.toContain("[click](");
  });

  it("fail-on: blocker fails the check", async () => {
    const { deps, rec } = harness({ files: badFiles });
    const out = await reviewPullRequest(pr(), inputs({ failOn: "blocker" }), deps);
    expect(out.conclusion).toBe("failure");
    expect(rec.checkRuns[0]!.conclusion).toBe("failure");
  });

  it("provider none: rules only, no gap, and says which standards weren't checked", async () => {
    const { deps, rec } = harness({ files: [added("src/ok.ts", "export const a = 1;"), added("test/ok.test.ts", "export const b = 2;")] });
    const out = await reviewPullRequest(pr(), inputs(), deps);
    expect(out.verdict).toBe("pass");
    expect(out.conclusion).toBe("success");
    expect(rec.created[0]).toContain("Not checked, because they need AI");
    expect(rec.created[0]).toContain("Rules only");
  });

  it("reads the standards at the base commit, not the head", async () => {
    const { deps, rec } = harness({ files: [added("a.ts", "x")], dir: [{ name: "ABC-001.yaml", type: "file" }], fileText: { ".guardrail/standards/ABC-001.yaml": "id: ABC-001\ntitle: T\nseverity: minor\ndetector: rule\nrule: R\n" } });
    await reviewPullRequest(pr({ baseSha: "c".repeat(40) }), inputs(), deps);
    expect(rec.dirRefs).toEqual(["c".repeat(40)]);
  });

  it("notes when the PR itself edits the standards folder", async () => {
    const { deps, rec } = harness({ files: [added(".guardrail/standards/NEW-001.yaml", "id: NEW-001")] });
    await reviewPullRequest(pr(), inputs(), deps);
    expect(rec.created[0]).toContain("changes the standards folder");
  });

  it("fork on pull_request: rules only, an incomplete verdict, and nothing written to the PR", async () => {
    let built = false;
    const { deps, rec } = harness({ files: badFiles, makeClient: () => ((built = true), fetchingModel()!({ provider: "x" })!) });
    const out = await reviewPullRequest(pr({ isFork: true }), inputs({ provider: "anthropic", apiKey: "" }), deps);
    expect(built).toBe(false);
    expect(out.verdict).toBe("fail"); // the rule finding still counts
    expect(rec.checkRuns).toEqual([]);
    expect(rec.created).toEqual([]);
    expect(rec.summaries[0]).toContain("GitHub doesn't give secrets");
    expect(rec.summaries[0]).toContain("AI review unavailable");
  });

  it("pull_request_target from a fork: the secrets are there, so AI runs and results are written", async () => {
    const { deps, rec } = harness({ files: badFiles, makeClient: fetchingModel(), fetch: okFetch });
    await reviewPullRequest(pr({ isFork: true, eventName: "pull_request_target" }), inputs({ provider: "openai-compatible", apiKey: KEY }), deps);
    expect(rec.checkRuns).toHaveLength(1);
    expect(rec.checkRuns[0]!.annotations.map((a) => a.title)).toContain("REL-002");
  });

  it("an empty api-key (e.g. Dependabot) falls back to rules only and says why, but still writes", async () => {
    const { deps, rec } = harness({ files: [added("src/a.ts", "export const a = 1;")] });
    const out = await reviewPullRequest(pr(), inputs({ provider: "anthropic", apiKey: "" }), deps);
    expect(out.verdict).toBe("incomplete");
    expect(rec.created[0]).toContain("`api-key` is empty");
  });

  it("stops at max-ai-calls and records every remaining chunk as a gap", async () => {
    let calls = 0;
    const files = ["a", "b", "c"].map((n) => added(`src/${n}.ts`, `export const ${n} = () => fetch("https://x.example/${n}");`));
    const { deps, rec } = harness({ files, makeClient: fetchingModel(() => calls++), fetch: okFetch });
    const out = await reviewPullRequest(pr(), inputs({ provider: "openai-compatible", apiKey: KEY, maxAiCalls: 1 }), deps);
    expect(calls).toBe(1);
    expect(out.verdict).toBe("incomplete");
    expect(rec.created[0]).toContain("max-ai-calls (1) reached");
  });

  it("a provider failure is a gap, not a crash", async () => {
    const failing: Deps["makeClient"] = () => ({ model: "m", json: async () => { throw Object.assign(new Error("HTTP 401: bad key"), { retryable: false }); } });
    const { deps, rec } = harness({ files: [added("src/a.ts", FETCH_LINE)], makeClient: failing });
    const out = await reviewPullRequest(pr(), inputs({ provider: "openai-compatible", apiKey: KEY }), deps);
    expect(out.verdict).toBe("incomplete");
    expect(rec.created[0]).toContain("AI review failed: HTTP 401: bad key");
  });

  it("files GitHub gave no patch for are gaps; a PR with nothing to read still reports", async () => {
    const { deps, rec } = harness({ files: [{ filename: "huge.ts", status: "modified", changes: 9000 }] });
    const out = await reviewPullRequest(pr(), inputs(), deps);
    expect(out.verdict).toBe("incomplete");
    expect(rec.created[0]).toContain("`huge.ts`: diff too large for GitHub to return");
    const none = harness({ files: [{ filename: "x.ts", status: "removed", changes: 4 }] });
    expect((await reviewPullRequest(pr(), inputs(), none.deps)).verdict).toBe("pass");
  });

  it("a token that can't write loses nothing: warnings, the other outputs still happen, the job summary has the result", async () => {
    const { deps, rec } = harness({ files: [added("src/a.ts", "export const a = 1;")], checkRunError: new Error("HTTP 403") });
    const out = await reviewPullRequest(pr(), inputs(), deps);
    expect(out.verdict).toBe("pass");
    expect(rec.warnings[0]).toMatch(/Couldn't write the check run: HTTP 403/);
    expect(rec.created).toHaveLength(1);
    expect(rec.summaries).toHaveLength(1);
  });

  it("check-run and summary-comment can be turned off", async () => {
    const { deps, rec } = harness({ files: [added("a.ts", "x")] });
    await reviewPullRequest(pr(), inputs({ checkRun: false, summaryComment: false }), deps);
    expect(rec.checkRuns).toEqual([]);
    expect(rec.created).toEqual([]);
    expect(rec.summaries).toHaveLength(1);
  });
});

describe("upsertSummaryComment", () => {
  const gh = (comments: Comment[]) => {
    const log: string[] = [];
    return { log, api: { listIssueComments: async () => comments, createComment: async (_n: number, b: string) => void log.push(`create:${b}`), updateComment: async (id: number, b: string) => void log.push(`update:${id}:${b}`) } };
  };
  it("edits the Action's own comment instead of adding another", async () => {
    const { api, log } = gh([{ id: 5, body: `${SUMMARY_MARKER}\nold`, user: { type: "Bot" } }]);
    await upsertSummaryComment(api, 1, "new");
    expect(log).toEqual(["update:5:new"]);
  });
  it("never edits a person's comment that happens to contain the marker", async () => {
    const { api, log } = gh([{ id: 5, body: `${SUMMARY_MARKER} hi`, user: { type: "User" } }]);
    await upsertSummaryComment(api, 1, "new");
    expect(log).toEqual(["create:new"]);
  });
});

describe("countingFetch", () => {
  it("refuses requests past the cap with a non-retryable error", async () => {
    const { fetch: f, used } = countingFetch(okFetch, 2);
    await f("https://x.test");
    await f("https://x.test");
    await expect(f("https://x.test")).rejects.toMatchObject({ retryable: false, message: "max-ai-calls (2) reached" });
    expect(used()).toBe(2);
  });
});
