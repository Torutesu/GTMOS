import { resolve } from "node:path";

export type LlmMode = "mock" | "live";

export interface SdvConfig {
  varDir: string;
  workDir: string;
  storageDir: string;
  dbDir: string;
  llmMode: LlmMode;
  anthropicApiKey: string | null;
  databaseUrl: string | null;
  storageDriver: "fs" | "s3";
  sandboxDriver: "local" | "docker";
  port: number;
  token: string | null;
  chromiumPath: string | null;
}

function envStr(key: string): string | null {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : null;
}

export function loadConfig(overrides: Partial<SdvConfig> = {}): SdvConfig {
  const varDir = resolve(overrides.varDir ?? envStr("SDV_VAR_DIR") ?? "./var");
  const llmMode = (envStr("SDV_LLM_MODE") ?? "mock") as LlmMode;

  return {
    varDir,
    workDir: resolve(varDir, "work"),
    storageDir: resolve(varDir, "storage"),
    dbDir: resolve(varDir, "db"),
    llmMode: llmMode === "live" ? "live" : "mock",
    anthropicApiKey: envStr("ANTHROPIC_API_KEY"),
    databaseUrl: envStr("DATABASE_URL"),
    storageDriver: envStr("SDV_STORAGE_DRIVER") === "s3" ? "s3" : "fs",
    sandboxDriver: envStr("SDV_SANDBOX_DRIVER") === "docker" ? "docker" : "local",
    port: Number(envStr("SDV_PORT") ?? 3000),
    token: envStr("SDV_TOKEN"),
    chromiumPath: envStr("SDV_CHROMIUM_PATH"),
    ...overrides,
  };
}

/**
 * Resolve the Chromium binary for capture.
 *
 * M1 never downloads a browser: it uses the one already on the machine.
 * Explicit path wins, then PLAYWRIGHT_BROWSERS_PATH, then playwright-core's
 * own resolution (which we let throw if nothing is installed).
 */
export function resolveChromiumPath(cfg: SdvConfig): string | undefined {
  if (cfg.chromiumPath) return cfg.chromiumPath;
  const root = envStr("PLAYWRIGHT_BROWSERS_PATH");
  if (!root) return undefined;
  return undefined; // caller scans `root`; see pipeline/capture for the scan
}
