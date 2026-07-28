import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  RepoProfile,
  SdvError,
  type Framework,
  type PackageManager,
  type Platform,
} from "@sdv/core";

/**
 * Work out how to build and run the app.
 *
 * Deterministic first, always. Lockfiles and config files answer this question
 * exactly; a model guessing at it would be slower, cost money, and be wrong in
 * ways that are hard to see. The model is the fallback for what is left over,
 * and in M1 there is no fallback at all — an undetected project asks the user.
 */
export async function detect(srcDir: string, appRootHint = ""): Promise<RepoProfile> {
  const found = appRootHint ? { dir: appRootHint, confident: true } : await findAppRoot(srcDir);
  const appRoot = found.dir;
  const dir = appRoot ? join(srcDir, appRoot) : srcDir;

  const pkg = await readJson<PackageJson>(join(dir, "package.json"));
  const platform = await detectPlatform(srcDir, dir, pkg ?? {});

  // A native project has no package.json and no npm scripts to read. Its
  // screens are rendered from source rather than served by it, so the fields
  // that describe installing and starting a web app are left empty on purpose
  // — the profile says what this is, and the render stage takes it from there.
  if (platform !== "web" && platform !== "electron") {
    return RepoProfile.parse({
      platform,
      framework: "unknown",
      packageManager: "npm",
      nodeVersion: null,
      appRoot,
      build: { install: "", build: null, start: "", port: 4180 },
      e2e: await detectE2e(dir),
      env: [],
      confidence: 0.6,
    });
  }

  if (!pkg) {
    throw new SdvError("SDV-E010", `no package.json under ${appRoot || "the repository root"}`);
  }
  const rootPkg = appRoot ? await readJson<PackageJson>(join(srcDir, "package.json")) : null;
  // The pin usually lives at the workspace root, not in the app package.
  const pinned = pkg.packageManager ?? rootPkg?.packageManager;
  const framework = await detectFramework(dir, pkg, rootPkg);
  const packageManager = await detectPackageManager(dir, srcDir, pkg);
  const nodeVersion = detectNodeVersion(pkg) ?? (await readNvmrc(dir));
  const scripts = pkg.scripts ?? {};

  const buildScript = pickScript(scripts, ["build"]);
  const startScript = pickScript(scripts, ["start", "preview", "serve"]);
  // An Electron renderer is served by us, not by the app, so the port is not
  // something to discover — it is something we choose. `electron-vite preview`
  // would otherwise be read as a Vite dev server on 5173, which nothing is
  // listening on.
  const { port, source: portSource } =
    platform === "electron"
      ? { port: ELECTRON_SERVE_PORT, source: "flag" as PortSource }
      : await detectPort(dir, scripts, framework, startScript);

  const e2e = await detectE2e(dir);
  const env = await detectEnv(dir);

  /**
   * How much of this we actually know.
   *
   * The number used to count what we found in package.json, which meant any
   * repository with a build and a start script scored 0.95 — including ones
   * whose port we had guessed from a table and which therefore could not
   * start at all. A confident wrong answer is worse than an unsure one,
   * because nobody is asked to check it. So the port now carries real weight:
   * falling back to a default means we do not know where the app listens, and
   * the profile should say so.
   */
  let confidence = 0.4;
  if (framework !== "unknown") confidence += 0.2;
  if (buildScript) confidence += 0.05;
  if (startScript) confidence += 0.1;
  if (e2e) confidence += 0.05;
  if (portSource === "flag" || portSource === "config") confidence += 0.2;
  else if (portSource === "command") confidence += 0.15;
  else confidence -= 0.15;

  // Some repositories contain no application at all — a framework, a library,
  // a monorepo of packages. When the best candidate we could find is a test
  // fixture or an example, saying so is the whole job. SvelteKit's repository
  // yielded `packages/kit/test/apps/prerendered-app-error-pages` at 0.95,
  // which is a confident wrong answer about a directory nobody would demo.
  if (!found.confident) confidence -= 0.35;

  // A dev server compiles on demand, so the production build is not on the
  // path to a demo — only a way for one to fail. Someone who wants the built
  // output can put the command back through the profile override.
  // Electron always needs its build: the renderer we serve is what it emits.
  const needsBuild =
    platform === "electron" ||
    !startsDevServer(startScript ? resolveScript(scripts, startScript) : "");

  const profile: RepoProfile = {
    platform,
    framework,
    packageManager,
    nodeVersion,
    appRoot,
    build: {
      install: installCommand(
        packageManager,
        Boolean(await lockfile(dir, srcDir, packageManager)),
        pinned,
      ),
      build: buildScript && needsBuild ? runCommand(packageManager, buildScript, pinned) : null,
      start: startScript
        ? runCommand(packageManager, startScript, pinned)
        : defaultStart(framework, port),
      port,
    },
    e2e,
    env,
    confidence: Number(Math.min(1, Math.max(0, confidence)).toFixed(2)),
  };

  return RepoProfile.parse(profile);
}

