// Cloudflare Workers AI over REST, for running outside a Worker. Same request as the app's binding
// client (worker/ai.ts): JSON mode with a schema, temperature 0 and a seed.
import { BASE_SEED, type LlmClient } from "../llm.ts";
import { postJson, ProviderError, type FetchFn } from "./http.ts";

export const WORKERS_AI_DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface WorkersAiOptions {
  apiKey: string;
  accountId: string;
  model?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export function workersAiRestClient(opts: WorkersAiOptions): LlmClient {
  if (!/^[0-9a-f]{32}$/i.test(opts.accountId)) throw new ProviderError("workers-ai: cloudflare-account-id must be a 32-character hex id", undefined, false);
  const model = opts.model || WORKERS_AI_DEFAULT_MODEL;
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${model}`;
  return {
    model,
    async json(messages, schema, callOpts) {
      const res = (await postJson(
        url,
        { authorization: `Bearer ${opts.apiKey}` },
        {
          messages,
          response_format: { type: "json_schema", json_schema: schema },
          temperature: 0,
          seed: callOpts?.seed ?? BASE_SEED,
          max_tokens: callOpts?.maxTokens ?? 1024,
        },
        { fetch: opts.fetch, timeoutMs: opts.timeoutMs, provider: "workers-ai" },
      )) as { success?: boolean; result?: { response?: unknown } };
      const out = res?.result?.response;
      if (res?.success === false || out === undefined || out === null) throw new ProviderError("workers-ai: no response in the result", 200, true);
      return out;
    },
  };
}
