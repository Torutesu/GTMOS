#!/usr/bin/env tsx
import { createRuntime } from "./runtime.ts";
import { startServer } from "./server.ts";

const noWorker = process.argv.includes("--no-worker");

const rt = await createRuntime();
const server = await startServer(rt, { worker: !noWorker });

console.log(`Superdemovideo API on ${server.url}  (llm: ${rt.cfg.llmMode})`);
if (!rt.cfg.token) console.log("No SDV_TOKEN set — running without authentication.");

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log("\nshutting down…");
    server
      .close()
      .then(() => rt.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