/* ------------------------------- platform -------------------------------- */

/**
 * What kind of thing this repository builds.
 *
 * Separate from the framework on purpose. An Electron app is built with Vite;
 * an iOS app may have no JavaScript at all. The framework says how the source
 * compiles, the platform says how a browser is going to get at the result —
 * and since every demo is filmed as HTML, that second question is the one the
 * rest of the pipeline turns on.
 */
async function detectPlatform(
  srcDir: string,
  appDir: string,
  pkg: PackageJson,
): Promise<Platform> {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (
    "electron" in deps ||
    "electron-vite" in deps ||
    "electron-builder" in deps ||
    "@electron-forge/cli" in deps
  ) {
    return "electron";
  }

  const roots = [appDir, srcDir];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const names = entries.map((e) => e.name);

    // Android announces itself with Gradle plus a manifest.
    if (
      names.includes("settings.gradle") ||
      names.includes("settings.gradle.kts") ||
      names.includes("build.gradle.kts")
    ) {
      if (await exists(join(root, "app", "src", "main", "AndroidManifest.xml"))) return "android";
      if (names.includes("gradlew")) return "android";
    }

    // Apple platforms share a project format; the destination distinguishes
    // them, and Info.plist is where that is usually visible.
    const xcode = names.find((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"));
    if (xcode || names.includes("Package.swift") || names.includes("Podfile")) {
      const apple = await appleDestination(root);
      if (apple) return apple;
    }
  }

  return "web";
}

async function appleDestination(root: string): Promise<"ios" | "macos" | null> {
  // The declared target platform beats guessing from imports: a SwiftUI file
  // looks the same either way.
  for (const name of ["Package.swift", "Podfile", "project.yml"]) {
    const text = await readMaybe(join(root, name));
    if (!text) continue;
    if (/\.iOS\(|platform :ios|IPHONEOS_DEPLOYMENT_TARGET/i.test(text)) return "ios";
    if (/\.macOS\(|platform :osx|MACOSX_DEPLOYMENT_TARGET/i.test(text)) return "macos";
  }
  for (const plist of ["Info.plist", "Sources/Info.plist"]) {
    const text = await readMaybe(join(root, plist));
    if (text && /UIApplicationSceneManifest|UILaunchStoryboard/i.test(text)) return "ios";
    if (text && /NSPrincipalClass|LSUIElement/i.test(text)) return "macos";
  }
  // An Xcode project we cannot place: macOS is the safer default because the
  // pipeline treats both the same way, and the profile can be overridden.
  return "macos";
}

/* ------------------------------ framework -------------------------------- */

const CONFIG_EXTENSIONS = ["js", "cjs", "mjs", "ts", "mts", "cts"];

/**
 * Which framework this is.
 *
 * `rootPkg` matters in a workspace: the build tool is installed once at the
 * repository root, so the app package itself often lists only react. Reading
 * the app's dependencies alone reported Excalidraw — a Vite application with
 * a vite.config beside its index.html — as a folder of static files.
 */
async function detectFramework(
  dir: string,
  pkg: PackageJson,
  rootPkg: PackageJson | null = null,
): Promise<Framework> {
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(rootPkg?.dependencies ?? {}),
    ...(rootPkg?.devDependencies ?? {}),
  };
  const hasConfig = async (base: string) => {
    for (const ext of CONFIG_EXTENSIONS) {
      if (await exists(join(dir, `${base}.${ext}`))) return true;
    }
    return false;
  };

  // Electron first: an Electron project also carries vite or webpack for its
  // renderer, so anything checked before this would claim it as a web app.
  if (
    "electron" in deps ||
    "electron-vite" in deps ||
    "electron-builder" in deps ||
    (await hasConfig("electron.vite.config")) ||
    (await hasConfig("forge.config"))
  ) {
    return "electron";
  }
  if ((await hasConfig("next.config")) || "next" in deps) return "nextjs";
  if ((await hasConfig("astro.config")) || "astro" in deps) return "astro";
  if ((await hasConfig("svelte.config")) || "@sveltejs/kit" in deps) return "sveltekit";
  if ((await hasConfig("nuxt.config")) || "nuxt" in deps) return "nuxt";
  if ((await hasConfig("vite.config")) || "vite" in deps) return "vite";
  if ("react-scripts" in deps) return "cra";
  if (await exists(join(dir, "index.html"))) return "static";
  return "unknown";
}

/* --------------------------- package manager ----------------------------- */

async function detectPackageManager(
  dir: string,
  root: string,
  pkg: PackageJson,
): Promise<PackageManager> {
  if (pkg.packageManager) {
    const name = pkg.packageManager.split("@")[0];
    if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") return name;
  }
  for (const [file, pm] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    if ((await exists(join(dir, file))) || (await exists(join(root, file)))) return pm;
  }
  return "npm";
}

async function lockfile(dir: string, root: string, pm: PackageManager): Promise<string | null> {
  const names: Record<PackageManager, string> = {
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lockb",
    npm: "package-lock.json",
  };
  for (const base of [dir, root]) {
    const p = join(base, names[pm]);
    if (await exists(p)) return p;
  }
  return null;
}

/**
 * How to invoke the package manager the repository actually asked for.
 *
 * `"packageManager": "yarn@4.12.0"` is not decoration — yarn 4 refuses to run
 * under yarn 1, and the machine's global yarn is whatever it is. tldraw's
 * install failed on exactly this. Corepack ships with Node and exists to
 * resolve the pinned version, so anything with a pin goes through it.
 */
export function managerCommand(pm: PackageManager, pinned: boolean): string {
  return pinned ? `corepack ${pm}` : pm;
}

/** Yarn changed the flag name at 2.0; `--frozen-lockfile` is a hard error there. */
function yarnMajor(pinned: string | undefined): number {
  const m = /^yarn@(\d+)/.exec(pinned ?? "");
  return m ? Number(m[1]) : 1;
}

function installCommand(pm: PackageManager, hasLock: boolean, pinnedVersion?: string): string {
  const cmd = managerCommand(pm, Boolean(pinnedVersion));
  switch (pm) {
    case "pnpm":
      return hasLock ? `${cmd} install --frozen-lockfile` : `${cmd} install`;
    case "yarn":
      if (!hasLock) return `${cmd} install`;
      return yarnMajor(pinnedVersion) >= 2
        ? `${cmd} install --immutable`
        : `${cmd} install --frozen-lockfile`;
    case "bun":
      return `${cmd} install`;
    case "npm":
      return hasLock ? `${cmd} ci` : `${cmd} install`;
  }
}

function runCommand(pm: PackageManager, script: string, pinnedVersion?: string): string {
  const cmd = managerCommand(pm, Boolean(pinnedVersion));
  return pm === "npm" ? `${cmd} run ${script}` : `${cmd} run ${script}`;
}

/* -------------------------------- details -------------------------------- */

function pickScript(scripts: Record<string, string>, names: string[]): string | null {
  for (const n of names) if (scripts[n]) return n;
  return null;
}

function detectNodeVersion(pkg: PackageJson): string | null {
  const engines = pkg.engines?.node;
  if (!engines) return null;
  const m = /(\d+)/.exec(engines);
  return m ? m[1]! : null;
}

async function readNvmrc(dir: string): Promise<string | null> {
  try {
    const text = await readFile(join(dir, ".nvmrc"), "utf8");
    const m = /(\d+)/.exec(text);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

const DEFAULT_PORTS: Record<Framework, number> = {
  nextjs: 3000,
  vite: 4173,
  astro: 4321,
  cra: 3000,
  sveltekit: 4173,
  nuxt: 3000,
  static: 8080,
  electron: 5173,
  unknown: 3000,
};

/**
 * The port each tool listens on, keyed by the command that starts it.
 *
 * Order matters: `vite preview` serves the built app on 4173 while plain
 * `vite` runs the dev server on 5173, and reading the second as the first is
 * how a run dies at E022 having done everything else right. The framework
 * alone cannot tell them apart — only the command can.
 */
const COMMAND_PORTS: Array<[RegExp, number]> = [
  [/\bvite\s+preview\b/, 4173],
  [/\bastro\s+preview\b/, 4321],
  [/\bastro\b/, 4321],
  [/\bnext\b/, 3000],
  [/\bnuxt\b/, 3000],
  [/\bremix-serve\b/, 3000],
  [/\breact-scripts\s+start\b/, 3000],
  [/\bng\s+serve\b/, 4200],
  [/\bwrangler\b/, 8788],
  [/\bhttp-server\b/, 8080],
  [/\bvite\b/, 5173],
  [/\bserve\b/, 3000],
];

export type PortSource = "flag" | "config" | "command" | "default";

/** Where we serve an Electron renderer. Ours to pick, so it is never a guess. */
export const ELECTRON_SERVE_PORT = 4180;

/**
 * Commands that compile on demand rather than serve a build.
 *
 * `vite preview` and `next start` need the build to have run; `vite` and
 * `next dev` do not. Running a production build anyway is not merely wasted
 * time — reveal.js's build script is `tsc && vite build && …` across seven
 * configs, and it fails, which turned a repository whose dev server starts in
 * seconds into a failed run. The build is only required when something is
 * going to serve its output.
 */
const DEV_SERVER =
  /\b(vite|next\s+dev|astro\s+dev|nuxt\s+dev|remix\s+dev|svelte-kit\s+dev|react-scripts\s+start|ng\s+serve)\b/;

export function startsDevServer(command: string): boolean {
  if (/\b(vite\s+preview|next\s+start|astro\s+preview|nuxt\s+start|serve|http-server)\b/.test(command)) {
    return false;
  }
  return DEV_SERVER.test(command);
}

/**
 * Follow `npm run x` chains to the command that actually runs.
 *
 * `"start": "npm run dev"` is common, and reading the wrapper instead of what
 * it wraps means every heuristic downstream is looking at the wrong string.
 */
export function resolveScript(
  scripts: Record<string, string>,
  name: string,
  seen = new Set<string>(),
): string {
  const raw = scripts[name];
  if (!raw || seen.has(name)) return raw ?? "";
  seen.add(name);
  const chained = /^\s*(?:npm run|yarn run|yarn|pnpm run|pnpm|bun run)\s+([\w:.-]+)\s*$/.exec(raw);
  if (chained && scripts[chained[1]!]) return resolveScript(scripts, chained[1]!, seen);
  return raw;
}

async function detectPort(
  dir: string,
  scripts: Record<string, string>,
  framework: Framework,
  startScript: string | null,
): Promise<{ port: number; source: PortSource }> {
  // An explicit --port wins, but only in the script that will actually run.
  // Excalidraw has `serve: http-server -p 5001` sitting next to a `start`
  // that runs Vite on 5173; reading the flag out of the script nobody invokes
  // is a confidently wrong answer.
  if (startScript) {
    const resolved = resolveScript(scripts, startScript);
    const m = /--port[= ](\d{2,5})/.exec(resolved) ?? /(?:^|\s)-p[= ](\d{2,5})/.exec(resolved);
    if (m) return { port: Number(m[1]), source: "flag" };
  }

  const resolvedStart = startScript ? resolveScript(scripts, startScript) : "";

  // The config, reading the block that belongs to the command being run.
  // reveal.js sets `server: { port: Number(process.env.npm_config_port || 8000) }`
  // — the number is there but it is not a literal assignment, and the block it
  // sits in matters: `server` is the dev server, `preview` serves the build.
  const block = startsDevServer(resolvedStart) ? "server" : "preview";
  for (const base of ["vite.config", "vitest.config"]) {
    for (const ext of CONFIG_EXTENSIONS) {
      const text = await readMaybe(join(dir, `${base}.${ext}`));
      if (!text) continue;
      const found = portInBlock(text, block) ?? portInBlock(text, block === "server" ? "preview" : "server");
      if (found) return { port: found, source: "config" };
    }
  }

  // What the start command actually invokes.
  if (resolvedStart) {
    for (const [pattern, port] of COMMAND_PORTS) {
      if (pattern.test(resolvedStart)) return { port, source: "command" };
    }
  }

  return { port: DEFAULT_PORTS[framework], source: "default" };
}

/**
 * The port inside one block of a config object.
 *
 * Deliberately not a parser. It finds the named block, walks to its matching
 * brace, and takes the first number that follows a `port:` — which survives
 * `port: Number(process.env.PORT || 8000)` in a way that matching only a
 * literal does not. `npm_config_port` and friends are skipped because the
 * pattern requires the colon.
 */
export function portInBlock(text: string, block: "server" | "preview"): number | null {
  const start = new RegExp(`(^|[\\s,{])${block}\\s*:\\s*\\{`, "m").exec(text);
  if (!start) return null;

  const open = text.indexOf("{", start.index + start[0].length - 1);
  let depth = 0;
  let end = text.length;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }

  const body = text.slice(open, end);
  const m = /\bport\s*:\s*[^,}\n]*?(\d{2,5})/.exec(body);
  return m ? Number(m[1]) : null;
}

function defaultStart(framework: Framework, port: number): string {
  if (framework === "static") return `npx --yes serve -l ${port} .`;
  return `npx --yes serve -l ${port} dist`;
}

/* ---------------------------------- e2e ---------------------------------- */

/**
 * Find the end-to-end suite.
 *
 * The config is not always at the package root. tldraw keeps its at
 * `apps/examples/e2e/playwright.config.ts`, one directory down, and looking
 * only at the root reported "no e2e specs" for a repository with a full
 * Playwright suite — throwing away the strongest signal the product has.
 */
export async function e2eConfigDirs(dir: string): Promise<string[]> {
  const out = [""];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(e.name)) continue;
    if (/^(e2e|tests?|__tests__|integration|playwright|cypress|test-e2e)$/i.test(e.name)) {
      out.push(e.name);
    }
  }
  return out;
}

