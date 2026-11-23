import type { DetectorKind, Severity, Standard, StandardContent, StandardSnapshot } from "./types.ts";

const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor"];
const DETECTORS: readonly DetectorKind[] = ["rule", "llm", "rule+llm"];
const ID_PATTERN = /^[A-Z]{2,5}-\d{3}$/;

/**
 * Validate one parsed standard file. Throws with the file's id and the problem, so a bad YAML edit
 * fails the seed loudly instead of reaching the database.
 */
export function parseStandard(raw: unknown, source = "standard"): StandardContent {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: not an object`);
  const o = raw as Record<string, unknown>;
  const str = (key: string, required: boolean): string | undefined => {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) throw new Error(`${source}: missing "${key}"`);
      return undefined;
    }
    if (typeof v !== "string" || v.trim() === "") throw new Error(`${source}: "${key}" must be a non-empty string`);
    return v.trim();
  };
  const id = str("id", true)!;
  if (!ID_PATTERN.test(id)) throw new Error(`${source}: id "${id}" must look like ABC-123`);
  const severity = str("severity", true) as Severity;
  if (!SEVERITIES.includes(severity)) throw new Error(`${id}: severity must be one of ${SEVERITIES.join(", ")}`);
  const detector = str("detector", true) as DetectorKind;
  if (!DETECTORS.includes(detector)) throw new Error(`${id}: detector must be one of ${DETECTORS.join(", ")}`);
  const known = new Set(["id", "title", "severity", "detector", "rule", "compliant", "violating"]);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`${id}: unknown field(s) ${unknown.join(", ")}`);
  return {
    id,
    title: str("title", true)!,
    severity,
    detector,
    rule: str("rule", true)!,
    compliant: str("compliant", false),
    violating: str("violating", false),
  };
}

/**
 * Content hash of a standard: SHA-256 over its content fields in a fixed order. `enabled` is not
 * content, so toggling a standard never creates a new version.
 */
export async function contentHash(s: StandardContent): Promise<string> {
  const canonical = JSON.stringify([s.id, s.title, s.severity, s.detector, s.rule, s.compliant ?? null, s.violating ?? null]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function snapshotOf(all: Standard[]): StandardSnapshot[] {
  return all
    .map((s) => ({ id: s.id, contentHash: s.contentHash, severity: s.severity, enabled: s.enabled }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function usesRule(s: Pick<StandardContent, "detector">): boolean {
  return s.detector === "rule" || s.detector === "rule+llm";
}

export function usesLlm(s: Pick<StandardContent, "detector">): boolean {
  return s.detector === "llm" || s.detector === "rule+llm";
}
