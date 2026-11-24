// OpenAI-compatible Chat Completions: OpenAI itself, and the many servers that copy its API
// (Groq, Together, OpenRouter, vLLM, Ollama, ...). Servers differ in what they accept, so the
// client starts with the strictest request and steps down when a server rejects a parameter:
//   1. json_schema (strict), temperature 0, seed, max_completion_tokens
//   2. a 400 naming temperature or seed       → send neither (reasoning models reject them)
//      a 400 naming max_completion_tokens     → send max_tokens instead
//      a 400 naming response_format or schema → json_object, with the schema in the prompt
// What was learned is kept for the client's later calls, so each step-down costs one request once.
import type { LlmClient } from "../../core/llm.ts";
import type { ChatMessage, JsonSchema } from "../../core/prompts.ts";
import { MIN_MAX_TOKENS, postJson, ProviderError, strictSchema, type FetchFn } from "./http.ts";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_DEFAULT_MODEL = "gpt-6-luna";

export interface OpenAiCompatibleOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

interface Quirks {
  noSampling: boolean;
  legacyMaxTokens: boolean;
  jsonObject: boolean;
}

export function openAiCompatibleClient(opts: OpenAiCompatibleOptions): LlmClient {
  const model = opts.model || OPENAI_DEFAULT_MODEL;
  const url = `${(opts.baseUrl || OPENAI_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const quirks: Quirks = { noSampling: false, legacyMaxTokens: false, jsonObject: false };

  const body = (messages: ChatMessage[], schema: JsonSchema, maxTokens: number, seed: number | undefined) => ({
    model,
    messages: quirks.jsonObject ? withSchemaInstruction(messages, schema) : messages,
    response_format: quirks.jsonObject
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: { name: "guardrail_response", schema: strictSchema(schema), strict: true } },
    ...(quirks.legacyMaxTokens ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
    ...(quirks.noSampling ? {} : { temperature: 0, ...(seed === undefined ? {} : { seed }) }),
  });

  return {
    model,
    async json(messages, schema, callOpts) {
      const maxTokens = Math.max(callOpts?.maxTokens ?? 0, MIN_MAX_TOKENS);
      for (;;) {
        try {
          const res = await postJson(url, { authorization: `Bearer ${opts.apiKey}` }, body(messages, schema, maxTokens, callOpts?.seed), {
            fetch: opts.fetch,
            timeoutMs: opts.timeoutMs,
            provider: "openai-compatible",
          });
          return readChoice(res);
        } catch (e) {
          if (!(e instanceof ProviderError) || e.status !== 400 || !stepDown(quirks, e.message)) throw e;
        }
      }
    },
  };
}

/** Change the request after a 400 that names a parameter. False when there's nothing left to change. */
export function stepDown(q: Quirks, message: string): boolean {
  const m = message.toLowerCase();
  let changed = false;
  if (!q.noSampling && (m.includes("temperature") || m.includes("seed"))) changed = q.noSampling = true;
  if (!q.legacyMaxTokens && m.includes("max_completion_tokens")) changed = q.legacyMaxTokens = true;
  if (!q.jsonObject && (m.includes("response_format") || m.includes("json_schema") || m.includes("schema"))) changed = q.jsonObject = true;
  return changed;
}

/** json_object mode doesn't take a schema, so the schema goes into the system prompt. */
function withSchemaInstruction(messages: ChatMessage[], schema: JsonSchema): ChatMessage[] {
  const note = `Answer with one JSON object that matches this JSON schema, and nothing else:\n${JSON.stringify(schema)}`;
  const [first, ...rest] = messages;
  return first?.role === "system" ? [{ role: "system", content: `${first.content}\n\n${note}` }, ...rest] : [{ role: "system", content: note }, ...messages];
}

function readChoice(res: unknown): string {
  const choice = (res as { choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[] })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim() !== "") return content;
  if (typeof choice?.message?.refusal === "string") throw new ProviderError(`openai-compatible: the model refused: ${choice.message.refusal}`, 200, true);
  throw new ProviderError(`openai-compatible: no content in the response (finish_reason ${String(choice?.finish_reason ?? "missing")})`, 200, true);
}
