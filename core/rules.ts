// Deterministic detectors. They never call an LLM and never look at history or feedback, so a
// rule finding is reproducible: the same input and standards always give the same findings.
import { isCodePath } from "./diff.ts";
import { usesRule } from "./standards.ts";
import type { FileChunk, Finding, ParsedInput, SourceLine, Standard } from "./types.ts";

type RuleFn = (input: ParsedInput, s: Standard) => Finding[];

/**
 * Evidence is the (redacted) line. A minified file can be one 100 KB line, and every secret on it
 * is its own finding, so the evidence is clipped to keep findings, and the Workflow step that
 * returns them, small.
 */
export const MAX_EVIDENCE_CHARS = 500;
const clip = (text: string) => (text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}… (line clipped)` : text);

function finding(s: Standard, file: string, line: SourceLine, evidence: string, text: { explanation: string; impact: string; remediation: string }): Finding {
  return {
    standardId: s.id,
    standardHash: s.contentHash,
    classification: "violation", // a deterministic match is a definite violation by definition
    severity: s.severity,
    source: "rule",
    file,
    lineStart: line.n,
    lineEnd: line.n,
    evidence: clip(evidence),
    ...text,
  };
}

// ---------------------------------------------------------------------------------------------
// SEC-001: hardcoded secrets
//
// Every secret on a line is found, reported as its own finding, and redacted in the evidence of
// every finding for that line. Redaction splices by index; it never goes through String.replace,
// whose replacement string interprets `$&`, `$1` and friends.

const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*`;
/** `name = "literal"` / `name: 'literal'` where the name says it is a credential. */
const SECRET_ASSIGNMENT = new RegExp(String.raw`["']?\b(${SECRET_NAME})\b["']?\s*[:=]\s*(["'\`])((?:(?!\2)\S){8,})\2`, "gi");
/** Values that are obviously not real credentials. */
const PLACEHOLDER = /^(?:<.*>|\$\{.*\}|\{\{.*\}\}|x{4,}|\*{4,}|changeme|placeholder|redacted|your[_-].*|example.*|dummy.*|none|null|undefined|test)$/i;
/** Values a credential-named variable often holds that are not credentials: URLs, paths, env var names. */
const NOT_A_SECRET_VALUE = /^(?:https?:\/\/|\/|\.\.?\/)|^[A-Z][A-Z0-9_]+$/;

/** Credentials recognisable by their format, whatever the variable is called. */
const KNOWN_TOKENS: { label: string; re: RegExp }[] = [
  { label: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/g },
  { label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { label: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
];
/** A literal bearer token, e.g. `Authorization: "Bearer abc…"`. `Bearer ${token}` doesn't match. */
const BEARER_LITERAL = /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;

/**
 * Whether a literal assigned to a credential-named variable is clearly not a credential: a
 * placeholder, a URL or path, an env var name, or an interpolation. The rule-based check and the
 * AI findings (core/llm.ts) use the same definition.
 */
export function isNotASecret(value: string): boolean {
  return PLACEHOLDER.test(value) || NOT_A_SECRET_VALUE.test(value) || value.includes("${");
}

/** Keep enough of a secret to recognise it, never the whole value. */
export function redact(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}…(${value.length} chars)`;
}

export interface SecretHit {
  start: number;
  end: number;
  explanation: string;
}

/** All secret values on one line, as non-overlapping [start, end) spans, in order. */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const m of text.matchAll(SECRET_ASSIGNMENT)) {
    const name = m[1]!;
    const value = m[3]!;
    if (isNotASecret(value)) continue;
    const start = m.index + m[0].length - 1 - value.length; // the value sits just before the closing quote
    hits.push({ start, end: start + value.length, explanation: `\`${name}\` is assigned a literal credential.` });
  }
  for (const { label, re } of KNOWN_TOKENS) {
    for (const m of text.matchAll(re)) hits.push({ start: m.index, end: m.index + m[0].length, explanation: `A ${label} is written into the source.` });
  }
  for (const m of text.matchAll(BEARER_LITERAL)) {
    const start = m.index + m[0].length - m[1]!.length;
    hits.push({ start, end: start + m[1]!.length, explanation: "A literal bearer token is written into the source." });
  }
  // Overlaps (a Stripe key assigned to `apiKey`) are one secret: keep the earliest, widest span.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretHit[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else out.push({ ...h });
  }
  return out;
}

/** The line with every secret span replaced by its redacted form. */
export function redactLine(text: string, hits: SecretHit[]): string {
  let out = "";
  let pos = 0;
  for (const h of hits) {
    out += text.slice(pos, h.start) + redact(text.slice(h.start, h.end));
    pos = h.end;
  }
  return (out + text.slice(pos)).trim();
}

const SEC_TEXT = {
  impact: "Anyone with access to the repository, its history, build logs or the deployed bundle can use the credential. Rotating it means a code change.",
  remediation: "Remove the literal, rotate the credential, and read it at runtime from an environment binding or secret store (for example `env.MY_API_KEY` set with `wrangler secret put`).",
};

