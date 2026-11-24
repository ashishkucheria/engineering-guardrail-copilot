// Eval configurations. Each one names the detectors to run and therefore which standards it can be
// scored on. The cases, scorer and runner are the same for every configuration.
import { readFileSync } from "node:fs";
import { ruleDetector, type Detector } from "../core/engine.ts";
import { PROMPT_VERSION } from "../core/prompts.ts";
import { RULES } from "../core/rules.ts";
import { usesRule } from "../core/standards.ts";
import type { Finding, Standard } from "../core/types.ts";

export interface RunOptions {
  /** Base URL of a running app (`npm run dev` or a deployment), for configs that use the model. */
  target: string;
}

export interface EvalConfig {
  name: string;
  description: string;
  detectors(opts: RunOptions): Detector[];
  /** The standards this configuration is able to detect; only these are scored. */
  scope(standards: Standard[]): Set<string>;
}

export const CONFIGS: Record<string, EvalConfig> = {
  rules: {
    name: "rules",
    description: "Deterministic rule detectors only (no LLM).",
    detectors: () => [ruleDetector],
    scope: (standards) => new Set(standards.filter((s) => usesRule(s) && RULES[s.id]).map((s) => s.id)),
  },
  llm: {
    name: "llm",
    description: `Rules + Llama 3.3 70B, prompt ${PROMPT_VERSION}, evidence verification on (the app's configuration).`,
    detectors: (opts) => [ruleDetector, remoteLlmDetector(opts.target)],
    scope: (standards) => new Set(standards.map((s) => s.id)),
  },
};

/** Thrown when the run can't continue (budget used up, bad token): the runner stops instead of scoring. */
export class EvalAbort extends Error {}

/**
 * Runs the app's AI detector through POST /api/eval/detect, so the eval exercises the deployed code
 * and the real model. Locally and deployed alike, Workers AI runs remotely.
 */
export function remoteLlmDetector(target: string): Detector {
  const token = evalToken();
  return {
    name: "llm(remote)",
    async detect(_input, _enabled, raw) {
      const res = await fetch(`${target.replace(/\/$/, "")}/api/eval/detect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ input: raw }),
      });
      const data = (await res.json().catch(() => null)) as { findings?: Finding[]; skipped?: { file: string; reason: string }[]; error?: { message: string } } | null;
      if (res.status === 429 || res.status === 404 || res.status === 503) throw new EvalAbort(`${res.status} from ${target}: ${data?.error?.message ?? "no details"}`);
      if (!res.ok || !data?.findings) throw new Error(`eval endpoint returned ${res.status}: ${data?.error?.message ?? "no details"}`);
      return { findings: data.findings, skipped: data.skipped };
    },
  };
}

/** EVAL_TOKEN from the environment, or from .dev.vars when running against `npm run dev`. */
function evalToken(): string {
  if (process.env.EVAL_TOKEN) return process.env.EVAL_TOKEN;
  try {
    const m = /^EVAL_TOKEN=(.+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"));
    if (m) return m[1]!.trim();
  } catch {
    // no .dev.vars
  }
  throw new EvalAbort("Set EVAL_TOKEN (or put it in .dev.vars) to run a configuration that uses the model.");
}
