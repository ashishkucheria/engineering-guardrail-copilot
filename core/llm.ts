// The LLM detector (design §5–§6). Pure apart from the injected client, so the Worker, the
// Workflow, the eval endpoint and the unit tests all run the same code.
//
// What the model decides: which standard a piece of code breaks, the quote, and the wording.
// What code decides: whether the quote exists (verification), the lines, severity, classification,
// redaction and the verdict.
import { planChunks, chunkLabel, type CodeChunk } from "./chunk.ts";
import { buildDetectionMessages, detectionSchema, PROMPT_VERSION, type ChatMessage, type JsonSchema } from "./prompts.ts";
import { isNotASecret, redact, redactSecrets } from "./rules.ts";
import { usesLlm } from "./standards.ts";
import type { Detector } from "./engine.ts";
import type { Finding, ParsedInput, SourceLine, Standard } from "./types.ts";

export interface LlmClient {
  /** Model id, recorded on every review. */
  model: string;
  /** One JSON-mode call. Resolves to the parsed object (or its JSON text); rejects on any failure. */
  json(messages: ChatMessage[], schema: JsonSchema, opts?: { maxTokens?: number; seed?: number }): Promise<unknown>;
}

/**
 * Calls run at temperature 0, so the same prompt and seed tend to give the same answer. A retry
 * with the same seed would most likely repeat a malformed or truncated answer and waste a call, so
 * every retry uses the next seed (review of PR #3, item 1).
 */
export const BASE_SEED = 42;
export const seedFor = (attempt: number) => BASE_SEED + Math.max(0, attempt - 1);

/** Coverage reason when a chunk is skipped because the day's AI budget is used up. */
export const BUDGET_REASON = "daily AI budget reached";

/** A response that doesn't fit the schema. Thrown so the caller retries it like any other failure. */
export class LlmFormatError extends Error {
  override name = "LlmFormatError";
}

export interface RawLlmFinding {
  standard_id: string;
  certainty: "definite" | "possible";
  evidence: string;
  explanation: string;
  impact: string;
  remediation: string;
}

/** Above this, a chunk's answer is treated as runaway output, not as findings. */
export const MAX_FINDINGS_PER_CHUNK = 30;

export function parseJsonResponse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmFormatError("The model's answer is not valid JSON.");
  }
}

/** Validate the detection answer. A malformed envelope throws; a malformed item is just skipped. */
export function parseDetection(raw: unknown): { items: RawLlmFinding[]; malformed: number } {
  const data = parseJsonResponse(raw) as { findings?: unknown } | null;
  if (!data || typeof data !== "object" || !Array.isArray(data.findings)) throw new LlmFormatError('The answer has no "findings" array.');
  if (data.findings.length > MAX_FINDINGS_PER_CHUNK) throw new LlmFormatError(`The answer has ${data.findings.length} findings; more than ${MAX_FINDINGS_PER_CHUNK} for one chunk is treated as a bad answer.`);
  const items: RawLlmFinding[] = [];
  let malformed = 0;
  for (const f of data.findings as Record<string, unknown>[]) {
    const ok =
      f &&
      typeof f === "object" &&
      typeof f.standard_id === "string" &&
      (f.certainty === "definite" || f.certainty === "possible") &&
      ["evidence", "explanation", "impact", "remediation"].every((k) => typeof f[k] === "string");
    if (ok) items.push(f as unknown as RawLlmFinding);
    else malformed++;
  }
  return { items, malformed };
}

// ---------------------------------------------------------------------------------------------
// Evidence verification

/** The prefix renderLine adds ("12+| "), in case the model copied it into the quote. */
const LINE_PREFIX = /^\s*\d+[+ ]?\|\s?/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function evidenceLines(evidence: string): string[] {
  return evidence
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => norm(l.replace(LINE_PREFIX, "")))
    .filter((l) => l !== "");
}