const ALWAYS_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

async function detectE2e(dir: string): Promise<RepoProfile["e2e"]> {
  const searchDirs = await e2eConfigDirs(dir);

  for (const sub of searchDirs) {
    const base = sub ? join(dir, sub) : dir;
    for (const name of CONFIG_EXTENSIONS.map((ext) => `playwright.config.${ext}`)) {
      const text = await readMaybe(join(base, name));
      if (text === null) continue;
      const testDir = /testDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1] ?? ".";
      const storage = /storageState\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1] ?? null;
      // testDir is relative to the config, which may itself be in a
      // subdirectory. Everything we report stays relative to the app root.
      const cleanDir = join(sub, testDir.replace(/^\.\//, "")).replace(/^\.\/?/, "");
      const specPaths = await findSpecs(join(dir, cleanDir), dir);
      return {
        kind: "playwright",
        configPath: sub ? join(sub, name) : name,
        testDir: cleanDir || ".",
        specPaths,
        storageStatePath: storage,
      };
    }
  }

  for (const sub of searchDirs) {
    const base = sub ? join(dir, sub) : dir;
    for (const name of ["cypress.config.ts", "cypress.config.js", "cypress.config.mjs"]) {
      if (!(await exists(join(base, name)))) continue;
      const testDir = join(sub, "cypress").replace(/^\.\/?/, "");
      const specPaths = await findSpecs(join(dir, testDir), dir);
      return {
        kind: "cypress",
        configPath: sub ? join(sub, name) : name,
        testDir,
        specPaths,
        storageStatePath: null,
      };
    }
  }
  return null;
}

