// End-to-end API smoke test (PRs 3-A, 3-B and 3-C). Runs against a live server started with the fake
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
  assert(aiReview.engine === "rules+llm(v3)" && aiReview.promptVersion === "v3" && aiReview.model === "fake", `engine ${aiReview.engine} ${aiReview.model}`);
  const got = aiReview.findings.map((f) => `${f.standardId}:${f.source}:${f.classification}:${f.lineStart}`).sort();
  assert(JSON.stringify(got) === JSON.stringify(["REL-001:llm:violation:3", "REL-002:llm:violation:2"]), `findings ${got}`);
  const detect = aiReview.events.find((e) => e.step.startsWith("detect:"));
  assert(detect?.outcome === "ok" && /dropped 1: evidence not found/.test(detect.detail), `detect event ${JSON.stringify(detect)}`);
  for (const step of ["load-context", "validate", "rules", "persist"]) assert(aiReview.events.some((e) => e.step === step && e.outcome === "ok"), `missing ${step} event`);
});

await check("an AI failure after retries is a coverage gap, and every attempt is paid for (takes ~40 s)", async () => {
  const before = (await api("GET", "/api/meta")).data.budget.app.used;
  const r = await reviewOf('// FAKE_LLM_FAIL\nexport const x = 1;\n');
  const used = (await api("GET", "/api/meta")).data.budget.app.used - before;
  const attempts = r.events.filter((e) => e.outcome === "retry").length;
  assert(used === attempts, `${attempts} model attempts but ${used} budget call(s) reserved; every attempt must reserve one`);
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

await check("only the author or an approver can challenge: another developer gets 403 and uses nothing up", async () => {
  const f = aiReview.findings.find((x) => x.standardId === "REL-002");
  const r = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/challenge`, { user: DEV2, body: { argument: "junk" } });
  assert(r.status === 403 && r.data.error.code === "forbidden", `got ${r.status} ${JSON.stringify(r.data)}`);
  assert((await api("GET", `/api/reviews/${aiReview.id}`, { user: DEV2 })).data.viewerCanChallenge === false, "the UI flag should be false for another developer");
  const mine = (await api("GET", `/api/reviews/${aiReview.id}`, { user: DEV })).data;
  assert(mine.viewerCanChallenge === true && !mine.findings.find((x) => x.id === f.id).challenge, "the author can still challenge");
});

await check("a successful challenge marks an AI finding disputed and leaves the verdict alone", async () => {
  const f = aiReview.findings.find((x) => x.standardId === "REL-002");
  const r = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/challenge`, { user: DEV, body: { argument: "not_supported: the caller wraps this in a timeout." } });
  assert(r.status === 200 && r.data.assessment === "not_supported", `got ${r.status} ${JSON.stringify(r.data)}`);
  assert(r.data.finding.challengeOutcome === "disputed" && r.data.finding.classification === "violation" && r.data.finding.severity === f.severity, `finding ${JSON.stringify(r.data.finding)}`);
  assert(r.data.finding.challenge.by.id === DEV && r.data.finding.challenge.argument.startsWith("not_supported"), "challenge not recorded with who and why");
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

await check("an approver can challenge someone else's finding; a rule finding is always upheld", async () => {
  const r = await reviewOf('const apiKey = "abcd1234abcd1234";\n');
  const f = r.findings.find((x) => x.source === "rule");
  const c = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/challenge`, { user: APPROVER, body: { argument: "not_supported: it's a test key." } });
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

// --- Feedback, exceptions, chat and the dashboard (3-C) --------------------------------------

const APPROVER2 = "appr-lena";
const SECRET_LINE = 'const apiKey = "abcd1234abcd1234";';
/** A diff adding one secret to a file only this run uses, so exceptions made here can't affect other checks or later runs. */
const secretDiff = (path) => [`--- a/${path}`, `+++ b/${path}`, "@@ -0,0 +1,1 @@", `+${SECRET_LINE}`].join("\n") + "\n";
const uniquePath = (tag) => `smoke/${tag}-${Date.now().toString(36)}${randomInt(1e6)}/keys.ts`;
const secOf = (review) => review.findings.find((f) => f.standardId === "SEC-001" && f.source === "rule");
const dash = async () => (await api("GET", "/api/dashboard", { user: DEV })).data;
/** core/verdict.ts computeVerdict, restated, to check the verdict the database recomputes after a waiver. */
const expectedVerdict = (r) => {
  const v = r.findings.filter((f) => f.classification === "violation" && !f.waivedBy);
  if (v.some((f) => f.severity === "blocker")) return "fail";
  if (r.coverage.skipped.length) return "incomplete";
  return v.length ? "warn" : "pass";
};

await check("feedback: author-only, a reason to reject, recorded without touching the verdict", async () => {
  const r = await reviewOf(secretDiff(uniquePath("fb")));
  const f = secOf(r);
  const path = `/api/findings/${encodeURIComponent(f.id)}/feedback`;
  const other = await api("POST", path, { user: DEV2, body: { action: "reject", reason: "not mine" } });
  assert(other.status === 403 && other.data.error.code === "forbidden", `another developer: ${other.status}`);
  assert((await api("POST", path, { user: DEV, body: { action: "reject" } })).status === 400, "reject without a reason should be 400");
  assert((await api("POST", path, { user: DEV, body: { action: "ignore" } })).status === 400, "unknown action should be 400");
  const rej = await api("POST", path, { user: DEV, body: { action: "reject", reason: "It's a fixture." } });
  assert(rej.status === 200 && rej.data.disposition === "rejected" && rej.data.classification === "violation", `reject: ${rej.status} ${JSON.stringify(rej.data)}`);
  const after = (await api("GET", `/api/reviews/${r.id}`, { user: DEV })).data;
  assert(after.verdict === r.verdict && r.verdict === "fail", `verdict changed from ${r.verdict} to ${after.verdict}`);
  const acc = await api("POST", path, { user: APPROVER, body: { action: "accept" } });
  assert(acc.status === 200 && acc.data.disposition === "accepted", "an approver can accept it");
});

await check("HARD GATE: ten rejections never suppress a finding; history is shown, the verdict still fails", async () => {
  const file = uniquePath("hist");
  const first = await reviewOf(secretDiff(file));
  const f = secOf(first);
  for (let i = 0; i < 10; i++) {
    const r = await api("POST", `/api/findings/${encodeURIComponent(f.id)}/feedback`, { user: DEV, body: { action: "reject", reason: `false positive #${i + 1}, please stop flagging this` } });
    assert(r.status === 200, `rejection ${i + 1}: ${r.status}`);
  }
  const again = await reviewOf(secretDiff(file));
  const g = secOf(again);
  assert(g && g.classification === "violation" && !g.waivedBy && again.verdict === "fail", `after 10 rejections: ${JSON.stringify(g)} verdict ${again.verdict}`);
  const h = again.history.find((x) => x.standardId === "SEC-001");
  assert(h && h.rejected >= 1 && h.recentReasons.some((x) => x.reason.startsWith("false positive #10")), `history ${JSON.stringify(h)}`);
});

let excReview;
let excId;
await check("exception requests are validated: 90-day limit, the pattern must match, the author's findings only", async () => {
  excReview = await reviewOf(secretDiff(uniquePath("exc")));
  const f = secOf(excReview);
  const body = { finding_id: f.id, standard_id: "SEC-001", path_pattern: f.file, justification: "Demo key that only works against the local mock.", expires_in_days: 30 };
  assert((await api("POST", "/api/exceptions", { user: DEV, body: { ...body, expires_in_days: 91 } })).status === 400, "91 days should be 400");
  assert((await api("POST", "/api/exceptions", { user: DEV, body: { ...body, expires_in_days: undefined } })).status === 400, "no expiry should be 400");
  assert((await api("POST", "/api/exceptions", { user: DEV, body: { ...body, path_pattern: "other/**" } })).status === 400, "a pattern that misses the finding should be 400");
  assert((await api("POST", "/api/exceptions", { user: DEV, body: { ...body, standard_id: "MNT-001" } })).status === 400, "a different standard should be 400");
  assert((await api("POST", "/api/exceptions", { user: DEV2, body })).status === 403, "another developer can't request one from this finding");
  assert((await api("POST", "/api/exceptions", { user: DEV, body: { ...body, finding_id: "nope" } })).status === 404, "unknown finding should be 404");
  const ok = await api("POST", "/api/exceptions", { user: DEV, body });
  assert(ok.status === 201 && ok.data.status === "pending" && ok.data.state === "pending" && ok.data.requestedBy.id === DEV, `create: ${ok.status} ${JSON.stringify(ok.data)}`);
  excId = ok.data.id;
  const days = (Date.parse(ok.data.expiresAt) - Date.parse(ok.data.createdAt)) / 86_400_000;
  assert(Math.abs(days - 30) < 0.001, `expires after ${days} days`);
  assert((await api("POST", "/api/exceptions", { user: DEV, body })).status === 409, "a second pending request for the same finding should be 409");
  const pending = (await api("GET", "/api/exceptions?status=pending", { user: DEV2 })).data;
  assert(pending.some((e) => e.id === excId), "the request should be listed as pending");
});

await check("approval rules: a developer can't approve (403); two approvers at once give one approval and one 409", async () => {
  const dev = await api("POST", `/api/exceptions/${excId}/decision`, { user: DEV, body: { decision: "approve" } });
  assert(dev.status === 403 && dev.data.error.code === "forbidden", `developer: ${dev.status}`);
  const both = await Promise.all([APPROVER, APPROVER2].map((u) => api("POST", `/api/exceptions/${excId}/decision`, { user: u, body: { decision: "approve", note: `ok from ${u}` } })));
  const statuses = both.map((r) => r.status).sort();
  assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), `concurrent approvals: ${statuses}`);
  const ok = both.find((r) => r.status === 200).data;
  assert(ok.status === "approved" && ok.state === "active" && ok.decidedBy && ok.decidedAt, `approved: ${JSON.stringify(ok)}`);
  assert((await api("POST", `/api/exceptions/${excId}/decision`, { user: APPROVER, body: { decision: "deny" } })).status === 409, "a decided exception can't be decided again");
});

