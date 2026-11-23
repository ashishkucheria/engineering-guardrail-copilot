// Eval runner: `npm run eval -- --config rules [--save] [--strict]`
//
// Runs every case in eval/cases through the same review() the Worker uses, scores the result
// against the labels, prints a table, and with --save writes eval/results/<date>-<config>.json.
// --strict exits non-zero on any false positive, miss or must_not_flag failure (used in CI for the
// deterministic rules config; LLM configs are compared on scores instead).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { review } from "../core/engine.ts";
import { loadStandards } from "../scripts/load-standards.ts";
import { CONFIGS } from "./configs.ts";
import { scoreCase, summarize, type CaseScore, type EvalCase, type Metrics } from "./score.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "rules" },
    case: { type: "string" },
    save: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
  },
});

const config = CONFIGS[values.config!];
if (!config) {
  console.error(`Unknown config "${values.config}". Available: ${Object.keys(CONFIGS).join(", ")}`);
  process.exit(2);
}

const casesDir = fileURLToPath(new URL("./cases/", import.meta.url));
const cases: EvalCase[] = readdirSync(casesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => validateCase(JSON.parse(readFileSync(join(casesDir, f), "utf8")), f))
  .filter((c) => !values.case || c.id === values.case);

const standards = await loadStandards();
const inScope = config.scope(standards);

const scores: CaseScore[] = [];
const started = Date.now();
for (const c of cases) {
  const r = await review(c.input, standards, config.detectors);
  const s = scoreCase(c, r.findings, inScope);
  scores.push(s);
  const mark = s.fp === 0 && s.fn === 0 && s.mustNotFlagViolated.length === 0 ? "ok  " : "MISS";
  console.log(`${mark} ${c.id.padEnd(36)} tp=${s.tp} fp=${s.fp} fn=${s.fn}${s.suggestions ? ` suggestions=${s.suggestions}` : ""}`);
  for (const fp of s.falsePositives) console.log(`       false positive ${fp.standardId} ${fp.file}:${fp.lineStart}  ${fp.evidence}`);
  for (const m of s.missed) console.log(`       missed         ${m.standard_id} lines ${m.lines.join("-")}`);
}

const summary = summarize(cases, scores, inScope);
const pct = (v: number | null) => (v === null ? "  n/a" : `${(v * 100).toFixed(0).padStart(4)}%`);
const row = (label: string, m: Metrics) => `${label.padEnd(10)} ${String(m.tp).padStart(3)} ${String(m.fp).padStart(3)} ${String(m.fn).padStart(3)}  ${pct(m.precision)} ${pct(m.recall)} ${pct(m.f1)}`;

console.log(`\nConfig: ${config.name} (${config.description})  cases: ${cases.length}  scored standards: ${[...inScope].join(", ")}`);
console.log(`${"standard".padEnd(10)}  tp  fp  fn  precision recall   f1`);
for (const [id, m] of Object.entries(summary.byStandard)) console.log(row(id, m));
console.log(row("OVERALL", summary.overall));
console.log(`Clean cases with a false positive: ${summary.cleanCases.withFalsePositive}/${summary.cleanCases.total}`);
if (summary.mustNotFlagFailures.length) console.log(`must_not_flag failures: ${JSON.stringify(summary.mustNotFlagFailures)}`);
console.log(`Took ${Date.now() - started} ms`);

if (values.save) {
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${config.name}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        config: config.name,
        description: config.description,
        ranAt: new Date().toISOString(),
        standards: standards.map((s) => ({ id: s.id, contentHash: s.contentHash })),
        summary,
        cases: scores,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Saved ${file}`);
}

if (values.strict && (summary.overall.fp > 0 || summary.overall.fn > 0 || summary.mustNotFlagFailures.length > 0)) {
  console.error("Strict mode: the eval has false positives, misses or must_not_flag failures.");
  process.exit(1);
}

function validateCase(raw: unknown, file: string): EvalCase {
  const c = raw as EvalCase;
  const fail = (msg: string) => {
    throw new Error(`eval/cases/${file}: ${msg}`);
  };
  if (!c || typeof c !== "object") fail("not an object");
  if (`${c.id}.json` !== file) fail(`id "${c.id}" must match the file name`);
  if (typeof c.input !== "string" || !c.input.trim()) fail("input must be a non-empty string");
  if (!Array.isArray(c.expected)) fail("expected must be an array");
  for (const e of c.expected) {
    if (typeof e.standard_id !== "string" || !Array.isArray(e.lines) || e.lines.length !== 2) fail(`bad expected entry ${JSON.stringify(e)}`);
  }
  return c;
}
