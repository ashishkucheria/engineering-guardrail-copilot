// The review flow (design §4): read the PR, load the standards at the base commit, run the engine,
// publish, and decide the conclusion. Everything it needs from outside is passed in, so the tests
// run it end to end against a mocked GitHub and a fake model.
import { isGeneratedPath, MAX_INPUT_BYTES } from "../core/diff.ts";
import { review, ruleDetector, type Detector } from "../core/engine.ts";
import { llmDetector, type LlmClient } from "../core/llm.ts";
import { usesLlm, usesRule } from "../core/standards.ts";
import type { Coverage, Finding, ParsedInput, Verdict } from "../core/types.ts";
import { computeVerdict } from "../core/verdict.ts";
import { DEFAULT_EXCEPTIONS_PATH, loadExceptions, NO_EXCEPTIONS, type LoadedExceptions } from "./exceptions.ts";
import { assembleDiff, type GitHubClient } from "./github.ts";
import { createClient } from "./providers/index.ts";
import { ProviderError, type FetchFn } from "./providers/http.ts";
import { annotationsFor, CHECK_NAME, checkTitle, countFindings, fingerprintOf, gate, MAX_INLINE_PER_RUN, planInline, renderSummary, staleBody, STALE_MARKER, SUMMARY_MARKER, type Conclusion, type Counts, type FailOn, type Waived } from "./publish.ts";
import { loadStandards } from "./standards.ts";

export interface Inputs {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  cloudflareAccountId: string;
  standardsPath: string;
  failOn: FailOn;
  failOnIncomplete: boolean;
  checkRun: boolean;
  summaryComment: boolean;
  inlineComments: boolean;
  maxAiCalls: number;
  maxFiles: number;
}

export interface PrContext {
  number: number;
  headSha: string;
  baseSha: string;
  /** "pull_request" or "pull_request_target". */
  eventName: string;
  /** The head branch lives in another repository. */
  isFork: boolean;
}

export interface Deps {
  github: Pick<GitHubClient, "listPullFiles" | "listDirectory" | "getFileText" | "createCheckRun" | "listIssueComments" | "createComment" | "updateComment" | "listReviewComments" | "createReview" | "updateReviewComment">;
  /** Writes the job summary (always) and logs. */
  summary: (markdown: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  /** For tests: replaces the provider factory and the HTTP client the providers use. */
  makeClient?: typeof createClient;
  fetch?: FetchFn;
  /** For tests: the date exceptions are checked against. */
  now?: () => Date;
}

export interface Outcome {
  verdict: Verdict;
  counts: Counts;
  conclusion: Conclusion;
  incomplete: boolean;
  summary: string;
}

/** Why the AI standards can't run on this pull request, or null when they can. */
function aiUnavailable(inputs: Inputs, pr: PrContext): string | null {
  if (inputs.provider === "none") return null;
  if (pr.eventName === "pull_request" && pr.isFork) return "AI review didn't run: GitHub doesn't give secrets to workflows on pull requests from forks, so only the rules ran.";
  if (!inputs.apiKey) return "AI review didn't run: `api-key` is empty (secrets aren't available to this workflow run, for example one started by Dependabot), so only the rules ran.";
  return null;
}

/** A fetch that stops making requests after `max`. Every provider request counts, step-downs included. */
export function countingFetch(base: FetchFn, max: number): { fetch: FetchFn; used: () => number } {
  let n = 0;
  const f = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    if (n >= max) return Promise.reject(new ProviderError(`max-ai-calls (${max}) reached`, undefined, false));
    n++;
    return base(input, init);
  }) as FetchFn;
  return { fetch: f, used: () => n };
}

