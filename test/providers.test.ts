// Provider adapters against recorded-shape responses, with fetch mocked. No network, no keys.
import { describe, expect, it } from "vitest";
import { anthropicClient } from "../core/providers/anthropic.ts";
import { geminiClient, GEMINI_URL } from "../core/providers/gemini.ts";
import { errorDetail, MIN_MAX_TOKENS, postJson, ProviderError, strictSchema, type FetchFn } from "../core/providers/http.ts";
import { createClient } from "../core/providers/index.ts";
import { openAiCompatibleClient, stepDown, tokenLimitFrom } from "../core/providers/openai-compatible.ts";
import { workersAiRestClient } from "../core/providers/workers-ai.ts";
import { parseDetection, type LlmClient } from "../core/llm.ts";
import { detectionSchema, type ChatMessage } from "../core/prompts.ts";

const KEY = "test-key-not-real";
const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are a code reviewer." },
  { role: "user", content: "Review this." },
];
const SCHEMA = detectionSchema(["REL-001"]);
const ANSWER = { findings: [{ standard_id: "REL-001", certainty: "definite", evidence: "catch (e) {}", explanation: "x", impact: "y", remediation: "z" }] };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that answers each request with the next scripted response and records what was sent. */
function mockFetch(...responses: (Response | Error | (() => Response))[]): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const text = init?.body !== undefined ? String(init.body) : await req.text();
    calls.push({ url: req.url, headers, body: text ? JSON.parse(text) : {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch: f as FetchFn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const openAiOk = (content: string) => json({ choices: [{ message: { content }, finish_reason: "stop" }] });

async function expectProviderError(p: Promise<unknown>, retryable: boolean, match?: RegExp) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProviderError);
  expect((e as ProviderError).retryable).toBe(retryable);
  if (match) expect((e as Error).message).toMatch(match);
}

// ---------------------------------------------------------------------------------------------

describe("strictSchema", () => {
  it("adds additionalProperties: false to every object without changing the input", () => {
    const s = strictSchema(SCHEMA) as { additionalProperties: unknown; properties: { findings: { items: { additionalProperties: unknown } } } };
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.findings.items.additionalProperties).toBe(false);
    expect("additionalProperties" in SCHEMA).toBe(false);
  });
});

describe("errorDetail", () => {
  it("pulls the provider's message out of the common error shapes, and caps the length", () => {
    expect(errorDetail(JSON.stringify({ error: { message: "bad key" } }))).toBe("bad key");
    expect(errorDetail(JSON.stringify({ errors: [{ message: "no account" }] }))).toBe("no account");
    expect(errorDetail("plain text")).toBe("plain text");
    expect(errorDetail("x".repeat(1000)).length).toBeLessThanOrEqual(301);
  });
});

