import { redact } from "./util.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const LEVEL: LogLevel = (process.env["SDV_LOG_LEVEL"] as LogLevel) ?? "info";
const QUIET = process.env["SDV_LOG_QUIET"] === "1";

export function createLogger(scope = "sdv"): Logger {
  const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (QUIET && ORDER[level] < ORDER["warn"]) return;
    if (ORDER[level] < ORDER[LEVEL]) return;
    const time = new Date().toISOString().slice(11, 19);
    const tail = meta && Object.keys(meta).length ? ` ${redact(JSON.stringify(meta))}` : "";
    const line = `${time} ${level.padEnd(5)} [${scope}] ${redact(msg)}${tail}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };

  return {
    debug: (m, x) => emit("debug", m, x),
    info: (m, x) => emit("info", m, x),
    warn: (m, x) => emit("warn", m, x),
    error: (m, x) => emit("error", m, x),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
