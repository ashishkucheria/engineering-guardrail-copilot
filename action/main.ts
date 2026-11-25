// Entry point: runner environment in, review, outputs and exit code out. All the logic is in run.ts.
import { readFileSync } from "node:fs";
import { GitHubClient } from "./github.ts";
import { PROVIDERS } from "../core/providers/index.ts";
import { appendJobSummary, error, getBoolean, getChoice, getInput, getPositiveInt, info, mask, setOutput, warning } from "./runner.ts";
import { reviewPullRequest, type Inputs, type PrContext } from "./run.ts";

interface Payload {
  pull_request?: { number: number; head: { sha: string; repo?: { full_name?: string } | null }; base: { sha: string } };
  repository?: { full_name?: string };
}

export function readInputs(env = process.env): Inputs {
  return {
    provider: getChoice("provider", PROVIDERS, "none", env),
    model: getInput("model", env),
    apiKey: getInput("api-key", env),
    baseUrl: getInput("base-url", env),
    cloudflareAccountId: getInput("cloudflare-account-id", env),
    standardsPath: getInput("standards-path", env).replace(/^\/+|\/+$/g, "") || ".guardrail/standards",
    failOn: getChoice("fail-on", ["none", "blocker", "major"] as const, "none", env),
    failOnIncomplete: getBoolean("fail-on-incomplete", false, env),
    checkRun: getBoolean("check-run", true, env),
    summaryComment: getBoolean("summary-comment", true, env),
    inlineComments: getBoolean("inline-comments", false, env),
    maxAiCalls: getPositiveInt("max-ai-calls", 20, env),
    maxFiles: getPositiveInt("max-files", 50, env),
  };
}

export function readPullRequest(env = process.env): { pr: PrContext; repo: string } {
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    throw new Error(`this Action reviews pull requests; run it on pull_request, not "${eventName || "(unknown event)"}"`);
  }
  if (!env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is not set");
  const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as Payload;
  const p = payload.pull_request;
  const repo = payload.repository?.full_name ?? env.GITHUB_REPOSITORY;
  if (!p || !repo) throw new Error("the event payload has no pull request");
  return {
    repo,
    pr: { number: p.number, headSha: p.head.sha, baseSha: p.base.sha, eventName, isFork: p.head.repo?.full_name !== repo },
  };
}

async function main(): Promise<void> {
  // Mask before anything can print them.
  mask(getInput("api-key"));
  mask(getInput("github-token"));
  const inputs = readInputs();
  const { pr, repo } = readPullRequest();
  const token = getInput("github-token");
  if (!token) throw new Error("github-token is empty");

  const outcome = await reviewPullRequest(pr, inputs, {
    github: new GitHubClient({ token, repo, apiUrl: process.env.GITHUB_API_URL }),
    summary: (md) => appendJobSummary(md),
    warn: warning,
    info,
  });

  setOutput("verdict", outcome.verdict);
  setOutput("violations", String(outcome.counts.violations));
  setOutput("blockers", String(outcome.counts.blockers));
  setOutput("incomplete", String(outcome.incomplete));
  info(`Guardrail: ${outcome.verdict} (${outcome.counts.violations} violations, ${outcome.counts.blockers} blockers); conclusion ${outcome.conclusion}.`);
  if (outcome.conclusion === "failure") {
    error(`Guardrail: ${outcome.verdict}; ${outcome.counts.violations} violation(s), ${outcome.counts.blockers} blocker(s). See the check run or the job summary.`);
    process.exitCode = 1;
  }
}

// Runs when bundled as the Action's entry point; importing this file in a test doesn't start a review.
if (process.env.GITHUB_ACTIONS === "true" && process.env.GUARDRAIL_NO_MAIN !== "1") {
  main().catch((e: unknown) => {
    error(`Guardrail couldn't review this pull request: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
