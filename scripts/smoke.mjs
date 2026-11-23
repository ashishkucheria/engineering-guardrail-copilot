// End-to-end API smoke test (PRs 3-A and 3-B). Runs against a live server started with the fake
// model, so it makes no AI calls and costs nothing:
//   cp .dev.vars.example .dev.vars   (LLM_MODE=fake), then npm run db:setup:local && npm run dev
//   npm run smoke                    (or: node scripts/smoke.mjs http://host:port)
//
// It changes data (creates reviews, toggles MNT-001 off and back on) and uses up the local daily AI
// budget on purpose (the last check). Reset it with `npm run budget:reset:local`.
import { randomInt } from "node:crypto";

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const DEV = "dev-asha";
const DEV2 = "dev-marco";
const APPROVER = "appr-ravi";

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
/** A fresh client IP per request by default, so the per-IP rate limits only bite where tested. */
const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
async function api(method, path, { user, body, raw, ip } = {}) {
  const headers = { "cf-connecting-ip": ip ?? randomIp() };
  if (user) headers["x-demo-user"] = user;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}
/** Submit a review and wait for the Workflow to finish it. */
async function reviewOf(input, user = DEV, timeoutMs = 120_000) {
  const created = await api("POST", "/api/reviews", { user, body: { input } });
  assert(created.status === 202 && created.data.status === "queued", `POST /api/reviews: ${created.status} ${JSON.stringify(created.data)}`);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await api("GET", `/api/reviews/${created.data.id}`, { user });
    if (r.data?.status === "complete" || r.data?.status === "failed") return r.data;
    assert(Date.now() < until, `review ${created.data.id} still ${r.data?.status} after ${timeoutMs / 1000}s`);
    await new Promise((res) => setTimeout(res, 400));
  }
}
const ids = (findings) => findings.map((f) => f.standardId).sort();

const SAMPLE = [
  "diff --git a/src/pay.ts b/src/pay.ts",
  "--- a/src/pay.ts",
  "+++ b/src/pay.ts",
  "@@ -1,1 +1,6 @@",
  ' import { log } from "./log";',
  '+const apiKey = "demo-0000-not-a-real-key-9f8e7d";',
  "+// TODO: retry on 503",
  "+export async function pay(amount: number) {",
  "+  const r = await send(apiKey, amount);",
  "+  return r.ok ? r.id : null;",
  "+}",
].join("\n");

console.log(`Smoke test against ${BASE}`);

const meta = await api("GET", "/api/meta");
if (meta.data?.llmMode !== "fake") {
  console.error(`The server runs LLM_MODE=${meta.data?.llmMode ?? "?"}. The smoke test needs LLM_MODE=fake (see .dev.vars.example), so it spends no real AI calls.`);
  process.exit(2);
}

// --- Identity and standards (3-A) ------------------------------------------------------------

await check("GET /api/users lists the demo users with roles", async () => {
  const r = await api("GET", "/api/users");
  assert(r.status === 200, `status ${r.status}`);
  assert(r.data.some((u) => u.id === DEV && u.role === "developer") && r.data.some((u) => u.id === APPROVER && u.role === "approver"), "missing demo users");
});

await check("requests without a known demo user get 401", async () => {
  assert((await api("GET", "/api/standards")).status === 401, "no header should be 401");
  assert((await api("GET", "/api/standards", { user: "nobody" })).status === 401, "unknown user should be 401");
});

await check("GET /api/standards returns the seeded standards with versions", async () => {
  const r = await api("GET", "/api/standards", { user: DEV });
  assert(r.status === 200 && r.data.length >= 8, `got ${r.status} / ${r.data?.length}`);
  const mnt = r.data.find((s) => s.id === "MNT-001");
  assert(mnt && mnt.enabled === true && /^[0-9a-f]{16}$/.test(mnt.contentHash), "MNT-001 should be enabled with a content hash");
});

