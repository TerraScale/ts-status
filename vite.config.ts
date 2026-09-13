import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext(), ...(process.env.VITEST ? [] : [cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })])],
  resolve: { dedupe: ["react", "react-dom"] },
  test: { environment: "node", include: ["**/*.test.ts", "**/*.test.tsx"], exclude: ["node_modules/**", ".vinext/**", "dist/**"] },
});
