// The review pipeline as a Cloudflare Workflow (design §5). One instance per review; the instance
// id is the review id. Status lives in D1 (kept current by the steps), so the UI never depends on
// Workflow internals.
//
// Steps return only small values. The parsed input and the chunk plan are recomputed from the
// stored input on every replay instead of being returned from a step: both are pure and
// deterministic, and that keeps step output far below the 1 MiB limit.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { chunkLabel, planChunks } from "../core/chunk.ts";
import { parseInput } from "../core/diff.ts";
import { finalize } from "../core/engine.ts";
import { describeDrops, detectChunk, llmStandards, type ChunkResult } from "../core/llm.ts";
import { runRules } from "../core/rules.ts";
import type { Coverage, Finding } from "../core/types.ts";
import { llmClient } from "./ai.ts";
import { budgetLimit, reserve } from "./budget.ts";
import * as db from "./db.ts";

export interface ReviewParams {
  reviewId: string;
}

const DB_STEP = { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" } as const;
const PERSIST_STEP = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" } as const;
const DETECT_STEP = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  override async run(event: WorkflowEvent<ReviewParams>, step: WorkflowStep): Promise<{ verdict: string } | { skipped: string }> {
    const id = event.payload.reviewId;
    try {
      return await this.pipeline(id, step);
    } catch (e) {
      // Anything that isn't a per-chunk AI failure fails the review, visibly.
      await step.do("mark-failed", DB_STEP, async () => {
        await db.addEvent(this.env.DB, id, "pipeline", "failed", null, message(e));
        await db.markReviewFailed(this.env.DB, id, message(e), new Date().toISOString());
      });
      console.error(JSON.stringify({ event: "review_failed", review: id, error: message(e) }));
      throw e;
    }
  }

  private async pipeline(id: string, step: WorkflowStep): Promise<{ verdict: string } | { skipped: string }> {
    const env = this.env;

    const ctx = await step.do("load-context", DB_STEP, async () => {
      const r = await db.loadReviewForRun(env.DB, id);
      if (!r) throw new NonRetryableError(`Review ${id} not found.`);
      if (r.status === "queued") await db.markReviewRunning(env.DB, id);
      // Standards snapshot only. No feedback history: detection never sees it (design §6).
      await db.addEvent(env.DB, id, "load-context", "ok", null, `${r.standards.filter((s) => s.enabled).length} enabled standard(s)`);
      return r;
    });
    if (ctx.status === "complete" || ctx.status === "failed") return { skipped: `review already ${ctx.status}` };

    const input = parseInput(ctx.inputText);
    const enabled = ctx.standards.filter((s) => s.enabled);

    await step.do("validate", DB_STEP, async () => {
      const c = input.coverage;
      await db.addEvent(env.DB, id, "validate", "ok", null, `${input.kind}, ${c.filesReviewed} of ${c.filesTotal} file(s)${c.skipped.length ? `, ${c.skipped.length} skipped` : ""}`);
    });

    const ruleFindings = await step.do("rules", DB_STEP, async () => {
      const t0 = Date.now();
      const found = runRules(input, enabled);
      await db.addEvent(env.DB, id, "rules", "ok", Date.now() - t0, `${found.length} finding(s)`);
      return found;
    });

    // --- AI detection ------------------------------------------------------------------------
    const standards = llmStandards(enabled);
    const plan = planChunks(input);
    const client = llmClient(env);
    const skipped: Coverage["skipped"] = [];
    const llmFindings: Finding[] = [];

    if (standards.length > 0 && plan.chunks.length > 0) {
      skipped.push(...plan.skipped);
      if (!client) {
        skipped.push(...plan.chunks.map((c) => ({ file: chunkLabel(c), reason: "AI review is turned off" })));
        await step.do("detect", DB_STEP, () => db.addEvent(env.DB, id, "detect", "skipped", null, "AI review is turned off (LLM_MODE=off)"));
      } else {
        const reserved = await step.do("budget", DB_STEP, async () => {
          const ok = await reserve(env.DB, "app", plan.chunks.length, budgetLimit(env, "app"), new Date());
          await db.addEvent(env.DB, id, "budget", ok ? "ok" : "skipped", null, ok ? `reserved ${plan.chunks.length} AI call(s)` : "daily AI budget reached");
          if (!ok) console.log(JSON.stringify({ event: "budget_exhausted", bucket: "app", review: id, calls: plan.chunks.length }));
          return ok;
        });
        if (!reserved) {
          skipped.push(...plan.chunks.map((c) => ({ file: chunkLabel(c), reason: "daily AI budget reached" })));
        } else {
          for (const [i, chunk] of plan.chunks.entries()) {
            const label = chunkLabel(chunk);
            const name = `detect:${i + 1}:${label}`.slice(0, 200);
            try {
              const r: ChunkResult = await step.do(name, DETECT_STEP, async () => {
                const t0 = Date.now();
                try {
                  const res = await detectChunk(client, chunk, standards);
                  await db.addEvent(env.DB, id, `detect:${label}`, "ok", Date.now() - t0, describeDrops(res));
                  return res;
                } catch (e) {
                  await db.addEvent(env.DB, id, `detect:${label}`, "retry", Date.now() - t0, message(e)).catch(() => {});
                  throw e;
                }
              });
              llmFindings.push(...r.findings);
            } catch (e) {
              // Out of retries: this chunk is a coverage gap, the review goes on (never a silent pass).
              skipped.push({ file: label, reason: `AI review failed: ${message(e).slice(0, 200)}` });
              await step.do(`${name}:failed`.slice(0, 250), DB_STEP, () => db.addEvent(env.DB, id, `detect:${label}`, "failed", null, message(e)));
            }
          }
        }
      }
    }

    // --- Verify happened per chunk; finalize and persist --------------------------------------
    const result = finalize(input, [...ruleFindings, ...llmFindings], skipped);
    await step.do("persist", PERSIST_STEP, async () => {
      await db.completeReview(env.DB, id, { ...result, completedAt: new Date().toISOString() });
      await db.addEvent(env.DB, id, "persist", "ok", null, `${result.findings.length} finding(s), verdict ${result.verdict}`);
    });
    console.log(JSON.stringify({ event: "review_completed", review: id, verdict: result.verdict, findings: result.findings.length, skipped: result.coverage.skipped.length }));
    return { verdict: result.verdict };
  }
}
