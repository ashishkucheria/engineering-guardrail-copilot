// Manual check of one provider against a small diff with known problems. Needs a real key, so it is
// never run in CI:
//
//   GUARDRAIL_AI_KEY=... npm run try:provider -- anthropic
//   GUARDRAIL_AI_KEY=... GUARDRAIL_BASE_URL=https://api.groq.com/openai/v1 GUARDRAIL_MODEL=llama-3.3-70b-versatile npm run try:provider -- openai-compatible
//   GUARDRAIL_AI_KEY=... CLOUDFLARE_ACCOUNT_ID=... npm run try:provider -- workers-ai
//
// Expected: REL-002 (fetch without a timeout) on src/api.ts line 2, REL-001 (swallowed error) on line 6,
// and SEC-001 from the rules. The key is read from the environment and never printed.
import { review, ruleDetector } from "../core/engine.ts";
import { llmDetector } from "../core/llm.ts";
import { createClient, PROVIDERS } from "../action/providers/index.ts";
import { loadStandards } from "./load-standards.ts";

const provider = process.argv[2] ?? "";
if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number]) || provider === "none") {
  console.error(`usage: npm run try:provider -- <${PROVIDERS.filter((p) => p !== "none").join("|")}>`);
  process.exit(2);
}

let requests = 0;
const counting: typeof fetch = (input, init) => (requests++, fetch(input, init));
let client;
try {
  client = createClient({
    provider,
    apiKey: process.env.GUARDRAIL_AI_KEY,
    model: process.env.GUARDRAIL_MODEL,
    baseUrl: process.env.GUARDRAIL_BASE_URL,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    fetch: counting,
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

const diff = [
  "diff --git a/src/api.ts b/src/api.ts",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -0,0 +1,9 @@",
  "+export async function load(url: string) {",
  "+  const res = await fetch(url);",
  "+  return res.json();",
  "+}",
  "+export function safe(fn: () => void) {",
  "+  try { fn(); } catch (e) {}",
  '+  const apiKey = "abcd1234abcd1234";',
  "+  return apiKey;",
  "+}",
  "",
].join("\n");

const started = Date.now();
const r = await review(diff, await loadStandards(), [ruleDetector, llmDetector(client!, { attempts: 3, onChunk: (l, o, d) => console.log(`  chunk ${l}: ${o}${d ? ` (${d})` : ""}`) })]);
console.log(`${provider} / ${client!.model}: verdict ${r.verdict}, ${requests} request(s), ${((Date.now() - started) / 1000).toFixed(1)} s`);
for (const f of r.findings) console.log(`  ${f.classification} ${f.standardId} [${f.source}] ${f.file}:${f.lineStart}  ${f.explanation.slice(0, 90)}`);
for (const g of r.coverage.skipped) console.log(`  NOT REVIEWED ${g.file}: ${g.reason}`);
