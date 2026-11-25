// One entry point for the Action: provider name and inputs in, LlmClient out (or null for `none`).
import type { LlmClient } from "../llm.ts";
import { anthropicClient } from "./anthropic.ts";
import { geminiClient } from "./gemini.ts";
import { ProviderError, type FetchFn } from "./http.ts";
import { openAiCompatibleClient } from "./openai-compatible.ts";
import { workersAiRestClient } from "./workers-ai.ts";

export const PROVIDERS = ["openai-compatible", "anthropic", "gemini", "workers-ai", "none"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderInputs {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  cloudflareAccountId?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export function createClient(i: ProviderInputs): LlmClient | null {
  const provider = i.provider.trim() as ProviderName;
  if (!PROVIDERS.includes(provider)) throw new ProviderError(`unknown provider "${i.provider}"; use one of ${PROVIDERS.join(", ")}`, undefined, false);
  if (provider === "none") return null;
  const apiKey = i.apiKey?.trim();
  if (!apiKey) throw new ProviderError(`provider ${provider} needs api-key`, undefined, false);
  const common = { apiKey, model: i.model?.trim() || undefined, fetch: i.fetch, timeoutMs: i.timeoutMs };
  switch (provider) {
    case "openai-compatible":
      return openAiCompatibleClient({ ...common, baseUrl: i.baseUrl?.trim() || undefined });
    case "anthropic":
      return anthropicClient(common);
    case "gemini":
      return geminiClient(common);
    case "workers-ai":
      if (!i.cloudflareAccountId?.trim()) throw new ProviderError("provider workers-ai needs cloudflare-account-id", undefined, false);
      return workersAiRestClient({ ...common, accountId: i.cloudflareAccountId.trim() });
  }
}
