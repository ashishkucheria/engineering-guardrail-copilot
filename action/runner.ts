// The small part of the Actions runner protocol the Action uses: inputs from INPUT_* variables,
// outputs through the GITHUB_OUTPUT file, log commands, masking, and the job summary. Written by
// hand instead of pulling in @actions/core, so the bundle holds only what runs. All of it takes the
// environment as a parameter, so tests don't touch process.env.
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type Env = Record<string, string | undefined>;

/** Value of an input, trimmed; "" when it isn't set. */
export function getInput(name: string, env: Env = process.env): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

export class InputError extends Error {
  override name = "InputError";
}

export function getBoolean(name: string, fallback: boolean, env: Env = process.env): boolean {
  const v = getInput(name, env).toLowerCase();
  if (v === "") return fallback;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new InputError(`input ${name} must be true or false, not "${v}"`);
}

export function getPositiveInt(name: string, fallback: number, env: Env = process.env): number {
  const v = getInput(name, env);
  if (v === "") return fallback;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new InputError(`input ${name} must be a positive whole number, not "${v}"`);
  return Number(v);
}

export function getChoice<T extends string>(name: string, choices: readonly T[], fallback: T, env: Env = process.env): T {
  const v = getInput(name, env);
  if (v === "") return fallback;
  if (!(choices as readonly string[]).includes(v)) throw new InputError(`input ${name} must be one of ${choices.join(", ")}, not "${v}"`);
  return v as T;
}

/** Workflow commands carry their message on one line, so `%` and line breaks are escaped. */
function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Hide a value in all later log output. Must run before the value could be printed. */
export function mask(value: string | undefined): void {
  if (value) console.log(`::add-mask::${escapeData(value)}`);
}
export const warning = (msg: string) => console.log(`::warning::${escapeData(msg)}`);
export const error = (msg: string) => console.log(`::error::${escapeData(msg)}`);
export const info = (msg: string) => console.log(msg);

export function setOutput(name: string, value: string, env: Env = process.env): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) return console.log(`${name}=${value}`); // running outside Actions
  const delimiter = `guardrail_${randomBytes(8).toString("hex")}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Append Markdown to the job summary; no-op outside Actions. */
export function appendJobSummary(markdown: string, env: Env = process.env): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
