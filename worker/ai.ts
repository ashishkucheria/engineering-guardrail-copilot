// LLM clients for the web app. A real provider (OpenAI-compatible, Anthropic, Gemini or Workers AI)
// goes through the same clients as the Action (core/providers), configured by LLM_MODE plus the
// LLM_API_KEY secret. `fake` is a deterministic stand-in for the smoke test and CI: it makes no
// network call and costs nothing, so the whole pipeline (Workflow, verification, persistence,
// challenge) can be tested without a model.
import { aiConfigError, llmModeOf, type AiSettings, type LlmMode } from "../core/ai-config.ts";
import type { LlmClient } from "../core/llm.ts";
import { createClient } from "../core/providers/index.ts";
import { ApiError } from "./http.ts";

export { aiConfigError, type LlmMode };

/**
 * Well under the review step's 2-minute timeout, so a slow provider fails as a provider error the
 * Workflow can retry, not as a step timeout. A normal call takes about 10 s (one chunk is at most
 * 8,000 characters and the reply is small JSON), so 60 s is generous while a hung request (seen
 * with Gemini under load) costs 60 s rather than 100 s before the retry.
 */
const PROVIDER_TIMEOUT_MS = 60_000;

export const llmMode = (env: AiSettings): LlmMode | null => llmModeOf(env);

/** null when AI is turned off. Throws a 503 when it is configured wrongly (never a silent rules-only run). */
export function llmClient(env: AiSettings): LlmClient | null {
  const error = aiConfigError(env);
  if (error) throw new ApiError(503, "ai_misconfigured", `AI is misconfigured: ${error}`);
  const mode = llmMode(env)!;
  if (mode === "off") return null;
  if (mode === "fake") return fakeClient;
  return createClient({
    provider: mode,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    baseUrl: env.LLM_BASE_URL,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
}

// ---------------------------------------------------------------------------------------------
// Fake model (LLM_MODE=fake). Recognises a few patterns so tests have something to find:
//   fetch( without "signal"    → REL-002, definite
//   catch (e) {}               → REL-001, definite
//   FAKE_LLM_HALLUCINATE       → an extra finding whose evidence isn't in the code (must be dropped)
//   FAKE_LLM_FAIL              → the call fails (the chunk must become a coverage gap)
// Challenges: an argument containing "not_supported" is assessed as not supported.
// Chat: replies with the number of findings it was given and echoes the question.

export const fakeClient: LlmClient = {
  model: "fake",
  async json(messages, schema) {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    if ("reply" in props) {
      const question = messages.at(-1)?.content ?? "";
      const findings = /Findings \((\d+)\)/.exec(user)?.[1] ?? "?";
      return { reply: `Fake model: this review has ${findings} finding(s). You asked: ${question.slice(0, 80)}` };
    }
    if ("assessment" in props) {
      const arg = /BEGIN ARGUMENT ([0-9a-f]+)\n([\s\S]*)\nEND ARGUMENT \1/.exec(user)?.[2] ?? "";
      return arg.includes("not_supported")
        ? { assessment: "not_supported", reasoning: "Fake model: the argument was accepted." }
        : { assessment: "upheld", reasoning: "Fake model: the finding stands." };
    }
    const code = /BEGIN CODE ([0-9a-f]+)\n([\s\S]*)\nEND CODE \1/.exec(user)?.[2] ?? "";
    if (code.includes("FAKE_LLM_FAIL")) throw new Error("Fake model failure (FAKE_LLM_FAIL in the code).");
    const allowed = new Set(((props.findings as { items: { properties: { standard_id: { enum: string[] } } } }).items.properties.standard_id.enum) ?? []);
    const findings: Record<string, string>[] = [];
    const add = (standard_id: string, evidence: string, what: string) => {
      if (allowed.has(standard_id)) findings.push({ standard_id, certainty: "definite", evidence, explanation: `Fake model: ${what}.`, impact: "Fake impact.", remediation: "Fake remediation." });
    };
    for (const line of code.split("\n")) {
      const text = line.replace(/^\d+[+ ]\| /, "");
      if (/\bfetch\(/.test(text) && !/signal/.test(text)) add("REL-002", text.trim(), "fetch without a timeout");
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(text)) add("REL-001", text.trim(), "the error is swallowed");
      if (text.includes("FAKE_LLM_HALLUCINATE")) add("REL-003", "while (true) { retry(); } // not in the input", "a hallucinated quote");
    }
    return { findings };
  },
};