export async function reviewPullRequest(pr: PrContext, inputs: Inputs, deps: Deps): Promise<Outcome> {
  const { github: gh } = deps;

  const files = await gh.listPullFiles(pr.number);
  const { diff, gaps } = assembleDiff(files);
  const loaded = await loadStandards(gh, inputs.standardsPath, pr.baseSha);
  const folder = inputs.standardsPath.replace(/\/+$/, "") + "/";
  const standardsChanged = files.some((f) => f.filename.startsWith(folder) || f.previous_filename?.startsWith(folder));
  const enabled = loaded.standards.filter((s) => s.enabled);
  // Exceptions come from the base commit too, so adding one takes a reviewed merge.
  const exceptions: LoadedExceptions = await loadExceptions(gh, DEFAULT_EXCEPTIONS_PATH, pr.baseSha, loaded.standards, (deps.now ?? (() => new Date()))());
  const exceptionNotes = [...exceptions.ignored];
  if (files.some((f) => f.filename === DEFAULT_EXCEPTIONS_PATH)) exceptionNotes.push("this pull request changes the exceptions file; it was reviewed against the exceptions at the base commit, so the change takes effect after it merges");

  const unavailable = aiUnavailable(inputs, pr);
  const wantAi = inputs.provider !== "none" && unavailable === null && enabled.some(usesLlm);
  const counter = countingFetch(deps.fetch ?? fetch, inputs.maxAiCalls);
  const client: LlmClient | null = wantAi
    ? (deps.makeClient ?? createClient)({
        provider: inputs.provider,
        apiKey: inputs.apiKey,
        model: inputs.model,
        baseUrl: inputs.baseUrl,
        cloudflareAccountId: inputs.cloudflareAccountId,
        fetch: counter.fetch,
      })
    : null;

  const extraGaps = [...gaps];
  if (unavailable && enabled.some(usesLlm)) extraGaps.push({ file: "AI standards", reason: "AI review unavailable" });
  const detectors: Detector[] = [ruleDetector, { name: "github", detect: async () => ({ findings: [], skipped: extraGaps }) }];
  if (client) {
    detectors.push(
      llmDetector(client, {
        attempts: 3,
        reserve: async () => counter.used() < inputs.maxAiCalls,
        budgetReason: `max-ai-calls (${inputs.maxAiCalls}) reached`,
        skipPath: isGeneratedPath,
        onChunk: (label, outcome, detail) => deps.info(`AI ${outcome}: ${label}${detail ? ` (${detail})` : ""}`),
      }),
    );
  }

  let findings: Finding[], coverage: Coverage, verdict: Verdict;
  let parsed: ParsedInput | undefined;
  if (diff === "") {
    // Nothing to read (only deletions, renames or a too-large diff). Don't hand the engine an empty snippet.
    coverage = { filesTotal: 0, filesReviewed: 0, skipped: extraGaps };
    findings = [];
    verdict = computeVerdict(findings, coverage);
  } else {
    const r = await review(diff, loaded.standards, detectors, { maxFiles: inputs.maxFiles, maxFileBytes: MAX_INPUT_BYTES }, exceptions.active);
    ({ findings, coverage, verdict } = r);
    parsed = r.input;
  }

  const counts = countFindings(findings);
  const conclusion = gate(verdict, counts, inputs.failOn, inputs.failOnIncomplete);
  const report = {
    verdict,
    findings,
    coverage,
    provider: client ? inputs.provider : "none",
    model: client?.model,
    aiNote: unavailable ?? undefined,
    standardsSource: loaded.source,
    standardsChanged,
    notChecked: client ? [] : enabled.filter((s) => usesLlm(s) && !usesRule(s)).map((s) => `${s.id} ${s.title}`),
    headSha: pr.headSha,
    conclusion,
    waived: waivedFindings(findings, exceptions),
    exceptionNotes,
  };
  const markdown = renderSummary(report);
  deps.summary(renderSummary(report, { marker: false }));

  // Writing to the PR needs a token that can write. Pull requests from forks don't get one, and a
  // missing permission shouldn't lose the review: the job summary above already has it.
  const restricted = pr.eventName === "pull_request" && pr.isFork;
  if (restricted) {
    deps.info("Pull request from a fork: the token is read-only, so the result is in the job summary only.");
  } else {
    if (inputs.checkRun) {
      await attempt(deps, "check run", () =>
        gh.createCheckRun({
          name: CHECK_NAME,
          headSha: pr.headSha,
          conclusion,
          title: checkTitle(verdict, counts),
          summary: markdown,
          annotations: annotationsFor(findings),
        }),
      );
    }
    if (inputs.summaryComment) await attempt(deps, "summary comment", () => upsertSummaryComment(gh, pr.number, markdown));
    if (inputs.inlineComments && parsed) {
      const input = parsed;
      await attempt(deps, "inline comments", async () => deps.info(await syncInlineComments(gh, pr, findings, input)));
    }
  }

  return { verdict, counts, conclusion, incomplete: verdict === "incomplete", summary: markdown };
}

