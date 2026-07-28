import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "@sdv/core";
import { createProject, createRun, migrate, openDb } from "@sdv/db";
import { createMockLlm } from "@sdv/llm";
import { createSandbox, createStorage, ingest, type StageContext } from "@sdv/pipeline";

let varDir = "";
let src = "";

afterEach(async () => {
  for (const d of [varDir, src]) if (d) await rm(d, { recursive: true, force: true });
  varDir = "";
  src = "";
});

async function ingestOf(files: Record<string, string>): Promise<string> {
  src = await mkdtemp(join(tmpdir(), "sdv-src-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(src, path, ".."), { recursive: true });
    await writeFile(join(src, path), content);
  }
  varDir = await mkdtemp(join(tmpdir(), "sdv-var-"));
  const cfg = loadConfig({ varDir, llmMode: "mock" });
  await mkdir(cfg.storageDir, { recursive: true });
  const db = await openDb({ databaseUrl: null, dbDir: cfg.dbDir });
  await migrate(db);
  try {
    const project = await createProject(db, { name: "t", sourceKind: "local", sourceUrl: src });
    const run = await createRun(db, { projectId: project.id, kind: "initial" });
    const ctx: StageContext = {
      cfg,
      db,
      storage: createStorage({ driver: "fs", root: cfg.storageDir }),
      sandbox: createSandbox("local"),
      llm: createMockLlm(),
      log: createLogger("test"),
      runId: run.id,
      projectId: project.id,
      workDir: join(cfg.workDir, run.id),
      progress: () => {},
    };
    await mkdir(ctx.workDir, { recursive: true });
    const result = await ingest(ctx);
    return result.srcDir;
  } finally {
    await db.close();
  }
}

/**
 * What counts as generated output.
 *
 * reveal.js keeps `build/dts-paths.ts` in version control and its vite config
 * imports it. Dropping the directory because of its name left a config that
 * could not load and a dev server that never came up — a failure that looked
 * like the repository's and was entirely ours.
 */
describe("deciding what not to copy", () => {
  it("keeps a source directory that happens to be called build", async () => {
    const out = await ingestOf({
      "package.json": "{}",
      ".gitignore": "node_modules/\ndist/reveal.es5.js\n",
      "build/dts-paths.ts": "export const x = 1;",
      "src/main.ts": "",
    });
    expect(existsSync(join(out, "build", "dts-paths.ts"))).toBe(true);
  }, 60_000);

  it("drops one the repository says is generated", async () => {
    const out = await ingestOf({
      "package.json": "{}",
      ".gitignore": "node_modules/\ndist/\nbuild\n",
      "build/app.js": "generated",
      "dist/app.js": "generated",
      "src/main.ts": "",
    });
    expect(existsSync(join(out, "build"))).toBe(false);
    expect(existsSync(join(out, "dist"))).toBe(false);
    expect(existsSync(join(out, "src", "main.ts"))).toBe(true);
  }, 60_000);

  it("always drops node_modules, whatever the ignore file says", async () => {
    const out = await ingestOf({
      "package.json": "{}",
      ".gitignore": "# nothing ignored\n",
      "node_modules/left-pad/index.js": "",
      "src/main.ts": "",
    });
    expect(existsSync(join(out, "node_modules"))).toBe(false);
  }, 60_000);

  it("falls back to convention when there is no ignore file to consult", async () => {
    const out = await ingestOf({ "package.json": "{}", "dist/app.js": "", "src/main.ts": "" });
    expect(existsSync(join(out, "dist"))).toBe(false);
    expect(existsSync(join(out, "src", "main.ts"))).toBe(true);
  }, 60_000);
});
