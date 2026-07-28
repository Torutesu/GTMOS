#!/usr/bin/env tsx
/**
 * Bundle the demo player.
 *
 * The size limit is a product constraint, not a preference: the player is
 * embedded on other people's landing pages, and a heavy embed is one the
 * customer eventually removes. Exceeding the budget fails the build.
 */
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "dist");
const OUT = join(OUT_DIR, "player.js");
const BUDGET_BYTES = 50 * 1024;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  await build({
    entryPoints: [join(HERE, "src", "player.ts")],
    bundle: true,
    format: "iife",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    outfile: OUT,
  });

  const code = await readFile(OUT);
  const gzipped = gzipSync(code).byteLength;
  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;

  console.log(`player.js  ${kb(code.byteLength)} raw  ${kb(gzipped)} gzip  (budget ${kb(BUDGET_BYTES)})`);
  await writeFile(join(OUT_DIR, "size.json"), JSON.stringify({ raw: code.byteLength, gzip: gzipped }));

  if (gzipped > BUDGET_BYTES) {
    console.error(`\nThe player is over budget by ${kb(gzipped - BUDGET_BYTES)}.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
