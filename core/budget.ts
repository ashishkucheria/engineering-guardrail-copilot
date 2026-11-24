// Pure parts of the daily AI budget (design §10). The counter itself is in D1 (worker/budget.ts).

export type Bucket = "app" | "eval";

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight, when the budget resets (for Retry-After). */
export function secondsUntilReset(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * The most app calls a day that a real model may get, whatever DAILY_LLM_CALLS_APP says. Only the
 * fake model may go higher (the smoke test needs more than 20 fake calls), so a .dev.vars copied
 * from the example can't spend 60 real calls after switching to workers-ai (review of PR #4).
 */
export const REAL_MODEL_APP_CEILING = 20;

export function appLimit(raw: unknown, mode: string): number {
  const n = parseLimit(raw);
  return mode === "fake" ? n : Math.min(n, REAL_MODEL_APP_CEILING);
}

/** A cap from its Wrangler var. Missing or invalid means 0: the budget fails closed, not open. */
export function parseLimit(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
