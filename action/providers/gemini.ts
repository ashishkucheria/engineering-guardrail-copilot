// Google Gemini through the Interactions API, which Google recommends over the legacy
// generateContent. JSON comes from response_format with a schema. `store: false` so Google doesn't
// keep the reviewed code for later retrieval. Temperature isn't sent: current Gemini models ignore it.
import type { LlmClient } from "../../core/llm.ts";
import { MIN_MAX_TOKENS, postJson, ProviderError, type FetchFn } from "./http.ts";

export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_API_REVISION = "2026-05-20";
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

interface Step {
  type?: string;
  content?: { type?: string; text?: unknown }[];
}

export function geminiClient(opts: GeminiOptions): LlmClient {
  const model = opts.model || GEMINI_DEFAULT_MODEL;
  return {
    model,
    async json(messages, schema, callOpts) {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const turns = messages.filter((m) => m.role !== "system");
      // The Action only makes single-turn calls (detection). Multi-turn would need previous_interaction_id.
      if (turns.length !== 1 || turns[0]!.role !== "user") throw new ProviderError("gemini: only single-turn requests are supported", undefined, false);
      const res = (await postJson(
        GEMINI_URL,
        { "x-goog-api-key": opts.apiKey, "api-revision": GEMINI_API_REVISION },
        {
          model,
          input: turns[0]!.content,
          ...(system ? { system_instruction: system } : {}),
          response_format: { type: "text", mime_type: "application/json", schema },
          generation_config: {
            max_output_tokens: Math.max(callOpts?.maxTokens ?? 0, MIN_MAX_TOKENS),
            ...(callOpts?.seed === undefined ? {} : { seed: callOpts.seed }),
          },
          store: false,
        },
        { fetch: opts.fetch, timeoutMs: opts.timeoutMs, provider: "gemini" },
      )) as { status?: string; steps?: Step[] };
      if (res?.status !== "completed") throw new ProviderError(`gemini: interaction ended with status ${String(res?.status ?? "missing")}`, 200, true);
      const text = (res.steps ?? [])
        .filter((s) => s.type === "model_output")
        .flatMap((s) => s.content ?? [])
        .flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : []))
        .join("");
      if (text.trim() === "") throw new ProviderError("gemini: no text in the response", 200, true);
      return text;
    },
  };
}