async function findSpecs(testDir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await walk(p);
      } else if (/\.(spec|test|setup)\.[tj]sx?$/.test(e.name)) {
        out.push(relative(root, p));
      }
    }
  };
  await walk(testDir);
  return out.sort();
}

/* ---------------------------------- env ---------------------------------- */

async function detectEnv(dir: string): Promise<RepoProfile["env"]> {
  const out: RepoProfile["env"] = [];
  for (const name of [".env.example", ".env.sample", ".env.template"]) {
    const text = await readMaybe(join(dir, name));
    if (!text) continue;
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m) out.push({ key: m[1]!, source: name, strategy: "placeholder" });
    }
    break;
  }
  return out;
}

/* -------------------------------- app root ------------------------------- */

const WEB_DEPS = ["next", "vite", "astro", "nuxt", "@sveltejs/kit", "react-scripts", "@remix-run/dev"];
const UI_DEPS = ["react", "vue", "svelte", "solid-js", "preact", "@angular/core"];

/**
 * Directory names that mean "not the product".
 *
 * Written to match singular and plural alike. The previous version listed
 * `test` but not `tests`, `playground` but not `playgrounds`, and no form of
 * `template` or `benchmark` at all — so in four large monorepos it chose,
 * respectively, a Vue template, a playground, a benchmark timer and a webpack
 * test fixture, every time in preference to the actual application.
 */
