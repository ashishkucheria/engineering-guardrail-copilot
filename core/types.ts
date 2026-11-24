// Shared domain types. Everything in core/ is pure: no Worker bindings, no network, no Node APIs,
// so the same code runs in the Worker, the browser (types only), the eval runner and unit tests.

export type Severity = "blocker" | "major" | "minor";
export type DetectorKind = "rule" | "llm" | "rule+llm";
export type Classification = "violation" | "suggestion";
export type FindingSource = "rule" | "llm";
export type Verdict = "pass" | "warn" | "fail" | "incomplete";
export type Role = "developer" | "approver";

export interface StandardContent {
  id: string;
  title: string;
  severity: Severity;
  detector: DetectorKind;
  rule: string;
  compliant?: string;
  violating?: string;
}

export interface Standard extends StandardContent {
  contentHash: string;
  enabled: boolean;
}

/** What each review records about every standard at submit time, so history stays reproducible. */
export interface StandardSnapshot {
  id: string;
  contentHash: string;
  severity: Severity;
  enabled: boolean;
}

export interface SourceLine {
  /** Line number in the new version of the file (or in the snippet). */
  n: number;
  text: string;
  /** True for lines the change adds. Every snippet line counts as added. */
  added: boolean;
}

export interface FileChunk {
  path: string;
  lines: SourceLine[];
  isTest: boolean;
}

export interface Coverage {
  filesTotal: number;
  filesReviewed: number;
  skipped: { file: string; reason: string }[];
}

export interface ParsedInput {
  kind: "snippet" | "diff";
  files: FileChunk[];
  coverage: Coverage;
}

export interface Finding {
  standardId: string;
  standardHash: string;
  classification: Classification;
  severity: Severity;
  source: FindingSource;
  file: string;
  lineStart: number;
  lineEnd: number;
  evidence: string;
  explanation: string;
  impact: string;
  remediation: string;
  /**
   * AI finding whose evidence lies only on unchanged context lines of a diff: always a suggestion,
   * labelled "pre-existing", so a change can't fail for code it didn't touch (design §6).
   */
  preExisting?: boolean;
}

export interface User {
  id: string;
  name: string;
  role: Role;
}
