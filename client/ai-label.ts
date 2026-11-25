import type { MetaView } from "./api.ts";

const PROVIDER: Record<MetaView["llmMode"], string> = {
  off: "off",
  fake: "fake model for testing",
  "openai-compatible": "OpenAI-compatible API",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  "workers-ai": "Cloudflare Workers AI",
};

/** Whether new reviews can use AI at all. */
export const aiAvailable = (m: MetaView) => m.llmMode !== "off" && !m.aiError;

/** "Google Gemini (gemini-3.5-flash-lite)", "fake model for testing", "off" or "misconfigured". */
export function aiLabel(m: MetaView): string {
  if (m.aiError) return "misconfigured";
  const name = PROVIDER[m.llmMode];
  return m.model && m.llmMode !== "fake" ? `${name} (${m.model})` : name;
}

/** True when reviewed code leaves the server for a third party. */
export const sendsCodeOut = (m: MetaView) => aiAvailable(m) && m.llmMode !== "fake";
