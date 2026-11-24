// Standards from YAML text, with no file system: the seed script reads standards/ from disk, and
// the Action reads .guardrail/standards/ from the GitHub API at the base commit. Both pass the
// files' names and text here, so both apply the same validation.
import { parse } from "yaml";
import { contentHash, parseStandard } from "./standards.ts";
import type { Standard } from "./types.ts";

export interface StandardFile {
  /** File name only, e.g. "SEC-001.yaml". */
  name: string;
  text: string;
}

/** Validate and hash every `.yaml` file. Any problem throws, naming the file: a broken standard is never skipped. */
export async function parseStandardFiles(files: StandardFile[]): Promise<Standard[]> {
  const yamlFiles = files.filter((f) => f.name.endsWith(".yaml")).sort((a, b) => a.name.localeCompare(b.name));
  if (yamlFiles.length === 0) throw new Error("no standards found (.yaml files)");
  const out: Standard[] = [];
  const seen = new Set<string>();
  for (const f of yamlFiles) {
    let raw: unknown;
    try {
      raw = parse(f.text);
    } catch (e) {
      throw new Error(`${f.name}: invalid YAML (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    }
    const content = parseStandard(raw, f.name);
    if (`${content.id}.yaml` !== f.name) throw new Error(`${f.name}: file name must match id ${content.id}`);
    if (seen.has(content.id)) throw new Error(`duplicate standard id ${content.id}`);
    seen.add(content.id);
    out.push({ ...content, contentHash: await contentHash(content), enabled: true });
  }
  return out;
}