await check("a developer cannot disable a standard (403) and nothing is recorded", async () => {
  const before = (await api("GET", "/api/standards/MNT-001/changes", { user: DEV })).data.length;
  const r = await api("PATCH", "/api/standards/MNT-001", { user: DEV, body: { enabled: false } });
  assert(r.status === 403 && r.data.error.code === "forbidden", `got ${r.status} ${JSON.stringify(r.data)}`);
  const after = (await api("GET", "/api/standards/MNT-001/changes", { user: DEV })).data.length;
  assert(after === before, "a refused change must not be audited as a change");
});

// --- AI review through the Workflow (3-B) ----------------------------------------------------

let aiReview;
await check("an AI review runs through the Workflow: verified findings, a hallucination dropped", async () => {
  const input = [
    "export async function getRates() {",
    '  const res = await fetch("https://rates.example.com/latest");',
    "  try { audit() } catch (e) {}",
    "  // FAKE_LLM_HALLUCINATE",
    "  return res.json();",
    "}",
  ].join("\n");
  aiReview = await reviewOf(input);
  assert(aiReview.status === "complete" && aiReview.verdict === "warn", `status ${aiReview.status}, verdict ${aiReview.verdict}`);
  assert(aiReview.engine === "rules+llm(v2)" && aiReview.promptVersion === "v2" && aiReview.model === "fake", `engine ${aiReview.engine} ${aiReview.model}`);
  const got = aiReview.findings.map((f) => `${f.standardId}:${f.source}:${f.classification}:${f.lineStart}`).sort();
  assert(JSON.stringify(got) === JSON.stringify(["REL-001:llm:violation:3", "REL-002:llm:violation:2"]), `findings ${got}`);
  const detect = aiReview.events.find((e) => e.step.startsWith("detect:"));
  assert(detect?.outcome === "ok" && /dropped 1: evidence not found/.test(detect.detail), `detect event ${JSON.stringify(detect)}`);
  for (const step of ["load-context", "validate", "rules", "budget", "persist"]) assert(aiReview.events.some((e) => e.step === step && e.outcome === "ok"), `missing ${step} event`);
});

await check("an AI failure after retries is a coverage gap: verdict incomplete, never pass (takes ~40 s)", async () => {
  const r = await reviewOf('// FAKE_LLM_FAIL\nexport const x = 1;\n');
  assert(r.status === "complete" && r.verdict === "incomplete", `status ${r.status}, verdict ${r.verdict}`);
  assert(r.coverage.skipped.some((s) => /AI review failed/.test(s.reason)), `coverage ${JSON.stringify(r.coverage)}`);
  assert(r.events.filter((e) => e.outcome === "retry").length >= 2, "the detect step should have been retried");
  assert(r.events.some((e) => e.step.startsWith("detect:") && e.outcome === "failed"), "missing failed detect event");
});

await check("a blocker from the rules still fails the review when the AI is down", async () => {
  const r = await reviewOf('// FAKE_LLM_FAIL\nconst apiKey = "abcd1234abcd1234";\n');
  assert(r.verdict === "fail", `verdict ${r.verdict}`);
});

await check("an AI finding on an unchanged line of a diff is a pre-existing suggestion", async () => {
  const d = ["--- a/src/r.ts", "+++ b/src/r.ts", "@@ -1,2 +1,3 @@", ' const r = await fetch("https://x.example/a");', "+const y = 2;", " export { r };"].join("\n");
  const r = await reviewOf(d);
  const f = r.findings.find((x) => x.standardId === "REL-002");
  assert(f && f.classification === "suggestion" && f.preExisting === true && f.lineStart === 1, `finding ${JSON.stringify(f)}`);
  assert(r.verdict === "pass", `pre-existing code must not change the verdict, got ${r.verdict}`);
});

// --- Challenges (3-B) ------------------------------------------------------------------------

