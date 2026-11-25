import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    // No remote bindings: D1, the Workflow and the rate limits all run locally, so local dev and CI
    // need no Cloudflare account. The AI provider is reached over HTTPS (worker/ai.ts).
    cloudflare({ remoteBindings: false }),
  ],
});