await check("approval waives the source review: the finding stays, the verdict is recomputed, an event is recorded", async () => {
  const r = (await api("GET", `/api/reviews/${excReview.id}`, { user: DEV })).data;
  const f = secOf(r);
  assert(f.waivedBy === excId && f.waiver.id === excId && f.classification === "violation" && f.severity === "blocker", `finding ${JSON.stringify(f)}`);
  assert(excReview.verdict === "fail" && r.verdict === expectedVerdict(r) && r.verdict !== "fail", `verdict ${excReview.verdict} → ${r.verdict}, expected ${expectedVerdict(r)}`);
  const events = r.events.filter((e) => e.step === "exception");
  assert(events.length === 1 && events[0].detail.includes(`${excId} approved`) && events[0].detail.includes("1 finding(s) waived"), `events ${JSON.stringify(events)}`);
});

await check("a later review of the same path is waived by the apply-exceptions step; another path is not", async () => {
  const again = await reviewOf(secretDiff(secOf(excReview).file));
  assert(secOf(again).waivedBy === excId && again.verdict !== "fail", `waived ${secOf(again).waivedBy}, verdict ${again.verdict}`);
  assert(again.events.some((e) => e.step === "apply-exceptions" && e.detail.includes(excId)), "missing apply-exceptions event");
  const elsewhere = await reviewOf(secretDiff(uniquePath("elsewhere")));
  assert(!secOf(elsewhere).waivedBy && elsewhere.verdict === "fail", "an exception must not leak to other paths");
});