function lineMatches(source: string, quoted: string): boolean {
  const s = norm(source);
  // A quote may carry a diff marker the model copied from a pasted diff.
  return s.includes(quoted) || (/^[+-]/.test(quoted) && s.includes(quoted.slice(1).trim()));
}

export interface EvidenceMatch {
  lines: SourceLine[];
}

/**
 * Where the quote appears in the chunk: consecutive non-blank lines that each contain the
 * corresponding quoted line (after normalising whitespace). Prefers a match that touches an added
 * line. Returns null when the quote isn't in the code, or is too short to mean anything.
 */
export function locateEvidence(evidence: string, lines: SourceLine[]): EvidenceMatch | null {
  const quoted = evidenceLines(evidence);
  if (quoted.length === 0 || quoted.join("").replace(/\s/g, "").length < 4) return null;
  const nonBlank = lines.filter((l) => l.text.trim() !== "");
  let best: EvidenceMatch | null = null;
  for (let i = 0; i + quoted.length <= nonBlank.length; i++) {
    const window = nonBlank.slice(i, i + quoted.length);
    if (window.every((l, j) => lineMatches(l.text, quoted[j]!))) {
      if (window.some((l) => l.added)) return { lines: window };
      best ??= { lines: window };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// One chunk

export interface ChunkResult {
  findings: Finding[];
  /** Answers that were dropped, by reason, for the review_events log and the eval. */
  dropped: { notInInput: number; unknownStandard: number; malformed: number; placeholder: number };
}

export interface DetectOptions {
  /** Off only for the eval config that measures what verification is worth. */
  verify?: boolean;
  /** Seed for this call; see seedFor. */
  seed?: number;
}

/** String literals quoted in SEC-001 evidence; they are redacted wherever the model repeats them. */
function quotedLiterals(text: string): string[] {
  return [...text.matchAll(/(["'`])((?:(?!\1).){4,})\1/g)].map((m) => m[2]!);
}

function scrub(text: string, literals: string[]): string {
  let out = redactSecrets(text);
  for (const lit of literals) out = out.split(lit).join(redact(lit)); // split/join: no `$&` surprises
  return out;
}

export function toFindings(items: RawLlmFinding[], chunk: CodeChunk, standards: Standard[], opts: DetectOptions = {}): ChunkResult {
  const verify = opts.verify ?? true;
  const byId = new Map(standards.map((s) => [s.id, s]));
  const dropped = { notInInput: 0, unknownStandard: 0, malformed: 0, placeholder: 0 };
  const findings: Finding[] = [];
  for (const item of items) {
    const s = byId.get(item.standard_id);
    if (!s) {
      dropped.unknownStandard++;
      continue;
    }
    let match = locateEvidence(item.evidence, chunk.lines);
    if (!match) {
      if (verify) {
        dropped.notInInput++;
        continue;
      }
      const anchor = chunk.lines.find((l) => l.added) ?? chunk.lines[0]!;
      match = { lines: [anchor] };
    }
    const literals = s.id === "SEC-001" ? quotedLiterals(item.evidence) : [];
    // A "secret" whose every quoted value is a placeholder ("<your-key>", "****", "${X}") is not
    // one, by the same definition the rule-based check uses.
    if (literals.length > 0 && literals.every(isNotASecret)) {
      dropped.placeholder++;
      continue;
    }
    const touchesAdded = match.lines.some((l) => l.added);
    findings.push({
      standardId: s.id,
      standardHash: s.contentHash,
      classification: item.certainty === "definite" && touchesAdded ? "violation" : "suggestion",
      severity: s.severity, // from the standard, never from the model
      source: "llm",
      file: chunk.path,
      lineStart: match.lines[0]!.n,
      lineEnd: match.lines[match.lines.length - 1]!.n,
      evidence: scrub(evidenceLines(item.evidence).join("\n"), literals),
      explanation: scrub(item.explanation.trim(), literals),
      impact: scrub(item.impact.trim(), literals),
      remediation: scrub(item.remediation.trim(), literals),
      ...(touchesAdded ? {} : { preExisting: true }),
    });
  }
  return { findings, dropped };
}

/** The standards the model is asked about: enabled ones that use the LLM. */
export function llmStandards(enabled: Standard[]): Standard[] {
  return enabled.filter((s) => s.enabled && usesLlm(s));
}

export async function detectChunk(client: LlmClient, chunk: CodeChunk, standards: Standard[], opts: DetectOptions = {}): Promise<ChunkResult> {
  const messages = buildDetectionMessages(chunk, standards);
  const raw = await client.json(messages, detectionSchema(standards.map((s) => s.id)), { maxTokens: 2048, seed: opts.seed ?? BASE_SEED });
  const { items, malformed } = parseDetection(raw);
  const r = toFindings(items, chunk, standards, opts);
  r.dropped.malformed += malformed;
  return r;
}

// ---------------------------------------------------------------------------------------------
// As a Detector, for the eval endpoint and tests. The Workflow runs the same pieces as steps.

export interface LlmDetectorOptions extends DetectOptions {
  /** Attempts per chunk (the Workflow has its own retries; this is for synchronous use). */
  attempts?: number;
  /**
   * Called before every model call, retries included. Returning false means the budget is used up:
   * no call is made, and this chunk and every later one become coverage gaps.
   */
  reserve?: () => Promise<boolean>;
  onChunk?: (label: string, outcome: "ok" | "failed" | "skipped", detail: string) => void;
  /**
   * Files the model isn't asked about (the Action leaves out lock files and generated output).
   * Not a coverage gap: no standard is meant for them, and the rules still see them.
   */
  skipPath?: (path: string) => boolean;
}

export function llmDetector(client: LlmClient, opts: LlmDetectorOptions = {}): Detector {
  return {
    name: `llm(${PROMPT_VERSION})`,
    async detect(input: ParsedInput, enabled: Standard[]) {
      const standards = llmStandards(enabled);
      if (standards.length === 0) return { findings: [] };
      const skipPath = opts.skipPath;
      const plan = planChunks(skipPath ? { ...input, files: input.files.filter((f) => !skipPath(f.path)) } : input);
      const findings: Finding[] = [];
      const skipped = [...plan.skipped];
      let budgetOut = false;
      for (const chunk of plan.chunks) {
        const label = chunkLabel(chunk);
        let lastError = "";
        let done = false;
        for (let attempt = 1; attempt <= (opts.attempts ?? 2) && !done && !budgetOut; attempt++) {
          if (opts.reserve && !(await opts.reserve())) {
            budgetOut = true;
            break;
          }
          try {
            const r = await detectChunk(client, chunk, standards, { ...opts, seed: seedFor(attempt) });
            findings.push(...r.findings);
            opts.onChunk?.(label, "ok", describeDrops(r));
            done = true;
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            // A provider error a retry can't fix (bad key, unknown model): don't spend another call.
            if ((e as { retryable?: unknown })?.retryable === false) break;
          }
        }
        if (done) continue;
        if (budgetOut) {
          skipped.push({ file: label, reason: BUDGET_REASON });
          opts.onChunk?.(label, "skipped", BUDGET_REASON);
        } else {
          skipped.push({ file: label, reason: `AI review failed: ${lastError}` });
          opts.onChunk?.(label, "failed", lastError);
        }
      }
      return { findings, skipped };
    },
  };
}

export function describeDrops(r: ChunkResult): string {
  const d = r.dropped;
  const parts = [`${r.findings.length} finding(s)`];
  if (d.notInInput) parts.push(`dropped ${d.notInInput}: evidence not found in the input`);
  if (d.unknownStandard) parts.push(`dropped ${d.unknownStandard}: not a listed standard`);
  if (d.malformed) parts.push(`dropped ${d.malformed}: malformed`);
  if (d.placeholder) parts.push(`dropped ${d.placeholder}: placeholder value, not a secret`);
  return parts.join("; ");
}
