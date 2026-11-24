// Where the Action's standards come from (design D2): the reviewed repository's own folder at the
// PR's base commit, or the built-in set when the repository has none.
import { parseStandardFiles, type StandardFile } from "../core/standards-yaml.ts";
import type { Standard } from "../core/types.ts";
import type { GitHubClient } from "./github.ts";

/** Safety limits on a repository-supplied folder. */
export const MAX_STANDARD_FILES = 100;
export const MAX_STANDARD_BYTES = 50_000;

export interface LoadedStandards {
  standards: Standard[];
  source: "repository" | "built-in";
}

/**
 * Read `.guardrail/standards` (or the configured folder) at `baseSha`, never the PR head: a PR must
 * not be able to switch off the standard it breaks in the same change. A missing folder means the
 * built-in standards. A folder that exists but is invalid throws, naming the file; a broken standard
 * is never skipped quietly.
 */
export async function loadStandards(gh: Pick<GitHubClient, "listDirectory" | "getFileText">, path: string, baseSha: string): Promise<LoadedStandards> {
  const entries = await gh.listDirectory(path, baseSha);
  if (entries === null) {
    return { standards: await parseStandardFiles(__BUILTIN_STANDARDS__), source: "built-in" };
  }
  const names = entries.filter((e) => e.type === "file" && e.name.endsWith(".yaml")).map((e) => e.name);
  if (names.length === 0) throw new Error(`${path} exists at the base commit but has no .yaml standards; remove the folder to use the built-in standards`);
  if (names.length > MAX_STANDARD_FILES) throw new Error(`${path} has ${names.length} standards; the limit is ${MAX_STANDARD_FILES}`);
  const files: StandardFile[] = [];
  for (const name of names) {
    const text = await gh.getFileText(`${path}/${name}`, baseSha);
    if (new TextEncoder().encode(text).byteLength > MAX_STANDARD_BYTES) throw new Error(`${path}/${name} is over the ${MAX_STANDARD_BYTES / 1000} KB limit`);
    files.push({ name, text });
  }
  return { standards: await parseStandardFiles(files), source: "repository" };
}