await check("no self-approval, even for approvers; another approver can deny", async () => {
  const body = { standard_id: "MNT-001", path_pattern: `${uniquePath("self").replace(/\/keys\.ts$/, "")}/**`, justification: "Generated code with upstream TODOs.", expires_in_days: 7 };
  const e = await api("POST", "/api/exceptions", { user: APPROVER, body });
  assert(e.status === 201, `create: ${e.status}`);
  const self = await api("POST", `/api/exceptions/${e.data.id}/decision`, { user: APPROVER, body: { decision: "approve" } });
  assert(self.status === 403, `self-approval: ${self.status}`);
  const deny = await api("POST", `/api/exceptions/${e.data.id}/decision`, { user: APPROVER2, body: { decision: "deny", note: "Fix the TODOs instead." } });
  assert(deny.status === 200 && deny.data.state === "denied" && deny.data.decisionNote === "Fix the TODOs instead.", `deny: ${deny.status} ${JSON.stringify(deny.data)}`);
  assert((await api("GET", "/api/exceptions?status=denied", { user: DEV })).data.some((x) => x.id === e.data.id), "should be listed as denied");
  assert((await api("GET", "/api/exceptions?status=bogus", { user: DEV })).status === 400, "unknown status filter should be 400");
});

await check("chat: answers about a review, is stored with who asked, and spends one AI call", async () => {
  const before = (await api("GET", "/api/meta")).data.budget.app.used;
  const c = await api("POST", `/api/reviews/${excReview.id}/chat`, { user: DEV2, body: { message: "Has SEC-001 come up before?" } });
  assert(c.status === 200 && /Fake model: this review has \d+ finding/.test(c.data.reply), `chat: ${c.status} ${JSON.stringify(c.data)}`);
  assert(c.data.messages.length === 2 && c.data.messages[0].user.id === DEV2 && c.data.messages[1].role === "assistant", `messages ${JSON.stringify(c.data.messages)}`);
  assert((await api("GET", "/api/meta")).data.budget.app.used === before + 1, "a chat message should reserve one AI call");
  const r = (await api("GET", `/api/reviews/${excReview.id}`, { user: DEV })).data;
  assert(r.messages.length === 2, "the chat should be stored on the review");
  assert(r.verdict === expectedVerdict(r) && secOf(r).waivedBy === excId, "chat must not change anything");
  assert((await api("POST", `/api/reviews/${excReview.id}/chat`, { user: DEV, body: { message: " " } })).status === 400, "an empty message should be 400");
  assert((await api("POST", "/api/reviews/nope/chat", { user: DEV, body: { message: "hi" } })).status === 404, "unknown review should be 404");
});

