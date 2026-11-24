// Node-only helper: read standards/*.yaml into validated, hashed Standard objects.
// Used by the seed script and the eval runner, so both see exactly what the database gets.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStandardFiles } from "../core/standards-yaml.ts";
import type { Standard } from "../core/types.ts";

export const STANDARDS_DIR = fileURLToPath(new URL("../standards/", import.meta.url));

export async function loadStandards(dir: string = STANDARDS_DIR): Promise<Standard[]> {
  const names = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  if (names.length === 0) throw new Error(`no standards found in ${dir}`);
  return parseStandardFiles(names.map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })));
}
