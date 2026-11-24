// API Worker. Static assets (the React app) are served by the assets binding; only /api/* reaches
// this code (see run_worker_first in wrangler.jsonc). Reviews run in the ReviewWorkflow.
import type { ChallengeResult, MetaView } from "../core/api-types.ts";
import { renderLine } from "../core/chunk.ts";
import { MAX_INPUT_BYTES, parseInput } from "../core/diff.ts";
import { llmDetector, parseJsonResponse } from "../core/llm.ts";
import { canChallenge, canToggleStandard } from "../core/policy.ts";
import { buildChallengeMessages, CHALLENGE_SCHEMA, PROMPT_VERSION } from "../core/prompts.ts";
import { redactSecrets } from "../core/rules.ts";
import { snapshotOf } from "../core/standards.ts";
import type { User } from "../core/types.ts";
import { llmClient, llmMode } from "./ai.ts";
import { budgetLimit, reserve, secondsUntilReset, usage, utcDay, type Bucket } from "./budget.ts";
import * as db from "./db.ts";
import { ApiError, errorResponse, json, readJson } from "./http.ts";

export { ReviewWorkflow } from "./review-workflow.ts";

const MAX_JSON_ESCAPE_FACTOR = 6;
/** A review still queued or running after this long is checked against its Workflow (design §5). */
const STALE_AFTER_MS = 15 * 60 * 1000;
const MAX_ARGUMENT_CHARS = 2_000;
const CHALLENGE_CONTEXT_LINES = 10;

type Handler = (ctx: { req: Request; env: Env; params: Record<string, string>; url: URL }) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  routes.push({ method, pattern, keys, handler });
}

/** Demo identity: trusts the X-Demo-User header. NOT authentication; see README. */
async function requireUser(req: Request, env: Env): Promise<User> {
  const id = req.headers.get("x-demo-user");
  if (!id) throw new ApiError(401, "no_identity", "Pick a demo user (X-Demo-User header).");
  const user = await db.getUser(env.DB, id);
  if (!user) throw new ApiError(401, "unknown_user", `Unknown demo user "${id}".`);
  return user;
}

/** The review input: a non-empty string, at most 100 KB decoded. */
function readInput(body: Record<string, unknown>): string {
  const input = body.input;
  if (typeof input !== "string" || input.trim() === "") throw new ApiError(400, "invalid_body", '"input" must be a non-empty string of code or a unified diff.');
  if (new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) {
    throw new ApiError(413, "input_too_large", `Input is over the ${MAX_INPUT_BYTES / 1000} KB limit.`);
  }
  return input;
}

// The real limit is on the decoded input. The body cap only stops abuse: JSON escaping can grow
// text up to 6x (a \uXXXX escape per byte), so a valid 100 KB input always fits under it.
const INPUT_BODY_CAP = MAX_JSON_ESCAPE_FACTOR * MAX_INPUT_BYTES + 1_000;

// --- Users ----------------------------------------------------------------------------------

route("GET", "/api/users", async ({ env }) => json(await db.listUsers(env.DB)));

// --- Standards ------------------------------------------------------------------------------

route("GET", "/api/standards", async ({ req, env }) => {
  await requireUser(req, env);
  return json(await db.listStandards(env.DB));
});

route("GET", "/api/standards/:id/changes", async ({ req, env, params }) => {
  await requireUser(req, env);
  if (!(await db.getStandard(env.DB, params.id!))) throw new ApiError(404, "not_found", `No standard ${params.id}.`);
  return json(await db.listStandardChanges(env.DB, params.id!));
});

