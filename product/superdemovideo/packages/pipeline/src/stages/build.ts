import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SdvError, shortSha, tailLines, waitFor, type RepoProfile } from "@sdv/core";
import type { StageContext } from "../context.ts";
import { stagePaths } from "../context.ts";
import { assertOk, type StartedProcess } from "../sandbox.ts";
import {
  bridgeScript,
  findPreload,
  findRendererOutput,
  injectBridge,
  readBridgeSurface,
  type BridgeSurface,
} from "./bridge.ts";
import { collectBridgeSeed } from "./electron-app.ts";
import {
  isNativePlatform,
  readRendered,
  renderNative,
  serveNativeCommand,
  type NativePlatform,
} from "./render-native.ts";

const INSTALL_TIMEOUT_MS = 15 * 60_000;
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

  // A native app is never installed or started here. Its screens are rendered
  // from the source that declares them and served like any static site, which
  // is what lets seed, capture and everything after them stay as they are.
  if (isNativePlatform(profile.platform)) {
    return serveRenderedScreens(ctx, profile.platform, appDir, paths, profile.build.port);
  }

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
    // The sandbox defaults to NODE_ENV=production, which is right for the
    // build and the server but silently drops devDependencies during the
    // install — and the build tool itself usually lives there. Installing in
    // development mode is what CI does by simply not setting NODE_ENV.
    const installEnv = { ...env, NODE_ENV: "development" };
    const runInstall = (command: string) =>
      ctx.sandbox.exec(command, {
        cwd: appDir,
        env: installEnv,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onLine: (line) => {
          // A ten-minute silence looks identical to a hang. Surface enough to
          // tell the two apart without replaying the whole npm log.
          if (/(added|resolved|reused|downloaded|packages in|error)/i.test(line)) {
            ctx.progress({ stage: "build", status: "running", message: line.slice(0, 120) });
          }
        },
      });

    ctx.progress({ stage: "build", status: "running", message: "Installing dependencies" });
    let install = await runInstall(profile.build.install);

    /**
     * Try again without the lockfile requirement.
     *
     * `npm ci` refuses outright when package.json and the lockfile have
     * drifted, which is an ordinary state for a repository nobody has
     * installed in a while — reveal.js is checked in that way today. The
     * strict form goes first because a reproducible tree is worth having, but
     * refusing to film a demo over a stale lockfile helps nobody.
     */
    const relaxed = relaxInstall(profile.build.install);
    if (install.code !== 0 && !install.timedOut && relaxed) {
      ctx.log.warn("strict install failed, retrying without the lockfile requirement", {
        detail: tailLines(install.combined, 2),
      });
      ctx.progress({
        stage: "build",
        status: "running",
        message: `Lockfile is out of date — retrying with \`${relaxed}\``,
      });
      const second = await runInstall(relaxed);
      await writeFile(
        join(paths.logs, "install.log"),
        `$ ${profile.build.install}\n${install.combined}\n\n$ ${relaxed}\n${second.combined}`,
      );
      install = second;
    } else {
      await writeFile(join(paths.logs, "install.log"), install.combined);
    }

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

  // An Electron app is filmed as what it already is — a web page — rather
  // than through a desktop window. Its renderer is served like any static
  // build, with a stand-in for the bridge the preload script would have
  // provided. See stages/bridge.ts for why that is the whole difference.
  const startCommand =
    profile.platform === "electron"
      ? await prepareElectronRenderer(ctx, appDir, profile.build.port)
      : profile.build.start;

  const proc = ctx.sandbox.start(startCommand, {
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
 * Render a native app's screens and serve them.
 *
 * The same shape as the web path from the caller's side — an address that
 * answers — so nothing downstream has to know which kind of app this was.
 */
async function serveRenderedScreens(
  ctx: StageContext,
  platform: NativePlatform,
  appDir: string,
  paths: ReturnType<typeof stagePaths>,
  port: number,
): Promise<BuiltApp> {
  const outDir = join(paths.app, "screens");

  // Analysis renders the screens, because for a native app they are what the
  // candidate list is made of. Finding them here means the person chose from
  // these exact pages, so they are the ones to film.
  const existing = await readRendered(outDir);
  const screens =
    existing ??
    (await renderNative(ctx, { srcDir: appDir, platform, outDir, port })).screens;

  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = ctx.sandbox.start(serveNativeCommand(outDir, port), { cwd: paths.app });

  const up = await waitFor(async () => reachable(baseUrl), {
    timeoutMs: START_TIMEOUT_MS,
    intervalMs: 400,
  });
  if (!up) {
    await writeFile(join(paths.logs, "start.log"), proc.output()).catch(() => {});
    await proc.stop();
    throw new SdvError("SDV-E022", `the rendered screens did not come up on ${baseUrl}`);
  }

  ctx.log.info("serving rendered screens", {
    platform,
    baseUrl,
    screens: screens.length,
    rerendered: existing === null,
  });
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
 * Make an Electron renderer openable in an ordinary browser.
 *
 * Everything the demo needs is already there — the renderer is a web page,
 * built by Vite, sitting in `out/renderer`. The one thing missing is the
 * bridge: `contextBridge.exposeInMainWorld` normally hands the page an object
 * of functions backed by the main process, and without it the app throws on
 * its first line. So the preload source is read for what it promised to
 * expose, a stand-in is written from that, and it goes into the page ahead of
 * the app's own scripts.
 *
 * Returns the command that serves the result.
 */
async function prepareElectronRenderer(
  ctx: StageContext,
  appDir: string,
  port: number,
): Promise<string> {
  const rendererDir = await findRendererOutput(appDir);
  if (!rendererDir) {
    throw new SdvError(
      "SDV-E021",
      "the build produced no renderer — looked for index.html under out/, dist/ and .vite/",
    );
  }

  const preloadPath = await findPreload(appDir);
  let surfaces: BridgeSurface[] = [];
  if (preloadPath) {
    surfaces = readBridgeSurface(await readFile(preloadPath, "utf8"));
    ctx.log.info("read the preload bridge", {
      preload: preloadPath.replace(appDir, "."),
      exposed: surfaces.map((s) => `${s.namespace}(${s.methods.length})`).join(" "),
    });
  } else {
    ctx.log.warn("no preload source found; the renderer may still need one");
  }

  // What the stand-in answers with. Read out of the app's own source: a
  // `getSettings()` that returns nothing leaves the settings screen sitting on
  // "Loading settings…" forever, and `const DEFAULT_SETTINGS = {…}` is the same
  // fact already written down in the repository.
  const seed = await collectBridgeSeed(appDir, surfaces);
  if (Object.keys(seed).length > 0) {
    ctx.log.info("answering the bridge from the app's own defaults", {
      methods: Object.keys(seed).join(" "),
    });
  }

  const indexPath = join(rendererDir, "index.html");
  const html = await readFile(indexPath, "utf8");
  // A second run over the same working directory would otherwise stack a new
  // stand-in on top of the old one, and the later script wins.
  const clean = html.replace(/<script>\(function \(\)\s*\{\s*\/\/ Stand-in[\s\S]*?<\/script>/, "");
  await writeFile(indexPath, injectBridge(clean, bridgeScript(surfaces, seed)));

  ctx.progress({
    stage: "build",
    status: "running",
    message: `Serving the Electron renderer with a stand-in for ${surfaces.length} bridge(s)`,
  });
  return `npx --yes serve -s -l ${port} ${JSON.stringify(rendererDir)}`;
}

/**
 * The same install without the lockfile requirement.
 *
 * Returns null when the command is already permissive, so the caller does not
 * run an identical command twice and call it a retry.
 */
export function relaxInstall(command: string): string | null {
  const map: Array<[RegExp, string]> = [
    [/\bnpm\s+ci\b/, "npm install --no-audit --no-fund"],
    [/\bpnpm\s+install\s+--frozen-lockfile\b/, "pnpm install --no-frozen-lockfile"],
    [/\byarn\s+install\s+--frozen-lockfile\b/, "yarn install"],
    [/\byarn\s+install\s+--immutable\b/, "yarn install"],
  ];
  for (const [pattern, replacement] of map) {
    if (pattern.test(command)) return command.replace(pattern, replacement);
  }
  return null;
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
