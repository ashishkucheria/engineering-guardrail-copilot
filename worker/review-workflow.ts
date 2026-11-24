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
import { capFindings, capGap, finalize } from "../core/engine.ts";
import { BUDGET_REASON, describeDrops, detectChunk, llmStandards, seedFor, type ChunkResult } from "../core/llm.ts";
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
// Every attempt, retries included, reserves its own AI call first (review of PR #3, item 1), so a
// failing chunk can't make more calls than it reserved.
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
      // The standards snapshot and the exceptions active now. No feedback history: neither
      // detection nor the waiver step ever sees it (design §6), so rejections can't suppress anything.
      const exceptions = await db.listActiveExceptions(env.DB, new Date());
      await db.addEvent(env.DB, id, "load-context", "ok", null, `${r.standards.filter((s) => s.enabled).length} enabled standard(s), ${exceptions.length} active exception(s)`);
      return { ...r, exceptions };
    });
    if (ctx.status === "complete" || ctx.status === "failed") return { skipped: `review already ${ctx.status}` };

    const input = parseInput(ctx.inputText);
    const enabled = ctx.standards.filter((s) => s.enabled);

    await step.do("validate", DB_STEP, async () => {
      const c = input.coverage;
      await db.addEvent(env.DB, id, "validate", "ok", null, `${input.kind}, ${c.filesReviewed} of ${c.filesTotal} file(s)${c.skipped.length ? `, ${c.skipped.length} skipped` : ""}`);
    });

    const rules = await step.do("rules", DB_STEP, async () => {
      const t0 = Date.now();
      // Capped here, not only in finalize: the step's return value is limited to 1 MiB, and an
      // input full of TODOs or secrets can produce thousands of findings (review of PR #3, item 5).
      const capped = capFindings(runRules(input, enabled));
      await db.addEvent(env.DB, id, "rules", "ok", Date.now() - t0, `${capped.findings.length} finding(s)${capped.dropped ? `, ${capped.dropped} over the cap dropped` : ""}`);
      return capped;
    });

    // --- AI detection ------------------------------------------------------------------------
    const standards = llmStandards(enabled);
    const plan = planChunks(input);
    const client = llmClient(env);
    const skipped: Coverage["skipped"] = rules.dropped ? [capGap(rules.dropped)] : [];
    const llmFindings: Finding[] = [];

    if (standards.length > 0 && plan.chunks.length > 0) {
      skipped.push(...plan.skipped);
      if (!client) {
        skipped.push(...plan.chunks.map((c) => ({ file: chunkLabel(c), reason: "AI review is turned off" })));
        await step.do("detect", DB_STEP, () => db.addEvent(env.DB, id, "detect", "skipped", null, "AI review is turned off (LLM_MODE=off)"));
      } else {
        let budgetOut = false;
        for (const [i, chunk] of plan.chunks.entries()) {
          const label = chunkLabel(chunk);
          if (budgetOut) {
            skipped.push({ file: label, reason: BUDGET_REASON });
            continue;
          }
          const name = `detect:${i + 1}:${label}`.slice(0, 200);
          try {
            const r: ChunkResult = await step.do(name, DETECT_STEP, async (sctx) => {
              if (!(await reserve(env.DB, "app", 1, budgetLimit(env, "app"), new Date()))) {
                console.log(JSON.stringify({ event: "budget_exhausted", bucket: "app", review: id }));
                throw new NonRetryableError(BUDGET_REASON);
              }
              const t0 = Date.now();
              try {
                const res = await detectChunk(client, chunk, standards, { seed: seedFor(sctx.attempt) });
                await db.addEvent(env.DB, id, `detect:${label}`, "ok", Date.now() - t0, describeDrops(res));
                return res;
              } catch (e) {
                await db.addEvent(env.DB, id, `detect:${label}`, "retry", Date.now() - t0, `attempt ${sctx.attempt}: ${message(e)}`).catch(() => {});
                throw e;
              }
            });
            llmFindings.push(...r.findings);
          } catch (e) {
            if (message(e).includes(BUDGET_REASON)) {
              // The day's budget ran out: this chunk and every later one are coverage gaps.
              budgetOut = true;
              skipped.push({ file: label, reason: BUDGET_REASON });
              await step.do(`${name}:budget`.slice(0, 250), DB_STEP, () => db.addEvent(env.DB, id, "budget", "skipped", null, `${BUDGET_REASON}; ${plan.chunks.length - i} chunk(s) not sent to the AI`));
              continue;
            }
            // Out of retries: this chunk is a coverage gap, the review goes on (never a silent pass).
            skipped.push({ file: label, reason: `AI review failed: ${message(e).slice(0, 200)}` });
            await step.do(`${name}:failed`.slice(0, 250), DB_STEP, () => db.addEvent(env.DB, id, `detect:${label}`, "failed", null, message(e)));
          }
        }
      }
    }

    // --- Verify happened per chunk; apply exceptions, finalize and persist ---------------------
    const result = finalize(input, [...rules.findings, ...llmFindings], skipped, ctx.exceptions);
    const waived = result.findings.filter((f) => f.waivedBy);
    await step.do("apply-exceptions", DB_STEP, () =>
      db.addEvent(env.DB, id, "apply-exceptions", "ok", null, waived.length ? `${waived.length} finding(s) waived by ${[...new Set(waived.map((f) => f.waivedBy))].join(", ")}` : "nothing waived"),
    );
    await step.do("persist", PERSIST_STEP, async () => {
      await db.completeReview(env.DB, id, { ...result, completedAt: new Date().toISOString() });
      await db.addEvent(env.DB, id, "persist", "ok", null, `${result.findings.length} finding(s), verdict ${result.verdict}`);
    });
    console.log(JSON.stringify({ event: "review_completed", review: id, verdict: result.verdict, findings: result.findings.length, skipped: result.coverage.skipped.length }));
    return { verdict: result.verdict };
  }
}