const sec001: RuleFn = (input, s) => {
  const out: Finding[] = [];
  for (const f of input.files) {
    for (const line of f.lines) {
      if (!line.added) continue;
      const hits = findSecrets(line.text);
      if (hits.length) {
        const evidence = redactLine(line.text, hits);
        for (const h of hits) out.push(finding(s, f.path, line, evidence, { ...SEC_TEXT, explanation: h.explanation }));
        continue;
      }
      const k = PRIVATE_KEY.exec(line.text);
      if (k) out.push(finding(s, f.path, line, k[0], { ...SEC_TEXT, explanation: "A private key is embedded in the source." }));
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// MNT-001: TODO/FIXME without a ticket

const TODO_IN_COMMENT = /(?:\/\/|#|\/\*|^\s*\*|<!--|--)\s*.*?\b(TODO|FIXME)\b/;
/**
 * A ticket reference: a project key like PAY-412, an issue number like #88, or a link. Common
 * technical identifiers that look like keys (SHA-256, UTF-8, ISO-8601, RFC-7231, CVE-…) are not
 * tickets. A team with unusual keys would make this list configurable; for now it's fixed.
 */
const NOT_A_PROJECT_KEY = "SHA|UTF|ISO|RFC|HTTP|TLS|SSL|AES|RSA|MD|UTC|GMT|ES|ECMA|IEEE|CVE|CWE|PEP|JSR|WCAG|OWASP|IPV|BASE|X";
const TICKET = new RegExp(String.raw`\b(?!(?:${NOT_A_PROJECT_KEY})-)[A-Z][A-Z0-9]{1,9}-\d+\b|#\d+\b|https?:\/\/`);

const mnt001: RuleFn = (input, s) => {
  const out: Finding[] = [];
  for (const f of input.files) {
    for (const line of f.lines) {
      if (!line.added) continue;
      const m = TODO_IN_COMMENT.exec(line.text);
      if (m && !TICKET.test(line.text)) {
        out.push(
          finding(s, f.path, line, line.text.trim(), {
            explanation: `A ${m[1]} comment has no ticket reference.`,
            impact: "Untracked follow-up work is easy to forget; nobody owns it and it never gets prioritised.",
            remediation: `File a ticket and reference it in the comment, for example \`// ${m[1]}(PROJ-123): …\`, or do the work now.`,
          }),
        );
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// TST-001: new logic without tests (diffs only)

export const MIN_LOGIC_LINES = 3;

/** An added line that does something: not blank, not a comment, not an import or a lone brace. */
export function isLogicLine(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (/^(\/\/|#|\/\*|\*|\*\/|<!--)/.test(t)) return false;
  if (/^(import\b|export\s+\*|export\s+\{[^}]*\}\s+from\b|from\s+\S+\s+import\b|package\b|using\b)/.test(t)) return false;
  if (/^(const|let|var)\s+\w+\s*=\s*require\(/.test(t)) return false;
  if (/^[\s{}()[\];,]*$/.test(t)) return false;
  return true;
}

const tst001: RuleFn = (input, s) => {
  if (input.kind !== "diff") return []; // a snippet has no context to tell
  if (input.files.some((f) => f.isTest)) return [];
  const out: Finding[] = [];
  for (const f of input.files) {
    if (!isCodePath(f.path)) continue;
    const logic = f.lines.filter((l) => l.added && isLogicLine(l.text));
    if (logic.length < MIN_LOGIC_LINES) continue;
    const anchor = pickAnchor(f, logic);
    out.push(
      finding(s, f.path, anchor, anchor.text.trim(), {
        explanation: `This change adds ${logic.length} lines of logic to ${f.path}, and the diff contains no test file.`,
        impact: "Untested logic can regress silently, and reviewers have no executable statement of the intended behaviour.",
        remediation: `Add or update a test that covers the new behaviour in ${f.path} in the same change.`,
      }),
    );
  }
  return out;
};

/** Prefer a function or class signature as evidence; it says more than an arbitrary first line. */
function pickAnchor(_f: FileChunk, logic: SourceLine[]): SourceLine {
  const sig = logic.find((l) => /\b(function|class|def|func|fn)\b|=>\s*\{?\s*$|^\s*(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*\{/.test(l.text));
  return sig ?? logic[0]!;
}

// ---------------------------------------------------------------------------------------------

/** Rule implementations by standard id. A standard marked `rule` without an entry here is ignored. */
export const RULES: Readonly<Record<string, RuleFn>> = {
  "SEC-001": sec001,
  "MNT-001": mnt001,
  "TST-001": tst001,
};

/** Run every enabled, rule-detected standard that has an implementation. */
export function runRules(input: ParsedInput, standards: Standard[]): Finding[] {
  return standards.filter((s) => s.enabled && usesRule(s) && RULES[s.id]).flatMap((s) => RULES[s.id]!(input, s));
}

/**
 * Redact every secret findSecrets recognises, line by line. Used on AI-written text (evidence and
 * explanations), which can quote a credential back even when the rule-based check didn't fire.
 */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const hits = findSecrets(line);
      return hits.length ? redactLine(line, hits) : line;
    })
    .join("\n");
}
