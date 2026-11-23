import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    // The AI binding always runs remotely, which needs Cloudflare credentials. CI runs the fake
    // model with LOCAL_ONLY=1, so it needs no account and makes no AI calls.
    cloudflare({ remoteBindings: process.env.LOCAL_ONLY !== "1" }),
  ],
});
