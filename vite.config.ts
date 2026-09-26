import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import { VANTAGES, vantageWorkerName } from "./src/probe/vantages";

// One Worker per vantage point, each placed near its cloud region and
// reachable only through the status Worker's service bindings.
const vantages = VANTAGES.map((vantage) => ({
  config: {
    name: vantageWorkerName(vantage),
    main: "./src/vantage/worker.ts",
    // Keep in sync with the status Worker's compatibility_date in wrangler.jsonc.
    compatibility_date: "2026-09-13",
    workers_dev: false,
    preview_urls: false,
    placement: { region: vantage.placement },
    vars: { VANTAGE: vantage.code },
  },
}));

export default defineConfig({
  plugins: process.env.VITEST ? [] : [cloudflare({ auxiliaryWorkers: vantages })],
  css: { transformer: "lightningcss" },
  build: { cssMinify: "lightningcss" },
  // Reachable over the tailnet during development.
  server: { host: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    alias: { "cloudflare:workers": join(dirname(fileURLToPath(import.meta.url)), "src/testing/cloudflare-workers.ts") },
  },
  fmt: {
    printWidth: 120,
    // Template whitespace is rendered output, so html`` stays as written.
    embeddedLanguageFormatting: "off",
    // Human-owned rule files.
    ignorePatterns: ["AGENTS.md", "CLAUDE.md"],
  },
});