route("PATCH", "/api/standards/:id", async ({ req, env, params }) => {
  const user = await requireUser(req, env);
  const decision = canToggleStandard(user);
  if (!decision.ok) throw new ApiError(403, decision.code, decision.message);
  const body = await readJson(req, 1_000);
  if (typeof body.enabled !== "boolean") throw new ApiError(400, "invalid_body", '"enabled" must be true or false.');
  const current = await db.getStandard(env.DB, params.id!);
  if (!current) throw new ApiError(404, "not_found", `No standard ${params.id}.`);
  if (current.retiredAt) throw new ApiError(409, "retired", `${current.id} was retired (its YAML file was removed) and can't be toggled.`);
  // Conditional update: if a concurrent request already made this change, nothing is written and
  // no second audit row appears (see setStandardEnabled).
  if (current.enabled !== body.enabled && (await db.setStandardEnabled(env.DB, current.id, body.enabled, user.id, new Date().toISOString()))) {
    console.log(JSON.stringify({ event: "standard_toggled", standard: current.id, enabled: body.enabled, by: user.id }));
  }
  return json(await db.getStandard(env.DB, current.id));
});

// --- Reviews --------------------------------------------------------------------------------

route("POST", "/api/reviews", async ({ req, env }) => {
  const user = await requireUser(req, env);
  const input = readInput(await readJson(req, INPUT_BODY_CAP));

  // Snapshot every standard (enabled or not) at submit, so this review keeps the versions and
  // statuses it ran against even if the standards change while it runs, or later.
  const standards = (await db.listStandards(env.DB)).map(db.effective);
  const client = llmClient(env);
  const id = crypto.randomUUID();
  await db.insertQueuedReview(env.DB, {
    id,
    authorId: user.id,
    inputKind: parseInput(input).kind,
    inputText: input,
    snapshot: snapshotOf(standards),
    engine: client ? `rules+llm(${PROMPT_VERSION})` : "rules",
    promptVersion: client ? PROMPT_VERSION : null,
    model: client?.model ?? null,
    createdAt: new Date().toISOString(),
  });
  try {
    await env.REVIEW_WORKFLOW.create({ id, params: { reviewId: id } });
  } catch (e) {
    // Never leave a queued row that nothing will pick up.
    await db.markReviewFailed(env.DB, id, `Could not start the review pipeline: ${String(e)}`, new Date().toISOString());
    console.error(JSON.stringify({ event: "workflow_create_failed", review: id, error: String(e) }));
    throw new ApiError(503, "pipeline_unavailable", "Could not start the review. Try again in a moment.");
  }
  return json({ id, status: "queued" }, 202);
});

route("GET", "/api/reviews", async ({ req, env, url }) => {
  await requireUser(req, env);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100);
  return json(await db.listReviews(env.DB, limit));
});

route("GET", "/api/reviews/:id", async ({ req, env, params }) => {
  const user = await requireUser(req, env);
  const id = params.id!;
  // Backstop: a review stuck in queued/running for 15 minutes is checked against its Workflow
  // instance, and recorded as failed if the instance errored, was terminated or doesn't exist.
  if (await db.isStale(env.DB, id, new Date(Date.now() - STALE_AFTER_MS).toISOString())) {
    let status: string;
    try {
      status = (await (await env.REVIEW_WORKFLOW.get(id)).status()).status;
    } catch {
      status = "missing";
    }
    if (status === "errored" || status === "terminated" || status === "missing" || status === "unknown") {
      await db.markReviewFailed(env.DB, id, `The review pipeline stopped (Workflow status: ${status}).`, new Date().toISOString());
    }
  }
  const r = await db.getReview(env.DB, id);
  if (!r) throw new ApiError(404, "not_found", "No such review.");
  return json({ ...r, viewerCanChallenge: canChallenge(user, r.author.id).ok });
});

// --- Challenges -----------------------------------------------------------------------------

