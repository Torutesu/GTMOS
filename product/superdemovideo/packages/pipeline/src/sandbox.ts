import { spawn, type ChildProcess } from "node:child_process";
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
  const passthrough = [
    "PATH",
    "HOME",
    "LANG",
    "TZ",
    "SHELL",
    "TMPDIR",
    // How this machine reaches the internet. Scrubbing these does not make
    // the sandbox safer, it makes it unable to install anything: on a proxied
    // network corepack could not fetch the pinned package manager and failed
    // with a self-signed certificate error, which reads as a broken
    // repository rather than a stripped environment. These describe the
    // network, not the account — unlike an API key, which stays out.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
  ];
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

/**
 * Every child this process started, so none of them outlive it.
 *
 * A repository command is not ours to leave running. Without this, killing a
 * run leaves `npm install` behind — it keeps working, keeps holding the
 * package cache, and the next run mysteriously takes ten times as long and
 * fails inside npm. That failure looks like a bug in the repository being
 * tested, which is the worst possible place for it to look like.
 */
const live = new Set<ChildProcess>();
let reaperInstalled = false;

function track(child: ChildProcess): () => void {
  live.add(child);
  if (!reaperInstalled) {
    reaperInstalled = true;
    const reap = () => {
      for (const c of live) killGroup(c, "SIGKILL");
      live.clear();
    };
    process.once("exit", reap);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        reap();
        process.exit(130);
      });
    }
  }
  return () => live.delete(child);
}

/** Kill the whole process group, falling back to the child alone. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
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
        // Detached so the command gets its own process group. `npm install`
        // spawns its own children, and killing only the shell leaves them
        // running: one orphaned install survived half an hour here, holding
        // the shared package cache and making every later run look broken.
        const child = spawn(command, {
          cwd: opts.cwd,
          env: baseEnv(opts.env),
          shell: "/bin/bash",
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        const untrack = track(child);

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
          killGroup(child, "SIGKILL");
        }, opts.timeoutMs);

        child.on("close", (code) => {
          clearTimeout(timer);
          untrack();
          resolve({ code, stdout, stderr, combined, timedOut });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          untrack();
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
      const untrack = track(child);
      child.on("close", untrack);

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
