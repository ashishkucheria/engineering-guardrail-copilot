// Node-only helper: read standards/*.yaml into validated, hashed Standard objects.
// Used by the seed script and the eval runner, so both see exactly what the database gets.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { contentHash, parseStandard } from "../core/standards.ts";
import type { Standard } from "../core/types.ts";

export const STANDARDS_DIR = fileURLToPath(new URL("../standards/", import.meta.url));

export async function loadStandards(dir: string = STANDARDS_DIR): Promise<Standard[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  if (files.length === 0) throw new Error(`no standards found in ${dir}`);
  const out: Standard[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const content = parseStandard(parse(readFileSync(join(dir, f), "utf8")), f);
    if (`${content.id}.yaml` !== f) throw new Error(`${f}: file name must match id ${content.id}`);
    if (seen.has(content.id)) throw new Error(`duplicate standard id ${content.id}`);
    seen.add(content.id);
    out.push({ ...content, contentHash: await contentHash(content), enabled: true });
  }
  return out;
}
