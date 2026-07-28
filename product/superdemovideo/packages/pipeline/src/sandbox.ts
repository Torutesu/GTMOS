import { spawn } from "node:child_process";
import { SdvError, redact, tailLines, type ErrorCode } from "@sdv/core";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  timedOut: boolean;
}

export interface SandboxOptions {
  cwd: string;
  /** Extra variables layered onto the minimal base environment. */
  env?: Record<string, string>;
  timeoutMs: number;
  onLine?: (line: string) => void;
}

/**
 * Runs untrusted repository commands.
 *
 * The local driver isolates by construction rather than by kernel: a scratch
 * working copy, a scrubbed environment, and a hard timeout. It does NOT
 * contain a hostile repository — install and build scripts run as this user.
 * Use it for code you already trust; the docker driver is what makes arbitrary
 * repositories safe, and it is the deployment path, not the M1 path.
 */
export interface Sandbox {
  readonly kind: "local" | "docker";
  exec(command: string, opts: SandboxOptions): Promise<RunResult>;
  /** Start a long-running process (a dev/preview server) and leave it running. */
  start(command: string, opts: Omit<SandboxOptions, "timeoutMs">): StartedProcess;
}

export interface StartedProcess {
  pid: number | undefined;
  output(): string;
  stop(): Promise<void>;
  exited: Promise<number | null>;
}

/**
 * The base environment handed to repository commands.
 *
 * Nothing from the host leaks in except what a Node build genuinely needs.
 * In particular no API keys, no cloud credentials, no SDV_* configuration —
 * an install script cannot read what was never put in its environment.
 */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const passthrough = ["PATH", "HOME", "LANG", "TZ", "SHELL", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const key of passthrough) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return {
    ...env,
    NODE_ENV: "production",
    CI: "1",
    // Package installs must never try to fetch a browser: capture uses the
    // one already on the machine.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PUPPETEER_SKIP_DOWNLOAD: "1",
    ADBLOCK: "1",
    DISABLE_OPENCOLLECTIVE: "1",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
    ...extra,
  };
}

export function createSandbox(kind: "local" | "docker"): Sandbox {
  if (kind === "docker") {
    throw new Error(
      "The docker sandbox driver is not implemented in M1. Use SDV_SANDBOX_DRIVER=local.",
    );
  }
  return localSandbox();
}

function localSandbox(): Sandbox {
  return {
    kind: "local",

    exec(command, opts) {
      return new Promise<RunResult>((resolve) => {
        const child = spawn(command, {
          cwd: opts.cwd,
          env: baseEnv(opts.env),
          shell: "/bin/bash",
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let combined = "";
        let timedOut = false;

        const onChunk = (buf: Buffer, which: "out" | "err") => {
          const text = buf.toString();
          if (which === "out") stdout += text;
          else stderr += text;
          combined += text;
          if (opts.onLine) {
            for (const line of text.split("\n")) {
              if (line.trim()) opts.onLine(redact(line));
            }
          }
        };

        child.stdout.on("data", (b: Buffer) => onChunk(b, "out"));
        child.stderr.on("data", (b: Buffer) => onChunk(b, "err"));

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs);

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, combined, timedOut });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          combined += `\n${err.message}`;
          resolve({ code: -1, stdout, stderr, combined, timedOut });
        });
      });
    },

    start(command, opts) {
      const child = spawn(command, {
        cwd: opts.cwd,
        env: baseEnv(opts.env),
        shell: "/bin/bash",
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let out = "";
      const collect = (b: Buffer) => {
        out += b.toString();
        if (out.length > 200_000) out = out.slice(-100_000);
        if (opts.onLine) {
          for (const line of b.toString().split("\n")) if (line.trim()) opts.onLine(redact(line));
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const exited = new Promise<number | null>((resolve) =>
        child.on("close", (code) => resolve(code)),
      );

      return {
        pid: child.pid,
        output: () => out,
        exited,
        async stop() {
          if (child.pid === undefined || child.exitCode !== null) return;
          try {
            // Kill the whole group: preview servers spawn children of their own.
            process.kill(-child.pid, "SIGTERM");
          } catch {
            try {
              child.kill("SIGTERM");
            } catch {
              /* already gone */
            }
          }
          const stopped = await Promise.race([
            exited.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
          ]);
          if (!stopped && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        },
      };
    },
  };
}

/** Turn a non-zero exit into the right SDV error, with a readable tail. */
export function assertOk(result: RunResult, code: ErrorCode, what: string): void {
  if (result.code === 0) return;
  const reason = result.timedOut ? "timed out" : `exited with code ${result.code}`;
  throw new SdvError(code, `${what} ${reason}\n${tailLines(redact(result.combined), 25)}`);
}
