import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: process.env.VITEST ? [] : [cloudflare()],
  css: { transformer: "lightningcss" },
  build: { cssMinify: "lightningcss" },
  // Reachable over the tailnet during development.
  server: { host: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: {
      "cloudflare:workers": join(root, "src/testing/cloudflare-workers.ts"),
    },
  },
  fmt: {
    printWidth: 120,
    // Template whitespace is rendered output, so html`` stays as written.
    embeddedLanguageFormatting: "off",
    // Human-owned rule files.
    ignorePatterns: ["AGENTS.md", "CLAUDE.md"],
  },
});
