// The Action end to end, with GitHub and the model mocked: reading the PR, the standards at the base
// commit, gating, the check run and comment, forks, the AI-call cap and the escaping of model text.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubClient, assembleDiff, type Annotation, type Comment, type DirEntry, type PullFile } from "../action/github.ts";
import { readInputs, readPullRequest } from "../action/main.ts";
import type { FetchFn } from "../core/providers/http.ts";
import { parseExceptions } from "../action/exceptions.ts";
import { annotationsFor, checkTitle, clean, countFindings, fingerprint, gate, inlineBody, MAX_INLINE_PER_RUN, planInline, renderSummary, staleBody, STALE_MARKER, SUMMARY_MARKER, type Report } from "../action/publish.ts";
import { countingFetch, reviewPullRequest, syncInlineComments, uncheckedFiles, upsertSummaryComment, type Deps, type Inputs, type PrContext } from "../action/run.ts";
import { getBoolean, getChoice, getInput, getPositiveInt, setOutput } from "../action/runner.ts";
import { loadStandards } from "../action/standards.ts";
import { parseInput } from "../core/diff.ts";
import type { LlmClient } from "../core/llm.ts";
import type { Finding, ParsedInput } from "../core/types.ts";

// --- Helpers ---------------------------------------------------------------------------------

const KEY = "sk-test-not-a-real-key";
// Built in pieces: this file is reviewed by the Action too, and a literal here would be a real SEC-001 finding.
const SECRET_LINE = `const ${"api"}Key = "abcd1234${"abcd1234"}";`;
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
  inlineComments: false,
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
  reviews: { commitId: string; comments: { path: string; line: number; body: string }[] }[];
  edited: { id: number; body: string }[];
}

