// What the Action writes on the pull request: the gating decision, the check run's annotations, and
// the Markdown for the summary comment, the check's summary and the job summary. Pure functions, so
// the wording, the limits and the escaping are unit-tested.
//
// Everything here is built from verified findings. The model's text (explanations, quoted code) is
// untrusted: it is neutralised before it goes into Markdown, because a PR comment is public and
// renders links, images and @mentions.
import type { Annotation } from "./github.ts";
import type { Coverage, Finding, Severity, Verdict } from "../core/types.ts";

export const SUMMARY_MARKER = "<!-- guardrail:summary -->";
export const CHECK_NAME = "Guardrail";

/** GitHub's limit on a check's summary and a comment body is 65,535 characters; stay well under it. */
const MAX_MARKDOWN = 60_000;
const MAX_TABLE_ROWS = 40;
const MAX_SUGGESTIONS = 30;
const MAX_GAPS = 30;

export type FailOn = "none" | "blocker" | "major";
export type Conclusion = "success" | "neutral" | "failure";

export interface Counts {
  violations: number;
  blockers: number;
  majors: number;
  suggestions: number;
}

export function countFindings(findings: Pick<Finding, "classification" | "severity" | "waivedBy">[]): Counts {
  const violations = findings.filter((f) => f.classification === "violation" && !f.waivedBy);
  return {
    violations: violations.length,
    blockers: violations.filter((f) => f.severity === "blocker").length,
    majors: violations.filter((f) => f.severity === "major").length,
    suggestions: findings.filter((f) => f.classification === "suggestion").length,
  };
}

/**
 * The check's conclusion (design §7). Advisory unless `failOn` says otherwise; findings waived by
 * an exception never count. `incomplete` is neutral unless `failOnIncomplete`.
 */