await check("a successful challenge marks an AI finding disputed and leaves the verdict alone", async () => {
  const f = aiReview.findings.find((x) => x.standardId === "REL-002");
  const r = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/challenge`, { user: DEV2, body: { argument: "not_supported: the caller wraps this in a timeout." } });
  assert(r.status === 200 && r.data.assessment === "not_supported", `got ${r.status} ${JSON.stringify(r.data)}`);
  assert(r.data.finding.challengeOutcome === "disputed" && r.data.finding.classification === "violation" && r.data.finding.severity === f.severity, `finding ${JSON.stringify(r.data.finding)}`);
  assert(r.data.finding.challenge.by.id === DEV2 && r.data.finding.challenge.argument.startsWith("not_supported"), "challenge not recorded with who and why");
  const after = (await api("GET", `/api/reviews/${aiReview.id}`, { user: DEV })).data;
  assert(after.verdict === aiReview.verdict, `verdict changed from ${aiReview.verdict} to ${after.verdict}`);
});

await check("a finding can be challenged once (409), and a challenge needs an argument (400)", async () => {
  const f = aiReview.findings.find((x) => x.standardId === "REL-002");
  const again = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/challenge`, { user: DEV, body: { argument: "again" } });
  assert(again.status === 409 && again.data.error.code === "already_challenged", `got ${again.status}`);
  const other = aiReview.findings.find((x) => x.standardId === "REL-001");
  assert((await api("POST", `/api/findings/${encodeURIComponent(other.id)}/challenge`, { user: DEV, body: { argument: "  " } })).status === 400, "empty argument should be 400");
  assert((await api("POST", "/api/findings/nope/challenge", { user: DEV, body: { argument: "x" } })).status === 404, "unknown finding should be 404");
});

