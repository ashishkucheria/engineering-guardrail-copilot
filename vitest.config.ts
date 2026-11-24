// Unit tests cover the pure modules in core/ and eval/. They deliberately don't load the Cloudflare
// Vite plugin, so they run in plain Node with no Worker runtime and no network.
import { defineConfig } from "vitest/config";
import { readBuiltinStandardFiles } from "./scripts/builtin-standards.ts";

export default defineConfig({
  define: { __BUILTIN_STANDARDS__: JSON.stringify(readBuiltinStandardFiles()) },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
