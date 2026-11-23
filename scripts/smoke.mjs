// End-to-end API smoke test for PR 3-A. Runs against a live server:
//   npm run dev            (in another terminal; after npm run db:setup:local)
//   npm run smoke          (or: node scripts/smoke.mjs https://<deployed-url>)
//
// It changes data (creates reviews, toggles MNT-001 off and back on), so point it at a dev or
// demo database, not one you care about.
const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const DEV = "dev-asha";
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
async function api(method, path, { user, body, raw } = {}) {
  const headers = {};
  if (user) headers["x-demo-user"] = user;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

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
let firstReview;

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

await check("a review of the sample diff finds the secret, the TODO and the missing tests", async () => {
  const r = await api("POST", "/api/reviews", { user: DEV, body: { input: SAMPLE } });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.data)}`);
  firstReview = r.data;
  const ids = r.data.findings.map((f) => f.standardId).sort();
  assert(JSON.stringify(ids) === JSON.stringify(["MNT-001", "SEC-001", "TST-001"]), `found ${ids}`);
  assert(r.data.verdict === "fail", `verdict ${r.data.verdict}`);
  const sec = r.data.findings.find((f) => f.standardId === "SEC-001");
  assert(sec.file === "src/pay.ts" && sec.lineStart === 2, `SEC-001 at ${sec.file}:${sec.lineStart}`);
  assert(!sec.evidence.includes("not-a-real-key-9f8e7d"), "secret must be redacted in evidence");
  assert(r.data.standards.length >= 8 && r.data.standards.every((s) => s.contentHash), "review must snapshot every standard");
});

await check("an approver disables MNT-001; the change is audited with who and when", async () => {
  const r = await api("PATCH", "/api/standards/MNT-001", { user: APPROVER, body: { enabled: false } });
  assert(r.status === 200 && r.data.enabled === false && r.data.updatedBy?.id === APPROVER, `got ${r.status} ${JSON.stringify(r.data)}`);
  const log = (await api("GET", "/api/standards/MNT-001/changes", { user: DEV })).data;
  assert(log[0].changedBy.id === APPROVER && log[0].newValue === "false" && log[0].changedAt, "missing audit row");
});

await check("a new review no longer reports the disabled standard", async () => {
  const r = await api("POST", "/api/reviews", { user: DEV, body: { input: SAMPLE } });
  assert(r.status === 201, `status ${r.status}`);
  assert(!r.data.findings.some((f) => f.standardId === "MNT-001"), "MNT-001 should not run while disabled");
  assert(r.data.standards.find((s) => s.id === "MNT-001").enabled === false, "snapshot should record MNT-001 as disabled");
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
});

// --- Regressions from the review of PR #2 (prompt 4) -----------------------------------------

await check("review: every secret on a line is reported and redacted, through the API", async () => {
  const input = '{ user: "svc", password: "hunter2hunter2", clientSecret: "zzzzzzzz9999" }';
  const r = await api("POST", "/api/reviews", { user: DEV, body: { input } });
  assert(r.status === 201, `status ${r.status}`);
  const sec = r.data.findings.filter((f) => f.standardId === "SEC-001");
  assert(sec.length === 2, `expected 2 SEC-001 findings, got ${sec.length}`);
  const body = JSON.stringify(r.data.findings);
  assert(!body.includes("hunter2hunter2") && !body.includes("zzzzzzzz9999"), "a secret leaked into the findings");
});

await check("review: a $& secret is not re-inserted by redaction", async () => {
  const r = await api("POST", "/api/reviews", { user: DEV, body: { input: 'const apiKey = "$&abcdefghij";' } });
  assert(r.status === 201 && r.data.findings.length === 1, `got ${r.status} / ${r.data.findings?.length}`);
  assert(!JSON.stringify(r.data.findings).includes("abcdefghij"), "secret leaked");
});

await check("review: an input just under 100 KB is accepted even though its JSON body is larger", async () => {
  const line = 'const s = "a \\"quoted\\" value\\twith escapes";\n'; // escapes inflate the JSON body
  const input = line.repeat(Math.floor(99_000 / line.length));
  assert(Buffer.byteLength(input) < 100_000, "test input too big");
  assert(Buffer.byteLength(JSON.stringify({ input })) > 101_000, "test body should exceed the old cap");
  const r = await api("POST", "/api/reviews", { user: DEV, body: { input } });
  assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.data?.error)}`);
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

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
