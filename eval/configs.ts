// Eval configurations. Each one names the detectors to run and therefore which standards it can be
// scored on. PR 3-B adds LLM configurations (prompt version × model × verification) here; the
// cases, scorer and runner stay the same.
import { usesRule } from "../core/standards.ts";
import { RULES } from "../core/rules.ts";
import { ruleDetector, type Detector } from "../core/engine.ts";
import type { Standard } from "../core/types.ts";

export interface EvalConfig {
  name: string;
  description: string;
  detectors: Detector[];
  /** The standards this configuration is able to detect; only these are scored. */
  scope(standards: Standard[]): Set<string>;
}

export const CONFIGS: Record<string, EvalConfig> = {
  rules: {
    name: "rules",
    description: "Deterministic rule detectors only (no LLM).",
    detectors: [ruleDetector],
    scope: (standards) => new Set(standards.filter((s) => usesRule(s) && RULES[s.id]).map((s) => s.id)),
  },
};
