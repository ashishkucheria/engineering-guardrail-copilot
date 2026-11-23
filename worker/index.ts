// API Worker. Static assets (the React app) are served by the assets binding; only /api/* reaches
// this code (see run_worker_first in wrangler.jsonc).
import { MAX_INPUT_BYTES } from "../core/diff.ts";
import { review } from "../core/engine.ts";
import { canToggleStandard } from "../core/policy.ts";
import { snapshotOf } from "../core/standards.ts";
import type { User } from "../core/types.ts";
import * as db from "./db.ts";
import { ApiError, errorResponse, json, readJson } from "./http.ts";

const MAX_JSON_ESCAPE_FACTOR = 6;

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
  // The real limit is on the decoded input (below). The body cap only stops abuse: JSON escaping can
  // grow text up to 6x (a \uXXXX escape per byte), so a valid 100 KB input always fits under it.
  const body = await readJson(req, MAX_JSON_ESCAPE_FACTOR * MAX_INPUT_BYTES + 1_000);
  const input = body.input;
  if (typeof input !== "string" || input.trim() === "") throw new ApiError(400, "invalid_body", '"input" must be a non-empty string of code or a unified diff.');
  if (new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) {
    throw new ApiError(413, "input_too_large", `Input is over the ${MAX_INPUT_BYTES / 1000} KB limit.`);
  }

  // Snapshot every standard (enabled or not) before reviewing, so this review keeps the versions
  // and statuses it ran against even if the standards change later.
  const standards = (await db.listStandards(env.DB)).map(db.effective);
  const createdAt = new Date().toISOString();
  const t0 = Date.now();
  const result = await review(input, standards);
  const durationMs = Date.now() - t0;

  const id = crypto.randomUUID();
  await db.insertCompletedReview(env.DB, {
    id,
    authorId: user.id,
    inputKind: result.input.kind,
    inputText: input,
    verdict: result.verdict,
    coverage: result.coverage,
    snapshot: snapshotOf(standards),
    engine: result.engine,
    createdAt,
    completedAt: new Date().toISOString(),
    findings: result.findings,
    events: [
      { step: "parse", outcome: "ok", durationMs: 0, detail: `${result.input.kind}, ${result.coverage.filesReviewed} of ${result.coverage.filesTotal} file(s)` },
      { step: "rules", outcome: "ok", durationMs, detail: `${result.findings.length} finding(s)` },
    ],
  });
  console.log(JSON.stringify({ event: "review_completed", review: id, verdict: result.verdict, findings: result.findings.length, ms: durationMs }));
  return json(await db.getReview(env.DB, id), 201);
});

route("GET", "/api/reviews", async ({ req, env, url }) => {
  await requireUser(req, env);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100);
  return json(await db.listReviews(env.DB, limit));
});

route("GET", "/api/reviews/:id", async ({ req, env, params }) => {
  await requireUser(req, env);
  const r = await db.getReview(env.DB, params.id!);
  if (!r) throw new ApiError(404, "not_found", "No such review.");
  return json(r);
});

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