describe("openai-compatible", () => {
  it("sends a strict json_schema request with temperature 0, the seed and a raised token ceiling", async () => {
    const m = mockFetch(openAiOk(JSON.stringify(ANSWER)));
    const c = openAiCompatibleClient({ apiKey: KEY, baseUrl: "https://api.example.test/v1/", fetch: m.fetch });
    const out = await c.json(MESSAGES, SCHEMA, { maxTokens: 2048, seed: 43 });
    expect(parseDetection(out).items).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe("https://api.example.test/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toMatchObject({ model: "gpt-6-luna", temperature: 0, seed: 43, max_completion_tokens: MIN_MAX_TOKENS });
    expect(call.body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, schema: { additionalProperties: false } } });
  });

  it("steps down once per rejected parameter and remembers it for later calls", async () => {
    const m = mockFetch(
      json({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }, 400),
      json({ error: { message: "response_format json_schema is not supported" } }, 400),
      openAiOk(JSON.stringify(ANSWER)),
      openAiOk(JSON.stringify(ANSWER)),
    );
    const c = openAiCompatibleClient({ apiKey: KEY, fetch: m.fetch });
    await c.json(MESSAGES, SCHEMA, { seed: 42 });
    await c.json(MESSAGES, SCHEMA, { seed: 43 });
    expect(m.calls).toHaveLength(4); // two step-downs, then one request per call
    const last = m.calls[3]!.body;
    expect(last).not.toHaveProperty("temperature");
    expect(last).not.toHaveProperty("seed");
    expect(last.response_format).toEqual({ type: "json_object" });
    // json_object takes no schema, so the schema goes into the system prompt
    expect((last.messages as ChatMessage[])[0]!.content).toContain('"findings"');
  });

  it("uses max_tokens when a server rejects max_completion_tokens", () => {
    const q = { noSampling: false, legacyMaxTokens: false, jsonObject: false };
    expect(stepDown(q, "Unrecognized request argument supplied: max_completion_tokens")).toBe(true);
    expect(q).toEqual({ noSampling: false, legacyMaxTokens: true, jsonObject: false });
    expect(stepDown(q, "Unrecognized request argument supplied: max_completion_tokens")).toBe(false);
  });

  it("asks for less when a 400 names the server's output-token limit, instead of changing parameters", async () => {
    const m = mockFetch(
      json({ error: { message: "Invalid 'max_completion_tokens': integer above maximum value. Expected a value <= 8192, but got 16000." } }, 400),
      openAiOk(JSON.stringify(ANSWER)),
      openAiOk(JSON.stringify(ANSWER)),
    );
    const c = openAiCompatibleClient({ apiKey: KEY, fetch: m.fetch });
    await c.json(MESSAGES, SCHEMA);
    await c.json(MESSAGES, SCHEMA);
    expect(m.calls.map((x) => x.body.max_completion_tokens)).toEqual([MIN_MAX_TOKENS, 8192, 8192]); // remembered
    expect(m.calls.every((x) => !("max_tokens" in x.body) && "temperature" in x.body)).toBe(true);
  });

  it("reads token limits from common wordings, and ignores anything else", () => {
    expect(tokenLimitFrom("max_tokens must be less than or equal to 8192 for this model")).toBe(8192);
    expect(tokenLimitFrom("The maximum number of output tokens is 4,096")).toBeUndefined(); // wording we don't guess at
    expect(tokenLimitFrom("Requested tokens exceed the limit of 8,192")).toBe(8192);
    expect(tokenLimitFrom("at most 100 items")).toBeUndefined(); // no mention of tokens
    expect(tokenLimitFrom("max_completion_tokens must be at most 10")).toBeUndefined(); // too small to be a real ceiling
  });

  it("doesn't drop a parameter when the 400 is about its value, not its support", () => {
    const q = { noSampling: false, legacyMaxTokens: false, jsonObject: false };
    expect(stepDown(q, "temperature must be between 0 and 2")).toBe(false);
    expect(stepDown(q, "max_completion_tokens must be a positive integer")).toBe(false);
    expect(q).toEqual({ noSampling: false, legacyMaxTokens: false, jsonObject: false });
  });

  it("gives up on a 400 it can't step down from, without retrying", async () => {
    const m = mockFetch(json({ error: { message: "messages: too long" } }, 400));
    await expectProviderError(openAiCompatibleClient({ apiKey: KEY, fetch: m.fetch }).json(MESSAGES, SCHEMA), false, /HTTP 400: messages: too long/);
    expect(m.calls).toHaveLength(1);
  });

  it("marks 429 and 5xx retryable, 401 not", async () => {
    await expectProviderError(openAiCompatibleClient({ apiKey: KEY, fetch: mockFetch(json({}, 429)).fetch }).json(MESSAGES, SCHEMA), true, /HTTP 429/);
    await expectProviderError(openAiCompatibleClient({ apiKey: KEY, fetch: mockFetch(json({}, 503)).fetch }).json(MESSAGES, SCHEMA), true);
    await expectProviderError(openAiCompatibleClient({ apiKey: KEY, fetch: mockFetch(json({ error: { message: "Invalid API key" } }, 401)).fetch }).json(MESSAGES, SCHEMA), false, /Invalid API key/);
  });

  it("treats a network error or timeout as retryable", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    await expectProviderError(openAiCompatibleClient({ apiKey: KEY, fetch: mockFetch(timeout).fetch }).json(MESSAGES, SCHEMA), true, /timed out/);
    await expectProviderError(openAiCompatibleClient({ apiKey: KEY, fetch: mockFetch(new TypeError("fetch failed")).fetch }).json(MESSAGES, SCHEMA), true, /network error/);
  });

  it("reports a refusal or empty content as an error, and returns malformed JSON for the engine to reject", async () => {
    const refused = mockFetch(json({ choices: [{ message: { content: null, refusal: "I can't help with that." } }] }));
    await expectProviderError(openAiCompatibleClient({ apiKey: KEY, fetch: refused.fetch }).json(MESSAGES, SCHEMA), true, /refused/);
    const out = await openAiCompatibleClient({ apiKey: KEY, fetch: mockFetch(openAiOk("{not json")).fetch }).json(MESSAGES, SCHEMA);
    expect(() => parseDetection(out)).toThrow(/not valid JSON/);
  });
});

