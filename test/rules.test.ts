import { describe, expect, it } from "vitest";
import { parseInput } from "../core/diff.ts";
import { isLogicLine, redact, runRules } from "../core/rules.ts";
import { ALL_RULES, diff, MNT, SEC, std, TST } from "./helpers.ts";

const run = (input: string, standards = ALL_RULES) => runRules(parseInput(input), standards);
const only = (input: string, id: string) => run(input).filter((f) => f.standardId === id);

describe("SEC-001 hardcoded secrets", () => {
  it("flags credential-named literals and redacts the value in the evidence", () => {
    const [f, ...rest] = only('const apiKey = "demo-0000-not-a-real-key-9f8e7d";', "SEC-001");
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ classification: "violation", severity: "blocker", source: "rule", lineStart: 1, standardHash: SEC.contentHash });
    expect(f!.evidence).not.toContain("not-a-real-key-9f8e7d");
    expect(f!.evidence).toContain("demo…(31 chars)");
  });

  it("flags object-literal passwords and private key headers", () => {
    expect(only('  password: "Summer2026!prod",', "SEC-001")).toHaveLength(1);
    // Built at runtime so this file never contains a private key header itself.
    const header = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
    expect(only(`const pem = \`${header}`, "SEC-001")).toHaveLength(1);
  });

  it("does not flag env reads, placeholders, URLs or env var names", () => {
    const clean = [
      "const apiKey = env.PAYMENTS_API_KEY;",
      'API_KEY="<your-api-key>"',
      'const secret = "changeme";',
      'const tokenUrl = "https://auth.example.com/oauth/token";',
      'const tokenName = "PAYMENTS_TOKEN";',
      'const password = "short";',
      "const apiKey = `${prefix}-${env.SUFFIX}`;",
    ];
    for (const line of clean) expect(only(line, "SEC-001"), line).toHaveLength(0);
  });

  it("only checks lines the diff adds", () => {
    const d = diff("--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", ' const token = "old-context-value-123456";', "-x", "+y");
    expect(only(d, "SEC-001")).toHaveLength(0);
  });

  it("reports and redacts EVERY secret on a line (review: second secret leaked in plain text)", () => {
    const line = '{ user: "svc", password: "hunter2hunter2", clientSecret: "zzzzzzzz9999" }';
    const found = only(line, "SEC-001");
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.explanation)).toEqual([
      "`password` is assigned a literal credential.",
      "`clientSecret` is assigned a literal credential.",
    ]);
    for (const f of found) {
      expect(f.evidence).not.toContain("hunter2hunter2");
      expect(f.evidence).not.toContain("zzzzzzzz9999");
      expect(f.evidence).toBe('{ user: "svc", password: "hunt…(14 chars)", clientSecret: "zzzz…(12 chars)" }');
    }
  });

  it("does not re-insert a secret that contains $ replacement patterns (review: $& leak)", () => {
    for (const value of ["$&abcdefghij", "$'abcdefghij", "$`abcdefghij", "$1abcdefghij"]) {
      // A backtick can't sit inside a backtick-quoted literal; double quotes work for all four.
      const [f] = only(`const apiKey = "${value}";`, "SEC-001");
      expect(f, value).toBeDefined();
      expect(f!.evidence, value).not.toContain(value);
      expect(f!.evidence, value).not.toContain("abcdefghij");
    }
  });

  it("detects well-known token formats whatever the variable is called (review: sk_live_ passed)", () => {
    // Assembled at runtime so this file never contains a string in a real provider's key format.
    const j = (...p: string[]) => p.join("");
    const tokens = [
      j("sk", "_live_", "51H", "abcdefghijklmnopqrstuvwx"),
      j("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"),
      j("xo", "xb-", "1234567890-abcdefghij"),
      j("AI", "za", "SyA-abcdefghijklmnopqrstuvwxyz012345"),
      j("AK", "IA", "ABCDEFGHIJKLMNOP"),
    ];
    for (const t of tokens) {
      const [f] = only(`const key = "${t}";`, "SEC-001");
      expect(f, t).toBeDefined();
      expect(f!.evidence, t).not.toContain(t.slice(6));
    }
    const bearer = j("Bearer ", "eyJhbGciOiJIUzI1NiJ9.abcdefgh");
    expect(only(`headers: { Authorization: "${bearer}" }`, "SEC-001")).toHaveLength(1);
  });

  it("does not flag a bearer header built from a variable", () => {
    expect(only("headers: { authorization: `Bearer ${apiKey}` },", "SEC-001")).toHaveLength(0);
    expect(only('headers: { authorization: "Bearer " + token },', "SEC-001")).toHaveLength(0);
  });

  it("reports a Stripe key assigned to a credential name once, not twice", () => {
    const key = ["sk", "_test_", "abcdefghijklmnopqrstuvwx"].join("");
    expect(only(`const apiKey = "${key}";`, "SEC-001")).toHaveLength(1);
  });

  it("redact never returns the whole value", () => {
    expect(redact("abcdefgh")).toBe("****");
    expect(redact("abcdefghijkl")).toBe("abcd…(12 chars)");
  });
});

