// Shared HTTP plumbing for the provider adapters. Every adapter takes an injectable `fetch`, so the
// tests can mock it and the Action can wrap it to count each request against `max-ai-calls`.

export type FetchFn = typeof fetch;

/** Per-request timeout. A review call that takes longer than this is treated as failed. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Output-token ceiling for providers whose models think before answering (the thinking counts
 * against the limit). The engine asks for 2,048 tokens of findings; a lower ceiling here would cut
 * the answer off mid-JSON.
 */
export const MIN_MAX_TOKENS = 16_000;

/**
 * A failed provider call. `retryable` is false for errors a retry can't fix (a bad key, a model
 * that doesn't exist, a request the server rejects), so the engine stops retrying them.
 */
export class ProviderError extends Error {
  override name = "ProviderError";
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(message: string, status: number | undefined, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** 408, 409, 429 and 5xx can succeed on a later attempt; other 4xx can't. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export interface PostOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  provider: string;
}

/** POST JSON and return the parsed body, or throw a ProviderError. Never echoes request headers. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, opts: PostOptions): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ProviderError(`${opts.provider}: ${timedOut ? "request timed out" : `network error (${e instanceof Error ? e.message : String(e)})`}`, undefined, true);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`${opts.provider}: HTTP ${res.status}: ${errorDetail(text)}`, res.status, isRetryableStatus(res.status));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${opts.provider}: the response is not JSON`, res.status, true);
  }
}

/** The provider's error message, if the body has one, cut short so a log line stays readable. */
export function errorDetail(body: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; errors?: { message?: unknown }[]; message?: unknown };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.errors?.[0]?.message ?? j.message);
    if (typeof m === "string") msg = m;
  } catch {
    // not JSON: use the text as it is
  }
  msg = msg.replace(/\s+/g, " ").trim();
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg || "(no detail)";
}

/**
 * The same schema with `additionalProperties: false` on every object, as strict structured
 * output modes (OpenAI strict, Anthropic) require. The input isn't modified.
 */
export function strictSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(strictSchema) as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = strictSchema(v);
  if (out.type === "object" && !("additionalProperties" in out)) out.additionalProperties = false;
  return out as T;
}