describe("postJson", () => {
  it("turns a timeout while the body is still arriving into a retryable provider error", async () => {
    const stalled: FetchFn = (async (_u: unknown, init?: RequestInit) => {
      const body = new ReadableStream({ start: (c) => init!.signal!.addEventListener("abort", () => c.error(init!.signal!.reason)) });
      return new Response(body, { status: 200 });
    }) as FetchFn;
    const keepAlive = setTimeout(() => {}, 5_000); // AbortSignal.timeout's own timer doesn't keep Node running
    try {
      await expectProviderError(postJson("https://x.test", {}, {}, { fetch: stalled, timeoutMs: 50, provider: "demo" }), true, /^demo: request timed out/);
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

describe("anthropic", () => {
  const message = (over: Record<string, unknown> = {}) =>
    json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(ANSWER) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      ...over,
    });

  it("sends structured output, the fallback beta and no sampling parameters, with one SDK attempt", async () => {
    const m = mockFetch(message());
    const c = anthropicClient({ apiKey: KEY, fetch: m.fetch, baseUrl: "https://anthropic.example.test" });
    const out = await c.json(MESSAGES, SCHEMA, { maxTokens: 2048, seed: 42 });
    expect(parseDetection(out).items).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe("https://anthropic.example.test/v1/messages");
    // SDK 1.x sends the key as a bearer token
    expect(call.headers["x-api-key"] ?? call.headers.authorization).toMatch(new RegExp(`^(Bearer )?${KEY}$`));
    expect(call.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(call.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: MIN_MAX_TOKENS,
      fallbacks: "default",
      system: "You are a code reviewer.",
      messages: [{ role: "user", content: "Review this." }],
      output_config: { format: { type: "json_schema", schema: { additionalProperties: false } } },
    });
    for (const k of ["temperature", "seed", "tool_choice", "tools", "thinking"]) expect(call.body).not.toHaveProperty(k);
  });

  it("maps HTTP errors to retryable or not, and makes no SDK retries", async () => {
    const limited = mockFetch(json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429));
    await expectProviderError(anthropicClient({ apiKey: KEY, fetch: limited.fetch }).json(MESSAGES, SCHEMA), true, /HTTP 429/);
    expect(limited.calls).toHaveLength(1);
    const badKey = mockFetch(json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    await expectProviderError(anthropicClient({ apiKey: KEY, fetch: badKey.fetch }).json(MESSAGES, SCHEMA), false, /HTTP 401/);
  });

  it("reports a refusal and a cut-off answer as errors", async () => {
    await expectProviderError(anthropicClient({ apiKey: KEY, fetch: mockFetch(message({ stop_reason: "refusal", content: [] })).fetch }).json(MESSAGES, SCHEMA), true, /declined/);
    await expectProviderError(anthropicClient({ apiKey: KEY, fetch: mockFetch(message({ stop_reason: "max_tokens" })).fetch }).json(MESSAGES, SCHEMA), true, /cut off/);
  });
});

describe("gemini", () => {
  const interaction = (status: string, text?: string) =>
    json({ id: "int_test", status, steps: text === undefined ? [] : [{ type: "model_output", content: [{ type: "text", text }] }] });

  it("calls the Interactions API with a schema, the seed and store: false", async () => {
    const m = mockFetch(interaction("completed", JSON.stringify(ANSWER)));
    const out = await geminiClient({ apiKey: KEY, fetch: m.fetch }).json(MESSAGES, SCHEMA, { seed: 44 });
    expect(parseDetection(out).items).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe(GEMINI_URL);
    expect(call.headers["x-goog-api-key"]).toBe(KEY);
    expect(call.body).toMatchObject({
      model: "gemini-3.5-flash-lite",
      input: "Review this.",
      system_instruction: "You are a code reviewer.",
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
      generation_config: { max_output_tokens: MIN_MAX_TOKENS, seed: 44 },
      store: false,
    });
    expect(call.body).not.toHaveProperty("temperature");
  });

  it("treats an unfinished interaction as a retryable error", async () => {
    await expectProviderError(geminiClient({ apiKey: KEY, fetch: mockFetch(interaction("incomplete")).fetch }).json(MESSAGES, SCHEMA), true, /status incomplete/);
  });

  it("sends a conversation as one transcript that ends with the latest question", async () => {
    const m = mockFetch(json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: '{"reply":"ok"}' }] }] }));
    const turns: ChatMessage[] = [...MESSAGES, { role: "assistant", content: "first answer" }, { role: "user", content: "second question" }];
    await geminiClient({ apiKey: KEY, fetch: m.fetch }).json(turns, SCHEMA);
    const input = m.calls[0]!.body.input as string;
    expect(typeof input).toBe("string");
    const user = MESSAGES.find((x) => x.role === "user")!.content;
    expect(input.indexOf(user)).toBeLessThan(input.indexOf("Assistant:\nfirst answer"));
    expect(input.endsWith("User:\nsecond question")).toBe(true);
    expect(input).not.toContain(MESSAGES.find((x) => x.role === "system")!.content); // the system prompt stays in system_instruction
  });

  it("refuses a conversation that doesn't end with the user", async () => {
    const turns: ChatMessage[] = [...MESSAGES, { role: "assistant", content: "a" }];
    await expectProviderError(geminiClient({ apiKey: KEY, fetch: mockFetch().fetch }).json(turns, SCHEMA), false, /last message must be from the user/);
  });
});