describe("MNT-001 TODOs need a ticket", () => {
  it("flags TODO and FIXME comments without a ticket", () => {
    expect(only("// TODO: later", "MNT-001")).toHaveLength(1);
    expect(only("# FIXME handle unicode", "MNT-001")).toHaveLength(1);
  });

  it("accepts ticket ids, issue numbers and links", () => {
    for (const line of ["// TODO(PAY-412): x", "// TODO #88 x", "// TODO see https://tracker/1"]) expect(only(line, "MNT-001"), line).toHaveLength(0);
  });

  it("doesn't mistake technical identifiers for tickets (review: SHA-256 passed)", () => {
    for (const line of ["// TODO: switch to SHA-256", "// TODO: force UTF-8", "// FIXME: ISO-8601 dates", "// TODO: patch CVE-2024-1234"]) {
      expect(only(line, "MNT-001"), line).toHaveLength(1);
    }
    expect(only("// TODO(PAY-12): switch to SHA-256", "MNT-001")).toHaveLength(0);
  });

  it("ignores TODO outside comments", () => {
    expect(only('const label = "TODO list";', "MNT-001")).toHaveLength(0);
  });
});

describe("TST-001 new logic needs tests", () => {
  const logic = (path: string) =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -0,0 +1,4 @@", "+export function f(a: number) {", "+  const b = a * 2;", "+  if (b > 10) return 10;", "+  return b;", "+}"];

  it("flags a code file with new logic and no test in the diff, anchored on the signature", () => {
    const [f, ...rest] = only(diff(...logic("src/f.ts")), "TST-001");
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ file: "src/f.ts", lineStart: 1, evidence: "export function f(a: number) {" });
  });

  it("is satisfied by any test file in the diff", () => {
    expect(only(diff(...logic("src/f.ts"), ...logic("src/f.test.ts")), "TST-001")).toHaveLength(0);
  });

  it("ignores snippets, non-code files and tiny changes", () => {
    expect(only("export function f() {\n  a();\n  b();\n  c();\n}", "TST-001")).toHaveLength(0);
    expect(only(diff(...logic("docs/f.md")), "TST-001")).toHaveLength(0);
    expect(only(diff("--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2 @@", "+import x from 'y';", "+const z = 1;"), "TST-001")).toHaveLength(0);
  });

  it("does not count comments, imports and braces as logic", () => {
    expect(["// hi", "import a from 'b'", "}", "  );", "", "export { a } from './a'"].some(isLogicLine)).toBe(false);
    expect(["return a;", "if (x) y();", "const a = 1;"].every(isLogicLine)).toBe(true);
  });
});

describe("runRules", () => {
  it("skips disabled standards", () => {
    const input = '// TODO: x\nconst apiKey = "demo-0000-not-a-real-key-9f8e7d";';
    expect(run(input, [{ ...SEC, enabled: false }, MNT, TST]).map((f) => f.standardId)).toEqual(["MNT-001"]);
  });

  it("ignores llm-only standards and standards with no rule implementation", () => {
    expect(run('const apiKey = "demo-0000-not-a-real-key-9f8e7d";', [{ ...SEC, detector: "llm" }, std("XYZ-001")])).toHaveLength(0);
  });

  it("copies severity from the standard, not from the rule", () => {
    expect(run("// TODO: x", [{ ...MNT, severity: "major" }])[0]!.severity).toBe("major");
  });
});
