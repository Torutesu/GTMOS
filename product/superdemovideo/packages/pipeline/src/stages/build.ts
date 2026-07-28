import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SdvError, shortSha, waitFor, type RepoProfile } from "@sdv/core";
import type { StageContext } from "../context.ts";
import { stagePaths } from "../context.ts";
import { assertOk, type StartedProcess } from "../sandbox.ts";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 90_000;

export interface BuiltApp {
  baseUrl: string;
  appDir: string;
  process: StartedProcess;
  stop(): Promise<void>;
}

/**
 * Install, build and start the app.
 *
 * The dependency tree is cached against the lockfile hash. That is what makes
 * regeneration cheap: the second run through a repository skips the install
 * entirely, which is most of the wall clock and all of the network.
 */
export async function build(ctx: StageContext, profile: RepoProfile): Promise<BuiltApp> {
  const paths = stagePaths(ctx.workDir);
  const appDir = profile.appRoot ? join(paths.src, profile.appRoot) : paths.src;

  await mkdir(paths.logs, { recursive: true });
  const env = placeholderEnv(profile);

  // ---- install (cache-aware) ------------------------------------------
  const cacheKey = await depsCacheKey(appDir, paths.src);
  const cachePath = cacheKey ? `deps-cache/${cacheKey}` : null;
  const modulesDir = join(appDir, "node_modules");

  let restored = false;
  if (cachePath && (await ctx.storage.exists(cachePath))) {
    const local = ctx.storage.localPath(cachePath);
    if (local) {
      ctx.progress({ stage: "build", status: "running", message: "Restoring cached dependencies" });
      await rm(modulesDir, { recursive: true, force: true });
      await cp(local, modulesDir, { recursive: true, dereference: false });
      restored = true;
      ctx.log.info("dependency cache hit", { cacheKey });
    }
  }

  if (!restored) {
    ctx.progress({ stage: "build", status: "running", message: "Installing dependencies" });
    const install = await ctx.sandbox.exec(profile.build.install, {
      cwd: appDir,
      // The sandbox defaults to NODE_ENV=production, which is right for the
      // build and the server but silently drops devDependencies during the
      // install — and the build tool itself usually lives there. Installing in
      // development mode is what CI does by simply not setting NODE_ENV.
      env: { ...env, NODE_ENV: "development" },
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    await writeFile(join(paths.logs, "install.log"), install.combined);
    assertOk(install, "SDV-E020", "dependency install");

    if (cachePath && (await pathExists(modulesDir))) {
      await ctx.storage.putDir(cachePath, modulesDir).catch(() => {
        ctx.log.warn("could not populate dependency cache");
      });
    }
  }

  // ---- build ------------------------------------------------------------
  if (profile.build.build) {
    ctx.progress({ stage: "build", status: "running", message: "Building" });
    const res = await ctx.sandbox.exec(profile.build.build, {
      cwd: appDir,
      env,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    await writeFile(join(paths.logs, "build.log"), res.combined);
    assertOk(res, "SDV-E021", "build");
  }

  // ---- start ------------------------------------------------------------
  const baseUrl = `http://127.0.0.1:${profile.build.port}`;
  ctx.progress({ stage: "build", status: "running", message: `Starting the app on :${profile.build.port}` });

  const proc = ctx.sandbox.start(profile.build.start, {
    cwd: appDir,
    env: { ...env, PORT: String(profile.build.port) },
  });

  const up = await waitFor(async () => reachable(baseUrl), {
    timeoutMs: START_TIMEOUT_MS,
    intervalMs: 400,
  });

  if (!up) {
    const log = proc.output();
    await writeFile(join(paths.logs, "start.log"), log);
    await proc.stop();
    throw new SdvError(
      "SDV-E022",
      `nothing answered on ${baseUrl} within ${START_TIMEOUT_MS / 1000}s\n${log.slice(-1500)}`,
    );
  }

  ctx.log.info("app is up", { baseUrl, cached: restored });
  return {
    baseUrl,
    appDir,
    process: proc,
    async stop() {
      await writeFile(join(paths.logs, "start.log"), proc.output()).catch(() => {});
      await proc.stop();
    },
  };
}

/**
 * Placeholder values only — a build never receives a real secret.
 *
 * Some of these end up on screen. A workspace name or brand string gets
 * rendered into the page, filmed, and shipped to a customer's landing page,
 * so `sdv-placeholder-vite-workspace-name` in the middle of a sentence is a
 * visible defect in the deliverable. Keys that read like display copy get a
 * plausible value; everything else keeps the obvious marker, because a token
 * or a URL that shows up in the frame is a bug worth seeing.
 */
function placeholderEnv(profile: RepoProfile): Record<string, string> {
  const env: Record<string, string> = {};
  for (const req of profile.env) {
    if (req.strategy === "skip") continue;
    env[req.key] = placeholderFor(req.key);
  }
  if (profile.nodeVersion) env["SDV_NODE_VERSION"] = profile.nodeVersion;
  return env;
}

const DISPLAY_VALUES: Array<[RegExp, string]> = [
  [/(WORKSPACE|ORG|COMPANY|TEAM|TENANT|BRAND|PRODUCT|SITE|APP)_?(NAME|TITLE)?$/, "Northwind"],
  [/(SUPPORT|CONTACT|FROM|REPLY_TO)_?EMAIL$/, "hello@northwind.design"],
  [/(TAGLINE|DESCRIPTION|SUBTITLE)$/, "Work that moves"],
  [/CURRENCY$/, "USD"],
  [/LOCALE$/, "en-US"],
];

export function placeholderFor(key: string): string {
  const upper = key.toUpperCase();
  for (const [pattern, value] of DISPLAY_VALUES) {
    if (pattern.test(upper)) return value;
  }
  if (/^(NEXT_PUBLIC_|VITE_|PUBLIC_)?[A-Z_]*URL$/.test(upper)) return "https://example.com";
  return `sdv-placeholder-${key.toLowerCase().replace(/_/g, "-")}`;
}

async function depsCacheKey(appDir: string, srcRoot: string): Promise<string | null> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"]) {
    for (const base of [appDir, srcRoot]) {
      const p = join(base, name);
      try {
        const content = await readFile(p);
        // The prefix is a cache generation. Bump it whenever the way we run
        // the install changes, so a tree produced by the old rules is never
        // restored under the new ones.
        return `v2-${name.replace(/\W/g, "")}-${shortSha(content)}`;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    clearTimeout(t);
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export { pathExists as buildPathExists };
