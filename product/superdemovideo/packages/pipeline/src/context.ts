import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createLogger,
  loadConfig,
  type Logger,
  type SdvConfig,
  type Stage,
} from "@sdv/core";
import type { Db } from "@sdv/db";
import type { LlmClient } from "@sdv/llm";
import type { Sandbox } from "./sandbox.ts";
import type { Storage } from "./storage.ts";

export type ProgressFn = (event: {
  stage: Stage | "run";
  status: string;
  message: string;
}) => void;

export interface StageContext {
  cfg: SdvConfig;
  db: Db;
  storage: Storage;
  sandbox: Sandbox;
  llm: LlmClient;
  log: Logger;
  runId: string;
  projectId: string;
  /** Scratch directory for this run. Never written to outside var/. */
  workDir: string;
  progress: ProgressFn;
}

export function stagePaths(workDir: string) {
  return {
    src: join(workDir, "src"),
    app: join(workDir, "app"),
    logs: join(workDir, "logs"),
    capture: join(workDir, "capture"),
    frames: join(workDir, "frames"),
    out: join(workDir, "out"),
  };
}

export async function ensureWorkDirs(workDir: string): Promise<void> {
  const p = stagePaths(workDir);
  for (const dir of Object.values(p)) await mkdir(dir, { recursive: true });
}

export function defaultConfig(overrides: Partial<SdvConfig> = {}): SdvConfig {
  return loadConfig(overrides);
}

export function makeLogger(runId: string): Logger {
  return createLogger(`run:${runId.slice(-6)}`);
}
