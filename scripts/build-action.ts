// Bundle the Action into dist/action/index.cjs. The bundle is committed (Actions run it straight
// from the tag), and CI rebuilds it and fails if the committed copy is out of date.
import { build } from "esbuild";
import { readBuiltinStandardFiles } from "./builtin-standards.ts";

await build({
  entryPoints: ["action/main.ts"],
  outfile: "dist/action/index.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  legalComments: "none",
  logLevel: "warning",
  define: { __BUILTIN_STANDARDS__: JSON.stringify(readBuiltinStandardFiles()) },
});
console.log("Built dist/action/index.cjs");