const NOT_THE_APP =
  /(^|\/)(examples?|templates?|starters?|playgrounds?|sandboxe?s?|benchmarks?|tests?|__tests__|fixtures?|e2e|docs?|documentation|website|scripts?|tools?|devtools?|demos?)(\/|$)/i;

/** A command that puts a site on a port, as opposed to building a library. */
const SERVES_A_SITE =
  /\b(vite|next|astro|nuxt|remix|react-scripts\s+start|ng\s+serve|http-server|serve|svelte-kit)\b/;

/**
 * Find the app when the repository is a monorepo.
 *
 * The workspace list is read from where the repository declares it rather
 * than guessed from directory names. Excalidraw keeps its app in
 * `excalidraw-app/` at the top level — a perfectly ordinary layout that a
 * hardcoded `apps/`, `packages/`, `sites/` search cannot see, and missing it
 * means pointing the whole pipeline at a monorepo root that has no app in it.
 */
export interface AppRoot {
  dir: string;
  /** False when the best we found was a fixture, an example or a guess. */
  confident: boolean;
}

async function findAppRoot(srcDir: string): Promise<AppRoot> {
  const rootPkg = await readJson<PackageJson>(join(srcDir, "package.json"));
  const globs = await workspaceGlobs(srcDir, rootPkg);
  if (globs.length === 0) {
    // Not a workspace root. If it has its own package.json, it is the app.
    if (rootPkg) return { dir: "", confident: true };
    for (const guess of ["app", "web", "site", "frontend", "client"]) {
      if (await exists(join(srcDir, guess, "package.json"))) {
        return { dir: guess, confident: false };
      }
    }
    return { dir: "", confident: false };
  }

  const candidates: string[] = [];
  for (const glob of globs) {
    if (!glob.includes("*")) {
      candidates.push(glob);
      continue;
    }
    const parent = glob.replace(/\/\*+$/, "");
    const entries = await readdir(join(srcDir, parent), { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory()) candidates.push(join(parent, e.name));
  }

  const scored: Array<{ dir: string; score: number; files: number }> = [];
  for (const dir of candidates) {
    const pkg = await readJson<PackageJson>(join(srcDir, dir, "package.json"));
    if (!pkg) continue;

    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const starter = ["start", "dev", "serve", "preview"].find((k) => scripts[k]);
    const command = starter ? resolveScript(scripts, starter) : "";

    // What the package starts is the real signal. Its own dependency list is
    // not: in a workspace the build tool is hoisted to the root, so the app
    // package can list react and nothing else — which is exactly how the
    // first version of this skipped Excalidraw's actual app.
    let score = 0;
    if (SERVES_A_SITE.test(command)) score += 4;
    else if (starter) score += 1;
    if (WEB_DEPS.some((d) => d in deps)) score += 2;
    if (UI_DEPS.some((d) => d in deps)) score += 1;
    if (score === 0) continue;

    // `apps/` is where deployable applications live, near-universally.
    if (dir.startsWith("apps/")) score += 5;
    if (/(^|[/-])(app|web|www|site|client|frontend)([/-]|$)/.test(dir)) score += 2;
    // An application is not published; a library is.
    if (pkg.private === true) score += 1;
    // Something worth an end-to-end suite is something worth demonstrating.
    if (await hasE2eConfig(join(srcDir, dir))) score += 3;

    if (dir.startsWith("packages/")) score -= 1;
    score -= NOT_THE_APP.test(dir) ? 6 : 0;

    scored.push({ dir, score, files: await countSourceFiles(join(srcDir, dir)) });
  }

  // Ties go to the larger package. Sorting by path length preferred
  // `templates/vue` over `apps/dotcom/client` in every monorepo tried.
  scored.sort((a, b) => b.score - a.score || b.files - a.files);
  const best = scored[0];
  if (!best) return { dir: "", confident: false };
  // A winner that only won because everything else was worse is not an
  // answer, it is the least bad guess — and the profile should say so.
  return { dir: best.dir, confident: best.score >= 5 && !NOT_THE_APP.test(best.dir) };
}

async function hasE2eConfig(dir: string): Promise<boolean> {
  for (const sub of await e2eConfigDirs(dir)) {
    const base = sub ? join(dir, sub) : dir;
    for (const ext of CONFIG_EXTENSIONS) {
      if (await exists(join(base, `playwright.config.${ext}`))) return true;
      if (await exists(join(base, `cypress.config.${ext}`))) return true;
    }
  }
  return false;
}

/** Rough size of a package, used only to break ties. Bounded on purpose. */
async function countSourceFiles(dir: string, limit = 400): Promise<number> {
  let n = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (n >= limit || depth > 4) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (n >= limit) return;
      if (e.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) await walk(join(d, e.name), depth + 1);
      else if (/\.(tsx?|jsx?|mts|cts|vue|svelte|astro|css|html)$/.test(e.name)) n++;
    }
  };
  await walk(dir, 0);
  return n;
}

async function workspaceGlobs(srcDir: string, rootPkg: PackageJson | null): Promise<string[]> {
  const out: string[] = [];
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) out.push(...ws.filter((w): w is string => typeof w === "string"));
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    out.push(...((ws as { packages: unknown[] }).packages.filter((w) => typeof w === "string") as string[]));
  }

  // pnpm keeps the same list in its own file. Parsed by line rather than with
  // a YAML dependency: the shape is a flat list of quoted globs.
  const yaml = await readMaybe(join(srcDir, "pnpm-workspace.yaml"));
  if (yaml) {
    for (const line of yaml.split("\n")) {
      const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
      if (m && !m[1]!.startsWith("!")) out.push(m[1]!);
    }
  }
  return [...new Set(out.filter((g) => !g.startsWith("!")))];
}

/* -------------------------------- helpers -------------------------------- */

interface PackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  workspaces?: unknown;
  private?: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  const text = await readMaybe(p);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export { readJson, readMaybe, exists as pathExists };
export type { PackageJson };
