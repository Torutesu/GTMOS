import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, loadConfig, type Logger, type SdvConfig } from "@sdv/core";
import { migrate, openDb, type Db } from "@sdv/db";
import { createLlm, type LlmClient } from "@sdv/llm";
import {
  TEMPLATES_DIR,
  createSandbox,
  createStorage,
  makeLogger,
  type ProgressFn,
  type Sandbox,
  type StageContext,
  type Storage,
} from "@sdv/pipeline";

/**
 * Everything a run needs, assembled once.
 *
 * The API process and the CLI both build one of these; the worker then hands
 * each job a per-run view of it. Nothing here is per-request, so a run's
 * context is cheap to make and the expensive handles (database, browser
 * sandbox) are opened exactly once.
 */
export interface Runtime {
  cfg: SdvConfig;
  db: Db;
  storage: Storage;
  sandbox: Sandbox;
  llm: LlmClient;
  log: Logger;
  close(): Promise<void>;
}

export async function createRuntime(overrides: Partial<SdvConfig> = {}): Promise<Runtime> {
  const cfg = loadConfig(overrides);
  for (const dir of [cfg.varDir, cfg.workDir, cfg.storageDir, cfg.dbDir]) {
    await mkdir(dir, { recursive: true });
  }

  const db = await openDb({ databaseUrl: cfg.databaseUrl, dbDir: cfg.dbDir });
  await migrate(db);

  const storage = createStorage({ driver: cfg.storageDriver, root: cfg.storageDir });
  const sandbox = createSandbox(cfg.sandboxDriver);
  const llm = createLlm(cfg, TEMPLATES_DIR);

  return {
    cfg,
    db,
    storage,
    sandbox,
    llm,
    log: createLogger("sdv"),
    async close() {
      await db.close();
    },
  };
}

export function runContext(
  rt: Runtime,
  args: { runId: string; projectId: string; progress?: ProgressFn },
): StageContext {
  return {
    cfg: rt.cfg,
    db: rt.db,
    storage: rt.storage,
    sandbox: rt.sandbox,
    llm: rt.llm,
    log: makeLogger(args.runId),
    runId: args.runId,
    projectId: args.projectId,
    workDir: join(rt.cfg.workDir, args.runId),
    progress: args.progress ?? (() => {}),
  };
}