async function attempt(deps: Deps, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    deps.warn(`Couldn't write the ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Edit the Action's own earlier comment, found by its marker; a comment from a person is never touched. */
export async function upsertSummaryComment(gh: Pick<GitHubClient, "listIssueComments" | "createComment" | "updateComment">, number: number, body: string): Promise<void> {
  const comments = await gh.listIssueComments(number);
  const mine = comments.find((c) => c.user?.type === "Bot" && c.body?.includes(SUMMARY_MARKER));
  if (mine) await gh.updateComment(mine.id, body);
  else await gh.createComment(number, body);
}

function waivedFindings(findings: Finding[], exceptions: LoadedExceptions): Waived[] {
  const byId = new Map(exceptions.active.map((e) => [e.id, e]));
  return findings.flatMap((f) => {
    const e = f.waivedBy ? byId.get(f.waivedBy) : undefined;
    return e ? [{ finding: f, exceptionId: e.id, reason: e.reason, approvedBy: e.approvedBy, expires: e.expires }] : [];
  });
}

/**
 * Inline comments (design §6): one review with a comment per new violation on its line, and the
 * Action's earlier comments kept in step. A comment is matched by the fingerprint it carries, so a
 * re-run posts nothing twice; one whose finding is gone is edited to say so (GitHub has no API to
 * mark a comment outdated), and put back if the finding returns. People's comments are never touched.
 */
export async function syncInlineComments(gh: Pick<GitHubClient, "listReviewComments" | "createReview" | "updateReviewComment">, pr: PrContext, findings: Finding[], input: ParsedInput): Promise<string> {
  const commentable = new Map(input.files.map((f) => [f.path, new Set(f.lines.map((l) => l.n))]));
  const plan = planInline(findings, commentable);
  const mine = new Map<string, { id: number; body: string }>();
  for (const c of await gh.listReviewComments(pr.number)) {
    const fp = c.user?.type === "Bot" ? fingerprintOf(c.body) : null;
    if (fp && c.body !== undefined) mine.set(fp, { id: c.id, body: c.body });
  }

  let restored = 0;
  let staled = 0;
  for (const { fingerprint: fp, comment } of plan.candidates) {
    const old = mine.get(fp);
    if (old?.body.includes(STALE_MARKER)) {
      await gh.updateReviewComment(old.id, comment.body);
      restored++;
    }
  }
  for (const [fp, old] of mine) {
    if (!plan.current.has(fp) && !old.body.includes(STALE_MARKER)) {
      await gh.updateReviewComment(old.id, staleBody(old.body, pr.headSha));
      staled++;
    }
  }
  const fresh = plan.candidates.filter((c) => !mine.has(c.fingerprint));
  const posting = fresh.slice(0, MAX_INLINE_PER_RUN);
  if (posting.length) await gh.createReview(pr.number, pr.headSha, posting.map((c) => c.comment));
  const left = fresh.length - posting.length;
  return `Inline comments: ${posting.length} new${left ? ` (${left} more not posted: ${MAX_INLINE_PER_RUN} per run, see the summary)` : ""}, ${staled} marked no longer detected, ${restored} restored.`;
}
