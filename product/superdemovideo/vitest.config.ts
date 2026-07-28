import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@sdv/core": r("./packages/core/src/index.ts"),
      "@sdv/db": r("./packages/db/src/index.ts"),
      "@sdv/llm": r("./packages/llm/src/index.ts"),
      "@sdv/pipeline": r("./packages/pipeline/src/index.ts"),
    },
  },
});