export function gate(verdict: Verdict, counts: Counts, failOn: FailOn, failOnIncomplete: boolean): Conclusion {
  if (failOn === "blocker" && counts.blockers > 0) return "failure";
  if (failOn === "major" && counts.blockers + counts.majors > 0) return "failure";
  if (verdict === "incomplete") return failOnIncomplete ? "failure" : "neutral";
  return counts.violations > 0 ? "neutral" : "success";
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function checkTitle(verdict: Verdict, c: Counts): string {
  const parts = [plural(c.violations, "violation")];
  if (c.blockers) parts.push(`${c.blockers} blocker${c.blockers === 1 ? "" : "s"}`);
  return `${verdict}: ${parts.join(", ")}`;
}

// --- Escaping --------------------------------------------------------------------------------

/** One line of untrusted text, safe inside a Markdown table cell or sentence. */
export function clean(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return cut
    .replace(/[<>[\]|]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "[": "\\[", "]": "\\]", "|": "\\|" })[c]!)
    .replace(/@/g, "@​") // a zero-width space stops a @mention from notifying anyone
    .replace(/`/g, "'");
}

/** A code block whose fence is longer than any run of backticks inside it. */
export function codeBlock(text: string, max = 1_500): string {
  const body = text.length > max ? `${text.slice(0, max)}\n…` : text;
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

const place = (f: Pick<Finding, "file" | "lineStart" | "lineEnd">) => `${f.file}:${f.lineStart}${f.lineEnd > f.lineStart ? `-${f.lineEnd}` : ""}`;

// --- Annotations -----------------------------------------------------------------------------

const LEVEL: Record<Severity, Annotation["annotation_level"]> = { blocker: "failure", major: "warning", minor: "notice" };

/** One annotation per finding. Suggestions are notices whatever the standard's severity. */
export function annotationsFor(findings: Finding[]): Annotation[] {
  return findings
    .filter((f) => !f.waivedBy)
    .map((f) => {
      const isViolation = f.classification === "violation";
      return {
        path: f.file,
        start_line: f.lineStart,
        end_line: Math.max(f.lineStart, f.lineEnd),
        annotation_level: isViolation ? LEVEL[f.severity] : "notice",
        title: `${f.standardId}${isViolation ? "" : " (suggestion)"}${f.preExisting ? " (pre-existing)" : ""}`.slice(0, 255),
        message: [clean(f.explanation, 600), f.remediation ? `Fix: ${clean(f.remediation, 400)}` : ""].filter(Boolean).join("\n").slice(0, 60_000),
      };
    });
}

// --- Summary ---------------------------------------------------------------------------------

export interface Report {
  verdict: Verdict;
  findings: Finding[];
  coverage: Coverage;
  /** "openai-compatible", "anthropic", ..., or "none". */
  provider: string;
  model?: string;
  /** Why the AI standards weren't checked, when they weren't (any reason other than a gap in coverage). */
  aiNote?: string;
  standardsSource: "repository" | "built-in";
  standardsChanged: boolean;
  /** Titles of the standards that need AI, listed when AI didn't run. */
  notChecked: string[];
  headSha: string;
  conclusion: Conclusion;
}

export function renderSummary(r: Report, opts: { marker?: boolean } = {}): string {
  const c = countFindings(r.findings);
  const violations = r.findings.filter((f) => f.classification === "violation" && !f.waivedBy);
  const suggestions = r.findings.filter((f) => f.classification === "suggestion");
  const out: string[] = [];
  if (opts.marker ?? true) out.push(SUMMARY_MARKER);
  out.push(`## Guardrail: ${r.verdict}`, "");
  out.push(
    `${plural(c.violations, "violation")}${c.blockers ? ` (${c.blockers} blocker${c.blockers === 1 ? "" : "s"})` : ""}, ${plural(c.suggestions, "suggestion")}. ` +
      `${r.coverage.filesReviewed} of ${plural(r.coverage.filesTotal, "file")} reviewed. Check conclusion: **${r.conclusion}**.`,
    "",
  );

  const how = [r.provider === "none" ? "Rules only (`provider: none`)" : `Rules and AI (\`${clean(r.provider)}\`${r.model ? `, \`${clean(r.model)}\`` : ""})`];
  how.push(r.standardsSource === "repository" ? "standards from this repository's base commit" : "built-in standards");
  out.push(`${how.join("; ")}. Commit \`${r.headSha.slice(0, 7)}\`.`, "");
  if (r.standardsChanged) out.push("> This pull request changes the standards folder. It was reviewed against the standards at the base commit, so the change takes effect after it merges.", "");
  if (r.aiNote) out.push(`> ${r.aiNote}`, "");
  if (r.notChecked.length) out.push(`Not checked, because they need AI: ${r.notChecked.map((t) => clean(t, 80)).join("; ")}.`, "");

  if (violations.length) {
    out.push("### Violations", "", "| Standard | Severity | Location | Finding |", "|---|---|---|---|");
    for (const f of violations.slice(0, MAX_TABLE_ROWS)) {
      out.push(`| ${f.standardId} | ${f.severity} | \`${clean(place(f), 120)}\` | ${clean(f.explanation, 300)} Fix: ${clean(f.remediation, 200)} |`);
    }
    if (violations.length > MAX_TABLE_ROWS) out.push("", `…and ${violations.length - MAX_TABLE_ROWS} more; the check's annotations list them all.`);
    out.push("");
  }
  if (suggestions.length) {
    out.push(`<details><summary>Suggestions (${suggestions.length})</summary>`, "");
    for (const f of suggestions.slice(0, MAX_SUGGESTIONS)) {
      out.push(`- ${f.standardId} in \`${clean(place(f), 120)}\`${f.preExisting ? " (pre-existing)" : ""}: ${clean(f.explanation, 300)}`);
    }
    if (suggestions.length > MAX_SUGGESTIONS) out.push(`- …and ${suggestions.length - MAX_SUGGESTIONS} more`);
    out.push("", "</details>", "");
  }
  if (r.coverage.skipped.length) {
    out.push("### Not fully reviewed", "");
    for (const g of r.coverage.skipped.slice(0, MAX_GAPS)) out.push(`- \`${clean(g.file, 120)}\`: ${clean(g.reason, 200)}`);
    if (r.coverage.skipped.length > MAX_GAPS) out.push(`- …and ${r.coverage.skipped.length - MAX_GAPS} more`);
    out.push("");
  }
  if (!violations.length && !suggestions.length && !r.coverage.skipped.length) out.push("No findings.", "");

  const md = out.join("\n").trimEnd();
  return md.length > MAX_MARKDOWN ? `${md.slice(0, MAX_MARKDOWN)}\n\n…(shortened)` : md;
}
