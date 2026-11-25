// Which AI the web app uses, from its settings (LLM_MODE and friends). Pure, so it is tested
// without a Worker; worker/ai.ts builds the client from it.
import { PROVIDERS, type ProviderName } from "./providers/index.ts";

export type LlmMode = "off" | "fake" | Exclude<ProviderName, "none">;
export const LLM_MODES: readonly LlmMode[] = ["off", "fake", ...PROVIDERS.filter((p): p is Exclude<ProviderName, "none"> => p !== "none")];

export interface AiSettings {
  LLM_MODE?: unknown;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

/** The configured mode, or null when LLM_MODE isn't one of the known values. */
export function llmModeOf(s: AiSettings): LlmMode | null {
  const m = String(s.LLM_MODE ?? "").trim();
  return (LLM_MODES as readonly string[]).includes(m) ? (m as LlmMode) : null;
}

/**
 * Why the AI can't be used as configured, or null when it can (or is deliberately off). Never
 * includes a setting's value, so it is safe to show in the UI.
 */
export function aiConfigError(s: AiSettings): string | null {
  const mode = llmModeOf(s);
  if (mode === null) return `LLM_MODE isn't one of ${LLM_MODES.join(", ")}.`;
  if (mode === "off" || mode === "fake") return null;
  if (!s.LLM_API_KEY?.trim()) return `LLM_MODE=${mode} needs the LLM_API_KEY secret.`;
  if (mode === "workers-ai" && !/^[0-9a-f]{32}$/i.test(s.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "")) {
    return "LLM_MODE=workers-ai needs CLOUDFLARE_ACCOUNT_ID (a 32-character hex id).";
  }
  return null;
}