route("POST", "/api/findings/:id/challenge", async ({ req, env, params }) => {
  const user = await requireUser(req, env);
  const body = await readJson(req, 4 * MAX_ARGUMENT_CHARS + 1_000);
  const argument = typeof body.argument === "string" ? body.argument.trim() : "";
  if (!argument || argument.length > MAX_ARGUMENT_CHARS) {
    throw new ApiError(400, "invalid_body", `"argument" must be 1 to ${MAX_ARGUMENT_CHARS} characters explaining why the finding is wrong.`);
  }
  const f = await db.getFindingForChallenge(env.DB, params.id!);
  if (!f) throw new ApiError(404, "not_found", "No such finding.");
  const allowed = canChallenge(user, f.reviewAuthorId);
  if (!allowed.ok) throw new ApiError(403, allowed.code, allowed.message);
  if (f.challengeOutcome) throw new ApiError(409, "already_challenged", "This finding has already been challenged.");
  const client = llmClient(env);
  if (!client) throw new ApiError(503, "ai_off", "AI is turned off, so challenges can't be assessed.");
  await reserveOr429(env, "app", 1);

  const file = parseInput(f.inputText).files.find((x) => x.path === f.file);
  const code = (file?.lines ?? [])
    .filter((l) => l.n >= f.lineStart - CHALLENGE_CONTEXT_LINES && l.n <= f.lineEnd + CHALLENGE_CONTEXT_LINES)
    .map(renderLine)
    .join("\n");
  let assessment: "upheld" | "not_supported";
  let reasoning: string;
  try {
    const raw = parseJsonResponse(
      await client.json(
        buildChallengeMessages({ standard: { id: f.standardId, title: f.standardTitle, rule: f.standardRule }, finding: f, code, argument }),
        CHALLENGE_SCHEMA,
        { maxTokens: 512 },
      ),
    ) as { assessment?: unknown; reasoning?: unknown } | null;
    if (!raw || (raw.assessment !== "upheld" && raw.assessment !== "not_supported") || typeof raw.reasoning !== "string") throw new Error("malformed assessment");
    assessment = raw.assessment;
    reasoning = redactSecrets(raw.reasoning.trim()).slice(0, 2_000);
  } catch (e) {
    console.error(JSON.stringify({ event: "challenge_ai_failed", finding: f.id, error: String(e) }));
    throw new ApiError(502, "ai_unavailable", "The AI couldn't assess the challenge. Nothing was recorded; try again.");
  }
  // A rule finding is deterministic: it is always upheld, and the model only explains. An AI finding
  // is marked disputed when the model finds the argument holds. Neither changes the verdict.
  const outcome = f.source === "rule" ? "upheld" : assessment === "not_supported" ? "disputed" : "upheld";
  const recorded = await db.recordChallenge(env.DB, { findingId: f.id, userId: user.id, argument, outcome, assessment: { assessment, reasoning }, at: new Date().toISOString() });
  if (!recorded) throw new ApiError(409, "already_challenged", "This finding has already been challenged.");
  console.log(JSON.stringify({ event: "finding_challenged", finding: f.id, source: f.source, assessment, outcome, by: user.id }));
  const finding = (await db.getReview(env.DB, f.reviewId))!.findings.find((x) => x.id === f.id)!;
  return json({ assessment, reasoning, finding } satisfies ChallengeResult);
});

// --- Meta and eval --------------------------------------------------------------------------

route("GET", "/api/meta", async ({ env }) => {
  const now = new Date();
  const used = await usage(env.DB, now);
  const mode = llmMode(env);
  return json({
    llmMode: mode,
    model: llmClient(env)?.model ?? null,
    promptVersion: PROMPT_VERSION,
    budget: {
      day: utcDay(now),
      app: { used: used.app, limit: budgetLimit(env, "app") },
      eval: { used: used.eval, limit: budgetLimit(env, "eval") },
    },
  } satisfies MetaView);
});

/**
 * The AI detector run synchronously for the eval runner (design §8), without the Workflow. Only
 * reachable with the EVAL_TOKEN secret, and it spends the separate eval budget. Every non-retired
 * standard counts as enabled, so a toggle in the UI can't skew an eval run.
 */