await check("dashboard numbers match the database, step by step", async () => {
  const d0 = await dash();
  const r = await reviewOf(secretDiff(uniquePath("dash")));
  const blockers = r.findings.filter((f) => f.classification === "violation" && f.severity === "blocker").length;
  const d1 = await dash();
  assert(d1.totalReviews === d0.totalReviews + 1 && d1.verdicts.fail === d0.verdicts.fail + 1, `reviews ${d0.totalReviews}→${d1.totalReviews}, fail ${d0.verdicts.fail}→${d1.verdicts.fail}`);
  assert(d1.violationsBySeverity.blocker === d0.violationsBySeverity.blocker + blockers, `blockers ${d0.violationsBySeverity.blocker}→${d1.violationsBySeverity.blocker}`);
  const f = secOf(r);
  await api("POST", `/api/findings/${encodeURIComponent(f.id)}/feedback`, { user: DEV, body: { action: "reject", reason: "dashboard check" } });
  const d2 = await dash();
  assert(d2.dispositions.rejected === d1.dispositions.rejected + 1 && d2.dispositions.open === d1.dispositions.open - 1, `dispositions ${JSON.stringify(d1.dispositions)}→${JSON.stringify(d2.dispositions)}`);
  const e = await api("POST", "/api/exceptions", { user: DEV, body: { finding_id: f.id, standard_id: "SEC-001", path_pattern: f.file, justification: "Dashboard check exception.", expires_in_days: 1 } });
  const d3 = await dash();
  assert(d3.exceptions.pending === d2.exceptions.pending + 1, "pending +1");
  await api("POST", `/api/exceptions/${e.data.id}/decision`, { user: APPROVER, body: { decision: "approve" } });
  const d4 = await dash();
  const after = (await api("GET", `/api/reviews/${r.id}`, { user: DEV })).data;
  assert(d4.exceptions.pending === d2.exceptions.pending && d4.exceptions.active === d3.exceptions.active + 1, `exceptions ${JSON.stringify(d3.exceptions)}→${JSON.stringify(d4.exceptions)}`);
  assert(d4.waived === d3.waived + 1 && d4.violationsBySeverity.blocker === d3.violationsBySeverity.blocker - 1, `waived ${d3.waived}→${d4.waived}, blockers ${d3.violationsBySeverity.blocker}→${d4.violationsBySeverity.blocker}`);
  assert(d4.verdicts.fail === d3.verdicts.fail - 1 && d4.verdicts[after.verdict] === d3.verdicts[after.verdict] + 1, `verdicts ${JSON.stringify(d3.verdicts)}→${JSON.stringify(d4.verdicts)}`);
  const meta = (await api("GET", "/api/meta")).data;
  assert(d4.budget.app.used === meta.budget.app.used && d4.budget.app.limit === meta.budget.app.limit, "budget should match /api/meta");
  const rate = d4.rejectRateByStandard.find((x) => x.id === "SEC-001");
  assert(rate && rate.n > 0 && rate.rate > 0 && rate.rate <= 1, `reject rate ${JSON.stringify(rate)}`);
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

await check("polling one review has its own limit: 70 reads a minute from one IP all succeed", async () => {
  const ip = randomIp();
  const statuses = new Set();
  for (let i = 0; i < 70; i++) statuses.add((await api("GET", `/api/reviews/${aiReview.id}`, { user: DEV, ip })).status);
  assert(statuses.size === 1 && statuses.has(200), `statuses ${[...statuses]}`);
});

await check("rule findings are capped inside the Workflow step: 4,000 TODOs give 200 findings and a recorded gap", async () => {
  const r = await reviewOf(Array.from({ length: 4_000 }, (_, i) => `// TODO fix ${i}`).join("\n") + "\n");
  assert(r.status === "complete" && r.findings.length === 200, `status ${r.status}, ${r.findings.length} findings`);
  assert(r.coverage.skipped.some((s) => /over the 200-finding cap/.test(s.reason)) && r.verdict === "incomplete", `coverage ${JSON.stringify(r.coverage.skipped)}`);
  assert(r.events.some((e) => e.step === "rules" && /3800 over the cap dropped/.test(e.detail)), "the rules step should report the drop");
});

await check("daily AI budget: once used up, reviews run rules only (incomplete); challenges and chat get 429", async () => {
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
  const chat = await api("POST", `/api/reviews/${refused.id}/chat`, { user: DEV, body: { message: "why?" } });
  assert(chat.status === 429 && chat.data.error.code === "budget_exhausted" && Number(chat.headers.get("retry-after")) > 0, `chat got ${chat.status}`);
  assert((await api("GET", `/api/reviews/${refused.id}`, { user: DEV })).data.messages.length === 0, "a refused chat must store nothing");
  const after = (await api("GET", "/api/meta")).data.budget.app;
  assert(after.used <= after.limit, `budget overshot: ${after.used} > ${after.limit}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
console.log("Note: the local AI budget for today is now used up. Reset it with `npm run budget:reset:local`.");
process.exit(failures.length ? 1 : 0);