describe("workers-ai (REST)", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";

  it("posts the app's request shape to the account's run endpoint", async () => {
    const m = mockFetch(json({ success: true, result: { response: ANSWER } }));
    const out = await workersAiRestClient({ apiKey: KEY, accountId: ACCOUNT, fetch: m.fetch }).json(MESSAGES, SCHEMA, { maxTokens: 2048, seed: 42 });
    expect(out).toEqual(ANSWER);
    const call = m.calls[0]!;
    expect(call.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`);
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toMatchObject({ temperature: 0, seed: 42, max_tokens: 2048, response_format: { type: "json_schema", json_schema: SCHEMA } });
  });

  it("rejects a malformed account id before any request", () => {
    expect(() => workersAiRestClient({ apiKey: KEY, accountId: "not-an-id" })).toThrow(/32-character/);
  });
});

describe("createClient", () => {
  it("returns null for none, and a client with the right default model for each provider", () => {
    expect(createClient({ provider: "none" })).toBeNull();
    const model = (p: string, extra = {}) => (createClient({ provider: p, apiKey: KEY, ...extra }) as LlmClient).model;
    expect(model("openai-compatible")).toBe("gpt-6-luna");
    expect(model("anthropic")).toBe("claude-opus-5-5");
    expect(model("gemini")).toBe("gemini-3.5-flash-lite");
    expect(model("workers-ai", { cloudflareAccountId: "0123456789abcdef0123456789abcdef" })).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(model("anthropic", { model: " claude-haiku-5-5 " })).toBe("claude-haiku-5-5");
  });

  it("fails clearly on an unknown provider or a missing key or account id", () => {
    expect(() => createClient({ provider: "openai" })).toThrow(/unknown provider "openai"/);
    expect(() => createClient({ provider: "anthropic", apiKey: " " })).toThrow(/needs api-key/);
    expect(() => createClient({ provider: "workers-ai", apiKey: KEY })).toThrow(/needs cloudflare-account-id/);
  });
});