route("POST", "/api/eval/detect", async ({ req, env }) => {
  const token = env.EVAL_TOKEN;
  if (!token || !(await sameSecret(req.headers.get("authorization") ?? "", `Bearer ${token}`))) {
    throw new ApiError(404, "not_found", "No API route /api/eval/detect.");
  }
  const input = readInput(await readJson(req, INPUT_BODY_CAP));
  const client = llmClient(env);
  if (!client) throw new ApiError(503, "ai_off", "AI is turned off (LLM_MODE=off).");
  const standards = (await db.listStandards(env.DB)).filter((s) => !s.retiredAt).map((s) => ({ ...s, enabled: true }));
  const parsed = parseInput(input);
  const t0 = Date.now();
  const chunks: { chunk: string; outcome: string; detail: string }[] = [];
  const now = new Date();
  // One reservation per model call, retries included (review of PR #3, item 1).
  const r = await llmDetector(client, {
    attempts: 2,
    reserve: () => reserve(env.DB, "eval", 1, budgetLimit(env, "eval"), new Date()),
    onChunk: (chunk, outcome, detail) => chunks.push({ chunk, outcome, detail }),
  }).detect(parsed, standards, input);
  if (chunks.some((c) => c.outcome === "skipped")) {
    // A partly reviewed case would be scored as missed findings; stop the run instead.
    console.log(JSON.stringify({ event: "budget_exhausted", bucket: "eval" }));
    throw new ApiError(429, "budget_exhausted", "Today's eval AI budget is used up. It resets at midnight UTC.", { "retry-after": String(secondsUntilReset(now)) });
  }
  return json({ ...r, chunks, model: client.model, promptVersion: PROMPT_VERSION, ms: Date.now() - t0 });
});

async function reserveOr429(env: Env, bucket: Bucket, calls: number): Promise<void> {
  const now = new Date();
  if (await reserve(env.DB, bucket, calls, budgetLimit(env, bucket), now)) return;
  console.log(JSON.stringify({ event: "budget_exhausted", bucket, calls }));
  throw new ApiError(429, "budget_exhausted", "Today's AI budget for this demo is used up. It resets at midnight UTC.", {
    "retry-after": String(secondsUntilReset(now)),
  });
}

/** Constant-time comparison via SHA-256, so the token can't be guessed byte by byte from timing. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// --- Rate limits (design §10) ---------------------------------------------------------------

const CHALLENGE_OR_CHAT = /^\/api\/(findings\/[^/]+\/challenge|reviews\/[^/]+\/chat)$/;
const ONE_REVIEW = /^\/api\/reviews\/[^/]+$/;

function limiterFor(req: Request, env: Env, path: string): RateLimit {
  if (req.method === "POST" && path === "/api/reviews") return env.RL_REVIEW;
  if (req.method === "POST" && CHALLENGE_OR_CHAT.test(path)) return env.RL_LLM;
  // The UI polls a running review; that has its own limit so polling can't lock out the rest of
  // the API, or be locked out by it (review of PR #3, item 2).
  if (req.method === "GET" && ONE_REVIEW.test(path)) return env.RL_POLL;
  return env.RL_API;
}

/** Per-IP burst limits, keyed by CF-Connecting-IP (set by Cloudflare), never by X-Demo-User. */
async function checkRateLimit(req: Request, env: Env, path: string): Promise<void> {
  const limiter = limiterFor(req, env, path);
  const { success } = await limiter.limit({ key: req.headers.get("cf-connecting-ip") ?? "unknown" });
  if (!success) {
    console.log(JSON.stringify({ event: "rate_limited", method: req.method, path }));
    throw new ApiError(429, "rate_limited", "Too many requests. Wait a minute and try again.", { "retry-after": "60" });
  }
}

function decodeParams(keys: string[], m: RegExpExecArray): Record<string, string> {
  try {
    return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
  } catch {
    throw new ApiError(400, "invalid_path", "The URL contains a malformed percent-escape.");
  }
}

// --------------------------------------------------------------------------------------------

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    try {
      await checkRateLimit(req, env, url.pathname);
      let methodMismatch = false;
      for (const r of routes) {
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        if (r.method !== req.method) {
          methodMismatch = true;
          continue;
        }
        const params = decodeParams(r.keys, m);
        return await r.handler({ req, env, params, url });
      }
      if (methodMismatch) throw new ApiError(405, "method_not_allowed", `${req.method} is not supported here.`);
      throw new ApiError(404, "not_found", `No API route ${url.pathname}.`);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      console.error(JSON.stringify({ event: "unhandled_error", path: url.pathname, error: String(err), stack: err instanceof Error ? err.stack : undefined }));
      return errorResponse(new ApiError(500, "internal_error", "Something went wrong. The error was logged."));
    }
  },
} satisfies ExportedHandler<Env>;