await check("a challenge to a rule finding is always upheld", async () => {
  const r = await reviewOf('const apiKey = "abcd1234abcd1234";\n');
  const f = r.findings.find((x) => x.source === "rule");
  const c = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/challenge`, { user: DEV, body: { argument: "not_supported: it's a test key." } });
  assert(c.status === 200 && c.data.assessment === "not_supported" && c.data.finding.challengeOutcome === "upheld", `got ${c.status} ${JSON.stringify(c.data)}`);
});

// --- Standards and history (3-A, now through the Workflow) -----------------------------------

let firstReview;
await check("a review of the sample diff finds the secret, the TODO and the missing tests", async () => {
  firstReview = await reviewOf(SAMPLE);
  assert(JSON.stringify(ids(firstReview.findings)) === JSON.stringify(["MNT-001", "SEC-001", "TST-001"]), `found ${ids(firstReview.findings)}`);
  assert(firstReview.verdict === "fail", `verdict ${firstReview.verdict}`);
  const sec = firstReview.findings.find((f) => f.standardId === "SEC-001");
  assert(sec.file === "src/pay.ts" && sec.lineStart === 2, `SEC-001 at ${sec.file}:${sec.lineStart}`);
  assert(!sec.evidence.includes("not-a-real-key-9f8e7d"), "secret must be redacted in evidence");
  assert(firstReview.standards.length >= 8 && firstReview.standards.every((s) => s.contentHash), "review must snapshot every standard");
});

await check("an approver disables MNT-001; the change is audited with who and when", async () => {
  const r = await api("PATCH", "/api/standards/MNT-001", { user: APPROVER, body: { enabled: false } });
  assert(r.status === 200 && r.data.enabled === false && r.data.updatedBy?.id === APPROVER, `got ${r.status} ${JSON.stringify(r.data)}`);
  const log = (await api("GET", "/api/standards/MNT-001/changes", { user: DEV })).data;
  assert(log[0].changedBy.id === APPROVER && log[0].newValue === "false" && log[0].changedAt, "missing audit row");
});

await check("a new review no longer reports the disabled standard", async () => {
  const r = await reviewOf(SAMPLE);
  assert(!r.findings.some((f) => f.standardId === "MNT-001"), "MNT-001 should not run while disabled");
  assert(r.standards.find((s) => s.id === "MNT-001").enabled === false, "snapshot should record MNT-001 as disabled");
});

await check("the earlier review still shows MNT-001 as it was when that review ran", async () => {
  const r = await api("GET", `/api/reviews/${firstReview.id}`, { user: DEV });
  const snap = r.data.standards.find((s) => s.id === "MNT-001");
  assert(snap.enabled === true && snap.changedSince.enabled === true, `snapshot ${JSON.stringify(snap)}`);
  assert(r.data.findings.some((f) => f.standardId === "MNT-001"), "its MNT-001 finding must still be there");
  assert(snap.rule && snap.title, "the rule text of that version should be shown");
});

await check("re-enabling is audited too", async () => {
  const r = await api("PATCH", "/api/standards/MNT-001", { user: APPROVER, body: { enabled: true } });
  assert(r.status === 200 && r.data.enabled === true, `status ${r.status}`);
  const log = (await api("GET", "/api/standards/MNT-001/changes", { user: DEV })).data;
  assert(log[0].newValue === "true" && log[1].newValue === "false", "expected both changes, newest first");
});

await check("input validation: empty, oversized, wrong type and bad JSON", async () => {
  assert((await api("POST", "/api/reviews", { user: DEV, body: { input: "  " } })).status === 400, "empty input should be 400");
  assert((await api("POST", "/api/reviews", { user: DEV, body: { input: "x".repeat(100_001) } })).status === 413, "oversized should be 413");
  assert((await api("POST", "/api/reviews", { user: DEV, body: { input: 42 } })).status === 400, "non-string should be 400");
  assert((await api("POST", "/api/reviews", { user: DEV, raw: "{nope" })).status === 400, "bad JSON should be 400");
  assert((await api("PATCH", "/api/standards/MNT-001", { user: APPROVER, body: { enabled: "no" } })).status === 400, "non-boolean enabled should be 400");
});

await check("unknown routes and standards are 404; wrong methods are 405", async () => {
  assert((await api("GET", "/api/nope", { user: DEV })).status === 404, "unknown route");
  assert((await api("PATCH", "/api/standards/NOPE-999", { user: APPROVER, body: { enabled: false } })).status === 404, "unknown standard");
  assert((await api("DELETE", "/api/reviews", { user: DEV })).status === 405, "wrong method");
  assert((await api("POST", "/api/eval/detect", { user: DEV, body: { input: "x" } })).status === 404, "the eval endpoint is hidden without the token");
});

// --- Regressions from the review of PR #2 (prompt 4) -----------------------------------------

await check("review: every secret on a line is reported and redacted, through the API", async () => {
  const r = await reviewOf('{ user: "svc", password: "hunter2hunter2", clientSecret: "zzzzzzzz9999" }');
  const sec = r.findings.filter((f) => f.standardId === "SEC-001");
  assert(sec.length === 2, `expected 2 SEC-001 findings, got ${sec.length}`);
  const body = JSON.stringify(r.findings);
  assert(!body.includes("hunter2hunter2") && !body.includes("zzzzzzzz9999"), "a secret leaked into the findings");
});

await check("review: a $& secret is not re-inserted by redaction", async () => {
  const r = await reviewOf('const apiKey = "$&abcdefghij";');
  assert(r.findings.filter((f) => f.source === "rule").length === 1, `got ${r.findings.length}`);
  assert(!JSON.stringify(r.findings).includes("abcdefghij"), "secret leaked");
});

await check("review: an input just under 100 KB is accepted even though its JSON body is larger", async () => {
  const line = 'const s = "a \\"quoted\\" value\\twith escapes";\n'; // escapes inflate the JSON body
  const input = line.repeat(Math.floor(99_000 / line.length));
  assert(Buffer.byteLength(input) < 100_000, "test input too big");
  assert(Buffer.byteLength(JSON.stringify({ input })) > 101_000, "test body should exceed the old cap");
  const r = await api("POST", "/api/reviews", { user: DEV, body: { input } });
  assert(r.status === 202, `status ${r.status} ${JSON.stringify(r.data?.error)}`);
});

await check("review: a malformed percent-escape is a 400, not a 500", async () => {
  const r = await api("GET", "/api/reviews/%E0%A4%A", { user: DEV });
  assert(r.status === 400 && r.data.error.code === "invalid_path", `got ${r.status} ${JSON.stringify(r.data)}`);
});

await check("review: concurrent identical toggles write one change and one audit row", async () => {
  const before = (await api("GET", "/api/standards/MNT-001/changes", { user: DEV })).data.length;
  const results = await Promise.all(Array.from({ length: 6 }, () => api("PATCH", "/api/standards/MNT-001", { user: APPROVER, body: { enabled: false } })));
  assert(results.every((r) => r.status === 200 && r.data.enabled === false), "all requests should succeed and report disabled");
  const log = (await api("GET", "/api/standards/MNT-001/changes", { user: DEV })).data;
  assert(log.length === before + 1, `expected exactly 1 new audit row, got ${log.length - before}`);
  assert(log[0].oldValue === "true" && log[0].newValue === "false", `audit row ${JSON.stringify(log[0])}`);
  await api("PATCH", "/api/standards/MNT-001", { user: APPROVER, body: { enabled: true } });
});

await check("history lists the reviews, newest first", async () => {
  const r = await api("GET", "/api/reviews", { user: DEV });
  assert(r.status === 200 && r.data.length >= 2, `got ${r.data?.length}`);
  assert(r.data[0].createdAt >= r.data[1].createdAt, "not newest first");
});

// --- Cost protection (design §10) ------------------------------------------------------------

await check("per-IP rate limit: the 6th review request in a minute from one IP gets 429 with Retry-After", async () => {
  const ip = randomIp();
  const statuses = [];
  // Invalid bodies: the limit is checked before the request is handled, so no review is created.
  for (let i = 0; i < 6; i++) statuses.push((await api("POST", "/api/reviews", { user: DEV, body: { input: "" }, ip })).status);
  assert(JSON.stringify(statuses.slice(0, 5)) === JSON.stringify([400, 400, 400, 400, 400]), `first five: ${statuses}`);
  const last = await api("POST", "/api/reviews", { user: DEV, body: { input: "" }, ip });
  assert(last.status === 429 && last.data.error.code === "rate_limited" && last.headers.get("retry-after"), `got ${last.status} after ${statuses}`);
  assert((await api("POST", "/api/reviews", { user: DEV, body: { input: "" } })).status === 400, "another IP is not limited");
});

await check("daily AI budget: once used up, reviews run rules only (incomplete) and challenges get 429", async () => {
  const m = (await api("GET", "/api/meta")).data.budget.app;
  let refused = null;
  for (let i = 0; i <= m.limit - m.used + 1 && !refused; i++) {
    const r = await reviewOf('const apiKey = "abcd1234abcd1234";\nexport const go = () => fetch("https://x.example/go");\n');
    if (r.events.some((e) => e.step === "budget" && e.outcome === "skipped")) refused = r;
  }
  assert(refused, `the budget of ${m.limit} was never reached`);
  assert(refused.verdict === "fail" && refused.findings.some((f) => f.source === "rule" && f.standardId === "SEC-001"), "rules must still run");
  assert(!refused.findings.some((f) => f.source === "llm"), "no AI findings once the budget is used up");
  assert(refused.coverage.skipped.some((s) => s.reason === "daily AI budget reached"), `coverage ${JSON.stringify(refused.coverage)}`);
  const clean = await reviewOf("export const go = () => fetch(\"https://x.example/go\");\n");
  assert(clean.verdict === "incomplete", `a review the AI couldn't read must be incomplete, got ${clean.verdict}`);
  const f = refused.findings[0];
  const c = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/challenge`, { user: DEV, body: { argument: "test" } });
  assert(c.status === 429 && c.data.error.code === "budget_exhausted" && Number(c.headers.get("retry-after")) > 0, `got ${c.status} ${JSON.stringify(c.data)}`);
  const after = (await api("GET", "/api/meta")).data.budget.app;
  assert(after.used <= after.limit, `budget overshot: ${after.used} > ${after.limit}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
console.log("Note: the local AI budget for today is now used up. Reset it with `npm run budget:reset:local`.");
process.exit(failures.length ? 1 : 0);