function harness(over: { files?: PullFile[]; dir?: DirEntry[] | null; fileText?: Record<string, string>; comments?: Comment[]; checkRunError?: Error; makeClient?: Deps["makeClient"]; fetch?: FetchFn } = {}) {
  const rec: Recorded = { checkRuns: [], created: [], updated: [], dirRefs: [], summaries: [], warnings: [], reviews: [], edited: [] };
  const deps: Deps = {
    github: {
      listPullFiles: async () => over.files ?? [],
      listDirectory: async (_p, ref) => (rec.dirRefs.push(ref), over.dir === undefined ? null : over.dir),
      getFileText: async (p) => {
        const text = over.fileText?.[p];
        if (text === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        return text;
      },
      createCheckRun: async (i) => {
        if (over.checkRunError) throw over.checkRunError;
        rec.checkRuns.push(i);
        return 1;
      },
      listIssueComments: async () => over.comments ?? [],
      createComment: async (_n, body) => void rec.created.push(body),
      updateComment: async (id, body) => void rec.updated.push({ id, body }),
      listReviewComments: async () => [],
      createReview: async (_n, commitId, comments) => void rec.reviews.push({ commitId, comments }),
      updateReviewComment: async (id, body) => void rec.edited.push({ id, body }),
    },
    summary: (md) => void rec.summaries.push(md),
    warn: (m) => void rec.warnings.push(m),
    info: () => {},
    makeClient: over.makeClient,
    fetch: over.fetch,
    now: () => new Date("2026-11-24T12:00:00Z"),
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
  it("doesn't count a generated file with no patch (a big bundle) as a gap", () => {
    const { diff, gaps } = assembleDiff([{ filename: "dist/action/index.cjs", status: "modified", changes: 40_000 }, { filename: "pnpm-lock.yaml", status: "modified", changes: 9_000 }]);
    expect(diff).toBe("");
    expect(gaps).toEqual([]);
  });
  it("is empty when there's nothing to read", () => {
    expect(assembleDiff([{ filename: "x", status: "removed", changes: 1 }]).diff).toBe("");
  });
  it("a file name with a line break is a gap, never part of the diff", () => {
    const { diff, gaps } = assembleDiff([
      { filename: "a.ts\n--- a/q\n+++ b/vendor/q.ts", status: "added", changes: 1, patch: "@@ -0,0 +1,1 @@\n+const k = 1;" },
      { filename: "ok.ts", status: "renamed", previous_filename: "old\tname.ts", changes: 1, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
      added("src/fine.ts", "export const a = 1;"),
    ]);
    expect(gaps.map((g) => g.reason)).toEqual(["file name has control characters", "file name has control characters"]);
    expect(parseInput(diff).files.map((f) => f.path)).toEqual(["src/fine.ts"]);
  });
  it("a removed '-- x' and an added '++ y' inside a patch stay that file's lines, not a new file header", () => {
    const patch = ["@@ -1,2 +1,2 @@", " const a = 1;", "--- a/x", "+++ b/vendor/x.ts", "@@ -10,1 +10,2 @@", " const b = 2;", "+const hidden = 1;"].join("\n");
    const p = parseInput(assembleDiff([{ filename: "src/real.ts", status: "modified", changes: 3, patch }]).diff);
    expect(p.files.map((f) => f.path)).toEqual(["src/real.ts"]);
    expect(p.files[0]!.lines).toEqual([
      { n: 1, text: "const a = 1;", added: false },
      { n: 2, text: "++ b/vendor/x.ts", added: true },
      { n: 10, text: "const b = 2;", added: false },
      { n: 11, text: "const hidden = 1;", added: true },
    ]);
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
    expect(gate(false, c(1, 0), "none", false)).toBe("neutral");
    expect(gate(false, c(0, 1), "none", false)).toBe("neutral");
    expect(gate(false, c(0, 0), "none", false)).toBe("success");
  });
  it("fail-on blocker fails on a blocker only", () => {
    expect(gate(false, c(1, 0), "blocker", false)).toBe("failure");
    expect(gate(false, c(0, 2), "blocker", false)).toBe("neutral");
  });
  it("fail-on major fails on a blocker or a major", () => {
    expect(gate(false, c(0, 1), "major", false)).toBe("failure");
    expect(gate(false, c(0, 0, 3), "major", false)).toBe("neutral");
  });
  it("incomplete is neutral unless fail-on-incomplete", () => {
    expect(gate(true, c(0, 0), "major", false)).toBe("neutral");
    expect(gate(true, c(0, 0), "none", true)).toBe("failure");
  });
  it("a blocker doesn't hide unread code from fail-on-incomplete", () => {
    expect(gate(true, c(1, 0), "none", true)).toBe("failure");
    expect(gate(true, c(1, 0), "none", false)).toBe("neutral");
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
  it("breaks what GitHub would make live: bare URLs, www links and issue references", () => {
    const out = clean("Log in at https://evil.test/login or www.evil.test, see #12, other/repo#3 and GH-7. C# and a#b stay.");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("www.");
    expect(out).not.toMatch(/#\d/);
    expect(out).not.toMatch(/GH-\d/);
    // Nothing is removed: without the zero-width spaces the text reads as it was written
    expect(out.replace(/\u200b/g, "")).toBe("Log in at https://evil.test/login or www.evil.test, see #12, other/repo#3 and GH-7. C# and a#b stay.");
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

  it("a blocker with unread code: the verdict is fail, and the run still counts as incomplete", async () => {
    const files = [added("src/config.ts", SECRET_LINE), { filename: "src/huge.ts", status: "modified", changes: 90_000 }];
    const off = await reviewPullRequest(pr(), inputs(), harness({ files }).deps);
    expect(off).toMatchObject({ verdict: "fail", incomplete: true, conclusion: "neutral" });
    const on = await reviewPullRequest(pr(), inputs({ failOnIncomplete: true }), harness({ files }).deps);
    expect(on).toMatchObject({ verdict: "fail", incomplete: true, conclusion: "failure" });
  });
  it("marks earlier inline comments when the pull request has nothing left to read", async () => {
    const h = harness({ files: [{ filename: "src/gone.ts", status: "removed", changes: 3 }] });
    h.deps.github.listReviewComments = async () => [{ id: 4, body: inlineBody(finding({ file: "src/gone.ts" })), user: { type: "Bot" }, path: "src/gone.ts" }];
    await reviewPullRequest(pr(), inputs({ inlineComments: true }), h.deps);
    expect(h.rec.edited.map((e) => e.id)).toEqual([4]);
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

// --- Exceptions ------------------------------------------------------------------------------

describe("parseExceptions", () => {
  const NOW = new Date("2026-11-24T12:00:00Z");
  const stds = [{ id: "SEC-001" }, { id: "SEC-002" }];
  const entry = (over: Record<string, string> = {}) =>
    ["exceptions:", "  - standard: " + (over.standard ?? "SEC-002"), "    path: " + (over.path ?? "scripts/**"), "    reason: " + (over.reason ?? "Build script, input is a constant list."), "    approved-by: " + (over["approved-by"] ?? "octocat"), "    expires: " + (over.expires ?? "2027-01-31")].join("\n");
  const ignoredWhy = (over: Record<string, string>) => parseExceptions(entry(over), stds, NOW).ignored[0];

  it("reads a valid entry", () => {
    expect(parseExceptions(entry(), stds, NOW)).toEqual({ active: [{ id: "exception-1", standardId: "SEC-002", pathPattern: "scripts/**", reason: "Build script, input is a constant list.", approvedBy: "octocat", expires: "2027-01-31" }], ignored: [] });
  });
  it("treats an empty file as no exceptions", () => {
    expect(parseExceptions("", stds, NOW)).toEqual({ active: [], ignored: [] });
  });
  it("ignores, and says why, an entry that is expired, too far out, unknown or incomplete", () => {
    expect(ignoredWhy({ expires: "2026-11-23" })).toBe("exception-1: expired on 2026-11-23");
    expect(parseExceptions(entry({ expires: "2026-11-24" }), stds, NOW).active).toHaveLength(1); // valid through the end of its day
    expect(ignoredWhy({ expires: "2027-06-01" })).toMatch(/more than 90 days away/);
    expect(ignoredWhy({ expires: "2027-02-30" })).toMatch(/must be a date/);
    expect(ignoredWhy({ standard: "NOPE-999" })).toMatch(/not one of this repository's standards/);
    expect(ignoredWhy({ reason: "short" })).toMatch(/"reason" must be 10 to 2000/);
    expect(ignoredWhy({ "approved-by": '""' })).toMatch(/"approved-by" is required/);
    expect(ignoredWhy({ path: "'a b;c'" })).toMatch(/"path" must be a path glob/);
  });
  it("ignores a misspelled field instead of silently dropping it", () => {
    expect(parseExceptions(entry() + "\n    aproved-by: me", stds, NOW).ignored[0]).toMatch(/unknown field\(s\) aproved-by/);
  });
  it("applies none, and says so, when the whole file is unusable", () => {
    expect(parseExceptions("exceptions: [unclosed", stds, NOW)).toMatchObject({ active: [], ignored: [expect.stringMatching(/not valid YAML/)] });
    expect(parseExceptions("- just a list", stds, NOW).ignored[0]).toMatch(/top-level "exceptions:" list/);
  });
  it("keeps the valid entries when one is bad", () => {
    const two = entry() + "\n  - standard: SEC-001\n    path: '*'\n    reason: x\n    approved-by: a\n    expires: 2027-01-01";
    const r = parseExceptions(two, stds, NOW);
    expect(r.active.map((e) => e.id)).toEqual(["exception-1"]);
    expect(r.ignored[0]).toMatch(/^exception-2: "reason"/);
  });
});

describe("exceptions in a review", () => {
  const files = [added("src/config.ts", SECRET_LINE)];
  const exc = (expires = "2027-01-15") => `exceptions:\n  - standard: SEC-001\n    path: src/**\n    reason: Fixture value, not a credential.\n    approved-by: maintainer\n    expires: ${expires}\n`;

  it("waives the finding: no violation, success, and the summary says who approved and why", async () => {
    const { deps, rec } = harness({ files, fileText: { ".guardrail/exceptions.yaml": exc() } });
    const out = await reviewPullRequest(pr(), inputs(), deps);
    expect(out).toMatchObject({ verdict: "pass", conclusion: "success" });
    expect(out.counts.violations).toBe(0);
    expect(rec.checkRuns[0]!.annotations).toEqual([]);
    expect(rec.created[0]).toContain("1 waived by exceptions");
    expect(rec.created[0]).toContain("waived by `exception-1` (approved by maintainer, until 2027-01-15): Fixture value, not a credential.");
  });
  it("doesn't apply an expired exception, and says so", async () => {
    const { deps, rec } = harness({ files, fileText: { ".guardrail/exceptions.yaml": exc("2026-11-01") } });
    const out = await reviewPullRequest(pr(), inputs(), deps);
    expect(out.verdict).toBe("fail");
    expect(rec.created[0]).toContain("Exceptions not applied");
    expect(rec.created[0]).toContain("exception-1: expired on 2026-11-01");
  });
  it("doesn't waive other paths", async () => {
    const { deps } = harness({ files: [added("lib/config.ts", SECRET_LINE)], fileText: { ".guardrail/exceptions.yaml": exc() } });
    expect((await reviewPullRequest(pr(), inputs(), deps)).verdict).toBe("fail");
  });
  it("notes when the PR itself edits the exceptions file", async () => {
    const { deps, rec } = harness({ files: [added(".guardrail/exceptions.yaml", "exceptions: []")] });
    await reviewPullRequest(pr(), inputs(), deps);
    expect(rec.created[0]).toContain("changes the exceptions file");
  });
});

// --- Inline comments -------------------------------------------------------------------------

describe("inline comments", () => {
  const f = (over: Partial<Finding> = {}) => finding({ evidence: 'const k = "secret"', lineStart: 5, lineEnd: 5, ...over });
  const lines = (...n: number[]) => new Map([["a.ts", new Set(n)]]);

  it("fingerprints by standard, file and quoted code, not by line", () => {
    expect(fingerprint(f())).toBe(fingerprint(f({ lineStart: 40, lineEnd: 40 })));
    expect(fingerprint(f())).toBe(fingerprint(f({ evidence: '  const k  =  "secret"  ' })));
    expect(fingerprint(f())).not.toBe(fingerprint(f({ standardId: "SEC-002" })));
    expect(fingerprint(f())).not.toBe(fingerprint(f({ file: "b.ts" })));
    expect(fingerprint(f())).toMatch(/^[0-9a-f]{16}$/);
  });
  it("plans only unwaived violations on lines the diff shows, once per fingerprint", () => {
    const plan = planInline(
      [f(), f({ lineStart: 6, lineEnd: 6 }), f({ standardId: "REL-002", lineStart: 99, lineEnd: 99, evidence: "x" }), f({ classification: "suggestion", evidence: "y" }), f({ waivedBy: "e1", evidence: "z" })],
      lines(5, 6),
    );
    expect(plan.candidates.map((c) => [c.comment.path, c.comment.line])).toEqual([["a.ts", 5]]);
    expect(plan.current.size).toBe(2); // the off-diff REL-002 still counts as found, so its old comment isn't marked gone
  });
  it("comments on the first line of a range that the diff shows", () => {
    expect(planInline([f({ lineStart: 4, lineEnd: 6 })], lines(5, 6)).candidates[0]!.comment.line).toBe(5);
  });
  it("neutralises model text in the body and carries the fingerprint", () => {
    const body = inlineBody(f({ explanation: "Hi @everyone [x](http://e.test)" }));
    expect(body).not.toContain("@everyone");
    expect(body).not.toContain("[x](");
    expect(body).toContain(`<!-- guardrail:fp:${fingerprint(f())} -->`);
  });
  it("marks a stale comment once, keeping the fingerprint", () => {
    const body = inlineBody(f());
    const stale = staleBody(body, "abcdef123456");
    expect(stale).toContain(STALE_MARKER);
    expect(stale).toContain("No longer reported in `abcdef1` (fixed, or waived by an exception)");
    expect(stale).toContain(`guardrail:fp:${fingerprint(f())}`);
    expect(staleBody(stale, "1234567890")).toBe(staleBody(body, "1234567890"));
  });

  const input = (): ParsedInput => ({ kind: "diff", files: [{ path: "a.ts", isTest: false, lines: [5, 6].map((n) => ({ n, text: "x", added: true })) }], coverage: { filesTotal: 1, filesReviewed: 1, skipped: [] } });
  const api = (existing: { id: number; body?: string; user?: { type: string }; path?: string }[] = []) => {
    const log = { reviews: [] as { commitId: string; comments: { path: string; line: number; body: string }[] }[], edits: [] as { id: number; body: string }[] };
    const gh = {
      listReviewComments: async () => existing,
      createReview: async (_n: number, commitId: string, comments: { path: string; line: number; body: string }[]) => void log.reviews.push({ commitId, comments }),
      updateReviewComment: async (id: number, body: string) => void log.edits.push({ id, body }),
    };
    return { log, gh };
  };

  it("posts new violations as one review on the reviewed commit", async () => {
    const { gh, log } = api();
    const msg = await syncInlineComments(gh, pr(), [f(), f({ standardId: "REL-002", lineStart: 6, lineEnd: 6, evidence: "q" })], input());
    expect(log.reviews).toHaveLength(1);
    expect(log.reviews[0]!.commitId).toBe("h".repeat(40));
    expect(log.reviews[0]!.comments.map((c) => c.line)).toEqual([5, 6]);
    expect(msg).toContain("2 new");
  });
  it("doesn't post a comment twice", async () => {
    const { gh, log } = api([{ id: 1, body: inlineBody(f()), user: { type: "Bot" } }]);
    await syncInlineComments(gh, pr(), [f()], input());
    expect(log.reviews).toEqual([]);
    expect(log.edits).toEqual([]);
  });
  it("marks a comment whose finding is gone, only once, and only the Action's own", async () => {
    const { gh, log } = api([
      { id: 1, body: inlineBody(f()), user: { type: "Bot" } },
      { id: 2, body: staleBody(inlineBody(f({ evidence: "old" })), "aaaaaaa"), user: { type: "Bot" } },
      { id: 3, body: inlineBody(f({ evidence: "person" })), user: { type: "User" } },
    ]);
    await syncInlineComments(gh, pr(), [], input());
    expect(log.edits.map((e) => e.id)).toEqual([1]);
    expect(log.edits[0]!.body).toContain(STALE_MARKER);
  });
  it("finds the files a gap leaves unchecked: an AI chunk names its file, a gap about no one file means all", () => {
    const changed = ["src/a.ts", "src/b.ts", "logo.png"];
    expect(uncheckedFiles([], changed)).toEqual(new Set());
    expect(uncheckedFiles([{ file: "src/a.ts#2/3", reason: "AI review failed: HTTP 503" }, { file: "src/b.ts", reason: "over the 100 KB per-file limit" }], changed)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
    expect(uncheckedFiles([{ file: "(whole review)", reason: "3 finding(s) over the cap were dropped" }], changed)).toBe("all");
    expect(uncheckedFiles([{ file: "AI standards", reason: "AI review unavailable" }], changed)).toBe("all");
  });
  it("leaves a comment alone when its file wasn't fully checked, and marks one on a file that was", async () => {
    const onA = f({ file: "src/a.ts" });
    const { gh, log } = api([
      { id: 1, body: inlineBody(onA), user: { type: "Bot" }, path: "src/a.ts" },
      { id: 2, body: inlineBody(f()), user: { type: "Bot" }, path: f().file },
      { id: 3, body: inlineBody(f({ standardId: "REL-002" })), user: { type: "Bot" } },
    ]);
    const msg = await syncInlineComments(gh, pr(), [], input(), new Set(["src/a.ts"]));
    expect(log.edits.map((e) => e.id)).toEqual([2]);
    expect(msg).toContain("1 marked no longer reported (2 left as is: their file wasn't fully checked");
  });
  it("marks nothing when a gap covers the whole review", async () => {
    const { gh, log } = api([{ id: 1, body: inlineBody(f()), user: { type: "Bot" }, path: f().file }]);
    const msg = await syncInlineComments(gh, pr(), [], input(), "all");
    expect(log.edits).toEqual([]);
    expect(msg).toContain("0 marked no longer reported (1 left as is: the review was incomplete");
  });
  it("still restores and posts on an incomplete review: those findings are present", async () => {
    const { gh, log } = api([{ id: 1, body: staleBody(inlineBody(f()), "aaaaaaa"), user: { type: "Bot" } }]);
    await syncInlineComments(gh, pr(), [f(), f({ standardId: "REL-002", lineStart: 6, lineEnd: 6, evidence: "q" })], input(), "all");
    expect(log.edits).toEqual([{ id: 1, body: inlineBody(f()) }]);
    expect(log.reviews[0]!.comments).toHaveLength(1);
  });
  it("end to end: an AI outage on a later push leaves the earlier AI comment alone, a clean run marks it", async () => {
    const files = [added("src/api.ts", "export function f() {", `  ${FETCH_LINE}`, "}")];
    // A comment an earlier run posted for an AI finding on this line
    const earlier = finding({ standardId: "REL-002", severity: "major", source: "llm", file: "src/api.ts", lineStart: 2, lineEnd: 2, evidence: FETCH_LINE });
    const existing = [{ id: 9, body: inlineBody(earlier), user: { type: "Bot" }, path: "src/api.ts" }];
    const failing: Deps["makeClient"] = () => ({ model: "m", json: async () => { throw Object.assign(new Error("HTTP 503"), { retryable: true }); } });
    const outage = harness({ files, makeClient: failing });
    outage.deps.github.listReviewComments = async () => existing;
    expect((await reviewPullRequest(pr(), inputs({ provider: "openai-compatible", apiKey: KEY, inlineComments: true }), outage.deps)).verdict).toBe("incomplete");
    expect(outage.rec.edited).toEqual([]);

    const clean = harness({ files, makeClient: () => ({ model: "m", json: async () => ({ findings: [] }) }) });
    clean.deps.github.listReviewComments = async () => existing;
    await reviewPullRequest(pr(), inputs({ provider: "openai-compatible", apiKey: KEY, inlineComments: true }), clean.deps);
    expect(clean.rec.edited.map((e) => e.id)).toEqual([9]);
  });
  it("end to end: an image in the pull request is listed, doesn't make it incomplete, and doesn't stop marking", async () => {
    const fixed = finding({ standardId: "SEC-001", severity: "blocker", source: "rule", file: "src/a.ts", lineStart: 1, lineEnd: 1, evidence: "x" });
    const h = harness({ files: [added("src/a.ts", "export const ok = 1;"), { filename: "logo.png", status: "added", changes: 0 }] });
    h.deps.github.listReviewComments = async () => [{ id: 7, body: inlineBody(fixed), user: { type: "Bot" }, path: "src/a.ts" }];
    const r = await reviewPullRequest(pr(), inputs({ inlineComments: true }), h.deps);
    expect(r.verdict).toBe("pass");
    expect(h.rec.edited.map((e) => e.id)).toEqual([7]);
    expect(h.rec.summaries[0]).toContain("### Not reviewed");
    expect(h.rec.summaries[0]).toContain("`logo.png`: binary file");
    expect(h.rec.summaries[0]).not.toContain("Not fully reviewed");
  });
  it("restores a stale comment when its finding comes back, without posting a duplicate", async () => {
    const { gh, log } = api([{ id: 1, body: staleBody(inlineBody(f()), "aaaaaaa"), user: { type: "Bot" } }]);
    await syncInlineComments(gh, pr(), [f()], input());
    expect(log.edits).toEqual([{ id: 1, body: inlineBody(f()) }]);
    expect(log.reviews).toEqual([]);
  });
  it(`posts at most ${MAX_INLINE_PER_RUN} new comments and says how many were left`, async () => {
    const { gh, log } = api();
    const many = Array.from({ length: 30 }, (_, i) => f({ evidence: `e${i}` }));
    const msg = await syncInlineComments(gh, pr(), many, input());
    expect(log.reviews[0]!.comments).toHaveLength(MAX_INLINE_PER_RUN);
    expect(msg).toContain("5 more not posted");
  });

  it("is off by default, on when asked, and never runs for a fork pull request", async () => {
    const files = [added("src/config.ts", SECRET_LINE)];
    const off = harness({ files });
    await reviewPullRequest(pr(), inputs(), off.deps);
    expect(off.rec.reviews).toEqual([]);

    const on = harness({ files });
    await reviewPullRequest(pr(), inputs({ inlineComments: true }), on.deps);
    expect(on.rec.reviews).toHaveLength(1);
    expect(on.rec.reviews[0]!.comments[0]).toMatchObject({ path: "src/config.ts", line: 1 });
    expect(JSON.stringify(on.rec.reviews)).not.toContain("abcd1234abcd1234");

    const fork = harness({ files });
    await reviewPullRequest(pr({ isFork: true }), inputs({ inlineComments: true }), fork.deps);
    expect(fork.rec.reviews).toEqual([]);
  });
});
