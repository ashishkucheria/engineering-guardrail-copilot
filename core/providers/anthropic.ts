// Anthropic, through the official SDK. JSON comes from structured outputs (output_config.format):
// current Claude models reject forced tool use and sampling parameters (temperature, seed), so
// neither is sent. Server-side fallback ("default") lets the API re-run a request on its fallback
// model when the requested one declines; on a model without fallbacks the request runs as it is.
import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "../llm.ts";
import { DEFAULT_TIMEOUT_MS, MIN_MAX_TOKENS, ProviderError, isRetryableStatus, strictSchema, type FetchFn } from "./http.ts";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  /** For tests only. */
  baseUrl?: string;
}

export function anthropicClient(opts: AnthropicOptions): LlmClient {
  const model = opts.model || ANTHROPIC_DEFAULT_MODEL;
  const client = new Anthropic({
    apiKey: opts.apiKey,
    // The engine owns retries (each one counts against max-ai-calls), so the SDK makes one attempt.
    maxRetries: 0,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
  });
  return {
    model,
    async json(messages, schema, callOpts) {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const turns = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      let res;
      try {
        res = await client.beta.messages.create({
          model,
          max_tokens: Math.max(callOpts?.maxTokens ?? 0, MIN_MAX_TOKENS),
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          ...(system ? { system } : {}),
          messages: turns,
          output_config: { format: { type: "json_schema", schema: strictSchema(schema) } },
        });
      } catch (e) {
        if (e instanceof Anthropic.APIError) {
          const status = typeof e.status === "number" ? e.status : undefined;
          throw new ProviderError(`anthropic: ${status ? `HTTP ${status}: ` : ""}${e.message}`, status, status === undefined || isRetryableStatus(status));
        }
        throw e;
      }
      if (res.stop_reason === "refusal") throw new ProviderError("anthropic: the model declined this request", 200, true);
      if (res.stop_reason === "max_tokens") throw new ProviderError("anthropic: the answer was cut off at max_tokens", 200, true);
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (text.trim() === "") throw new ProviderError(`anthropic: no text in the response (stop_reason ${String(res.stop_reason)})`, 200, true);
      return text;
    },
  };
}
