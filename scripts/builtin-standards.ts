// Node-only: the files in standards/, as {name, text}, for the Action's built-in set. The bundle gets
// them through a compile-time define, so the Action needs no files next to it at run time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../standards/", import.meta.url));

export function readBuiltinStandardFiles(): { name: string; text: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8").replace(/\r\n/g, "\n") }));
}
