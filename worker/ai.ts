// LLM clients. `workers-ai` calls Llama 3.3 in JSON mode. `fake` is a deterministic stand-in for
// the smoke test and CI: it makes no network call and costs nothing, so the whole pipeline
// (Workflow, verification, persistence, challenge) can be tested without the model.
import { BASE_SEED, type LlmClient } from "../core/llm.ts";
import type { ChatMessage, JsonSchema } from "../core/prompts.ts";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type LlmMode = "workers-ai" | "fake" | "off";

export function llmMode(env: Pick<Env, "LLM_MODE">): LlmMode {
  const m = String(env.LLM_MODE);
  return m === "fake" || m === "off" ? m : "workers-ai";
}

/** null when AI is turned off. */
export function llmClient(env: Env): LlmClient | null {
  const mode = llmMode(env);
  if (mode === "off") return null;
  if (mode === "fake") return fakeClient;
  return workersAiClient(env.AI);
}

type AiRun = (model: string, input: Record<string, unknown>) => Promise<{ response?: unknown }>;

export function workersAiClient(ai: Ai): LlmClient {
  const run = (ai.run as unknown as AiRun).bind(ai);
  return {
    model: MODEL,
    async json(messages: ChatMessage[], schema: JsonSchema, opts?: { maxTokens?: number; seed?: number }) {
      const res = await run(MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: schema },
        temperature: 0,
        seed: opts?.seed ?? BASE_SEED,
        max_tokens: opts?.maxTokens ?? 1024,
      });
      if (res?.response === undefined || res.response === null) throw new Error("Workers AI returned no response.");
      return res.response;
    },
  };
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
