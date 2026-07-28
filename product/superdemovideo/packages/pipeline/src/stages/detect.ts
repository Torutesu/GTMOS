import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { RepoProfile, SdvError, type Framework, type PackageManager } from "@sdv/core";

/**
 * Work out how to build and run the app.
 *
 * Deterministic first, always. Lockfiles and config files answer this question
 * exactly; a model guessing at it would be slower, cost money, and be wrong in
 * ways that are hard to see. The model is the fallback for what is left over,
 * and in M1 there is no fallback at all — an undetected project asks the user.
 */
export async function detect(srcDir: string, appRootHint = ""): Promise<RepoProfile> {
  const appRoot = appRootHint || (await findAppRoot(srcDir));
  const dir = appRoot ? join(srcDir, appRoot) : srcDir;

  const pkg = await readJson<PackageJson>(join(dir, "package.json"));
  if (!pkg) {
    throw new SdvError("SDV-E010", `no package.json under ${appRoot || "the repository root"}`);
  }

  const rootPkg = appRoot ? await readJson<PackageJson>(join(srcDir, "package.json")) : null;
  const framework = await detectFramework(dir, pkg, rootPkg);
  const packageManager = await detectPackageManager(dir, srcDir, pkg);
  const nodeVersion = detectNodeVersion(pkg) ?? (await readNvmrc(dir));
  const scripts = pkg.scripts ?? {};

  const buildScript = pickScript(scripts, ["build"]);
  const startScript = pickScript(scripts, ["start", "preview", "serve"]);
  const { port, source: portSource } = await detectPort(dir, scripts, framework, startScript);

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

  // A dev server compiles on demand, so the production build is not on the
  // path to a demo — only a way for one to fail. Someone who wants the built
  // output can put the command back through the profile override.
  const needsBuild = !startsDevServer(startScript ? resolveScript(scripts, startScript) : "");

  const profile: RepoProfile = {
    framework,
    packageManager,
    nodeVersion,
    appRoot,
    build: {
      install: installCommand(packageManager, Boolean(await lockfile(dir, srcDir, packageManager))),
      build: buildScript && needsBuild ? runCommand(packageManager, buildScript) : null,
      start: startScript
        ? runCommand(packageManager, startScript)
        : defaultStart(framework, port),
      port,
    },
    e2e,
    env,
    confidence: Math.min(1, Number(confidence.toFixed(2))),
  };

  return RepoProfile.parse(profile);
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

function installCommand(pm: PackageManager, hasLock: boolean): string {
  switch (pm) {
    case "pnpm":
      return hasLock ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn":
      return hasLock ? "yarn install --frozen-lockfile" : "yarn install";
    case "bun":
      return "bun install";
    case "npm":
      return hasLock ? "npm ci" : "npm install";
  }
}

function runCommand(pm: PackageManager, script: string): string {
  return pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`;
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

  for (const cfg of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const text = await readMaybe(join(dir, cfg));
    if (!text) continue;
    const m =
      /preview\s*:\s*\{[^}]*port\s*:\s*(\d{2,5})/s.exec(text) ?? /port\s*:\s*(\d{2,5})/.exec(text);
    if (m) return { port: Number(m[1]), source: "config" };
  }

  // What the start command actually invokes.
  if (startScript) {
    const resolved = resolveScript(scripts, startScript);
    for (const [pattern, port] of COMMAND_PORTS) {
      if (pattern.test(resolved)) return { port, source: "command" };
    }
  }

  return { port: DEFAULT_PORTS[framework], source: "default" };
}

function defaultStart(framework: Framework, port: number): string {
  if (framework === "static") return `npx --yes serve -l ${port} .`;
  return `npx --yes serve -l ${port} dist`;
}

/* ---------------------------------- e2e ---------------------------------- */

async function detectE2e(dir: string): Promise<RepoProfile["e2e"]> {
  for (const cfg of [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs",
  ]) {
    const text = await readMaybe(join(dir, cfg));
    if (text === null) continue;
    const testDir = /testDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1] ?? "e2e";
    const storage = /storageState\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1] ?? null;
    const cleanDir = testDir.replace(/^\.\//, "");
    const specPaths = await findSpecs(join(dir, cleanDir), dir);
    return { kind: "playwright", configPath: cfg, testDir: cleanDir, specPaths, storageStatePath: storage };
  }

  for (const cfg of ["cypress.config.ts", "cypress.config.js"]) {
    if (await exists(join(dir, cfg))) {
      const specPaths = await findSpecs(join(dir, "cypress"), dir);
      return { kind: "cypress", configPath: cfg, testDir: "cypress", specPaths, storageStatePath: null };
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
async function findAppRoot(srcDir: string): Promise<string> {
  const rootPkg = await readJson<PackageJson>(join(srcDir, "package.json"));
  const globs = await workspaceGlobs(srcDir, rootPkg);
  if (globs.length === 0) {
    // Not a workspace root. If it has its own package.json, it is the app.
    if (rootPkg) return "";
    for (const guess of ["app", "web", "site", "frontend", "client"]) {
      if (await exists(join(srcDir, guess, "package.json"))) return guess;
    }
    return "";
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

  const scored: Array<{ dir: string; score: number }> = [];
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
    // previous version of this skipped Excalidraw's actual app and settled on
    // an example project instead.
    let score = 0;
    if (SERVES_A_SITE.test(command)) score += 4;
    else if (starter) score += 1;
    if (WEB_DEPS.some((d) => d in deps)) score += 2;
    if (UI_DEPS.some((d) => d in deps)) score += 1;
    if (score === 0) continue;

    if (/(^|[/-])(app|web|www|site|client|frontend)([/-]|$)/.test(dir)) score += 2;
    if (dir.startsWith("packages/")) score -= 1;
    if (/(^|\/)(examples?|docs?|playground|sandbox|e2e|test)([/-]|$)/.test(dir)) score -= 3;
    scored.push({ dir, score });
  }

  scored.sort((a, b) => b.score - a.score || a.dir.length - b.dir.length);
  return scored[0]?.dir ?? "";
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
