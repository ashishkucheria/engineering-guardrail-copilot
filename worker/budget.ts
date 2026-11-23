// The daily AI budget (design §10): a strict counter in D1. Every request that will call the model
// reserves its calls first, and a reservation that would go over the cap writes nothing. Reserved
// calls are never refunded; over-counting errs on the safe side.
import { parseLimit, utcDay, type Bucket } from "../core/budget.ts";

export { secondsUntilReset, utcDay, type Bucket } from "../core/budget.ts";

export function budgetLimit(env: Pick<Env, "DAILY_LLM_CALLS_APP" | "DAILY_LLM_CALLS_EVAL">, bucket: Bucket): number {
  return parseLimit(bucket === "app" ? env.DAILY_LLM_CALLS_APP : env.DAILY_LLM_CALLS_EVAL);
}

/**
 * Reserve `calls` model calls for today, atomically. Both statements run in one transaction, and
 * the UPDATE only applies if the new total stays within the cap, so concurrent reservations can't
 * overshoot it. Returns whether the reservation was made.
 */
export async function reserve(db: D1Database, bucket: Bucket, calls: number, limit: number, now: Date): Promise<boolean> {
  if (calls <= 0) return true;
  if (calls > limit) return false;
  const day = utcDay(now);
  const [, update] = await db.batch([
    db.prepare("INSERT OR IGNORE INTO llm_budget (day, bucket, used) VALUES (?, ?, 0)").bind(day, bucket),
    db.prepare("UPDATE llm_budget SET used = used + ?1 WHERE day = ?2 AND bucket = ?3 AND used + ?1 <= ?4").bind(calls, day, bucket, limit),
  ]);
  return (update?.meta.changes ?? 0) === 1;
}

export async function usage(db: D1Database, now: Date): Promise<Record<Bucket, number>> {
  const rows = await db.prepare("SELECT bucket, used FROM llm_budget WHERE day = ?").bind(utcDay(now)).all<{ bucket: Bucket; used: number }>();
  const out: Record<Bucket, number> = { app: 0, eval: 0 };
  for (const r of rows.results) out[r.bucket] = r.used;
  return out;
}
