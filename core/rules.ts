// Deterministic detectors. They never call an LLM and never look at history or feedback, so a
// rule finding is reproducible: the same input and standards always give the same findings.
import { isCodePath } from "./diff.ts";
import { usesRule } from "./standards.ts";
import type { FileChunk, Finding, ParsedInput, SourceLine, Standard } from "./types.ts";

type RuleFn = (input: ParsedInput, s: Standard) => Finding[];

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
    evidence,
    ...text,
  };
}

// ---------------------------------------------------------------------------------------------
// SEC-001: hardcoded secrets

const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*`;
/** `name = "literal"` / `name: 'literal'` where the name says it is a credential. */
const SECRET_ASSIGNMENT = new RegExp(String.raw`["']?\b(${SECRET_NAME})\b["']?\s*[:=]\s*(["'\`])([^"'\`\s]{8,})\2`, "i");
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;
/** Values that are obviously not real credentials. */
const PLACEHOLDER = /^(?:<.*>|\$\{.*\}|\{\{.*\}\}|x{4,}|\*{4,}|changeme|placeholder|redacted|your[_-].*|example.*|dummy.*|none|null|undefined|test)$/i;

/** Values a credential-named variable often holds that are not credentials: URLs, paths, env var names. */
const NOT_A_SECRET_VALUE = /^(?:https?:\/\/|\/|\.\.?\/)|^[A-Z][A-Z0-9_]+$/;

/** Keep enough of a secret to recognise it, never the whole value. */
export function redact(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}…(${value.length} chars)`;
}

const SEC_TEXT = {
  explanation: "A credential is written into the source as a literal value.",
  impact: "Anyone with access to the repository, its history, build logs or the deployed bundle can use the credential. Rotating it means a code change.",
  remediation: "Remove the literal, rotate the credential, and read it at runtime from an environment binding or secret store (for example `env.MY_API_KEY` set with `wrangler secret put`).",
};

const sec001: RuleFn = (input, s) => {
  const out: Finding[] = [];
  for (const f of input.files) {
    for (const line of f.lines) {
      if (!line.added) continue;
      const a = SECRET_ASSIGNMENT.exec(line.text);
      if (a && !PLACEHOLDER.test(a[3]!) && !NOT_A_SECRET_VALUE.test(a[3]!)) {
        const ev = line.text.trim().replace(a[3]!, redact(a[3]!));
        out.push(finding(s, f.path, line, ev, SEC_TEXT));
        continue;
      }
      const k = PRIVATE_KEY.exec(line.text);
      if (k) {
        out.push(finding(s, f.path, line, k[0], { ...SEC_TEXT, explanation: "A private key is embedded in the source." }));
        continue;
      }
      const aws = AWS_ACCESS_KEY_ID.exec(line.text);
      if (aws) {
        out.push(finding(s, f.path, line, line.text.trim().replace(aws[0], redact(aws[0])), { ...SEC_TEXT, explanation: "An AWS access key id is embedded in the source." }));
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// MNT-001: TODO/FIXME without a ticket

const TODO_IN_COMMENT = /(?:\/\/|#|\/\*|^\s*\*|<!--|--)\s*.*?\b(TODO|FIXME)\b/;
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b|#\d+\b|https?:\/\//;

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
