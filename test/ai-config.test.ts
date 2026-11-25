import { describe, expect, it } from "vitest";
import { aiConfigError, llmModeOf } from "../core/ai-config.ts";

const KEY = "test-key-not-real";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("web app AI settings", () => {
  it("knows every provider the Action has, plus off and fake", () => {
    for (const m of ["off", "fake", "openai-compatible", "anthropic", "gemini", "workers-ai"]) expect(llmModeOf({ LLM_MODE: m })).toBe(m);
    expect(llmModeOf({ LLM_MODE: " gemini " })).toBe("gemini");
  });

  it("treats an unknown or missing mode as an error, never as a silent default", () => {
    expect(llmModeOf({ LLM_MODE: "none" })).toBeNull();
    expect(llmModeOf({})).toBeNull();
    expect(aiConfigError({ LLM_MODE: "gpt" })).toMatch(/isn't one of/);
  });

  it("needs a key for a real provider, and an account id for Workers AI", () => {
    expect(aiConfigError({ LLM_MODE: "off" })).toBeNull();
    expect(aiConfigError({ LLM_MODE: "fake" })).toBeNull();
    expect(aiConfigError({ LLM_MODE: "gemini" })).toMatch(/LLM_API_KEY/);
    expect(aiConfigError({ LLM_MODE: "gemini", LLM_API_KEY: "  " })).toMatch(/LLM_API_KEY/);
    expect(aiConfigError({ LLM_MODE: "gemini", LLM_API_KEY: KEY })).toBeNull();
    expect(aiConfigError({ LLM_MODE: "workers-ai", LLM_API_KEY: KEY })).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
    expect(aiConfigError({ LLM_MODE: "workers-ai", LLM_API_KEY: KEY, CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toBeNull();
  });

  it("never puts a setting's value in the message", () => {
    const msg = aiConfigError({ LLM_MODE: "workers-ai", LLM_API_KEY: KEY, CLOUDFLARE_ACCOUNT_ID: "not-hex" }) ?? "";
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain("not-hex");
  });
});
