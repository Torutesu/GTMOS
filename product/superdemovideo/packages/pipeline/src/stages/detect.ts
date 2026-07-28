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

  const framework = await detectFramework(dir, pkg);
  const packageManager = await detectPackageManager(dir, srcDir, pkg);
  const nodeVersion = detectNodeVersion(pkg) ?? (await readNvmrc(dir));
  const scripts = pkg.scripts ?? {};

  const buildScript = pickScript(scripts, ["build"]);
  const startScript = pickScript(scripts, ["start", "preview", "serve"]);
  const port = await detectPort(dir, scripts, framework);

  const e2e = await detectE2e(dir);
  const env = await detectEnv(dir);

  let confidence = 0.5;
  if (framework !== "unknown") confidence += 0.25;
  if (buildScript) confidence += 0.1;
  if (startScript) confidence += 0.1;
  if (e2e) confidence += 0.05;

  const profile: RepoProfile = {
    framework,
    packageManager,
    nodeVersion,
    appRoot,
    build: {
      install: installCommand(packageManager, Boolean(await lockfile(dir, srcDir, packageManager))),
      build: buildScript ? runCommand(packageManager, buildScript) : null,
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

async function detectFramework(dir: string, pkg: PackageJson): Promise<Framework> {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = async (f: string) => exists(join(dir, f));

  if ((await has("next.config.js")) || (await has("next.config.mjs")) || (await has("next.config.ts")) || "next" in deps)
    return "nextjs";
  if ((await has("astro.config.mjs")) || (await has("astro.config.ts")) || "astro" in deps) return "astro";
  if ((await has("svelte.config.js")) || "@sveltejs/kit" in deps) return "sveltekit";
  if ((await has("nuxt.config.ts")) || "nuxt" in deps) return "nuxt";
  if ((await has("vite.config.ts")) || (await has("vite.config.js")) || "vite" in deps) return "vite";
  if ("react-scripts" in deps) return "cra";
  if (await has("index.html")) return "static";
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

async function detectPort(
  dir: string,
  scripts: Record<string, string>,
  framework: Framework,
): Promise<number> {
  // An explicit --port in the start script beats every heuristic.
  for (const key of ["start", "preview", "serve", "dev"]) {
    const s = scripts[key];
    if (!s) continue;
    const m = /--port[= ](\d{2,5})/.exec(s) ?? /-p[= ](\d{2,5})/.exec(s);
    if (m) return Number(m[1]);
  }
  for (const cfg of ["vite.config.ts", "vite.config.js"]) {
    const text = await readMaybe(join(dir, cfg));
    if (!text) continue;
    const m = /preview\s*:\s*\{[^}]*port\s*:\s*(\d{2,5})/s.exec(text) ?? /port\s*:\s*(\d{2,5})/.exec(text);
    if (m) return Number(m[1]);
  }
  return DEFAULT_PORTS[framework];
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

/** Find the app when the repository is a monorepo. */
async function findAppRoot(srcDir: string): Promise<string> {
  if (await exists(join(srcDir, "package.json"))) {
    const pkg = await readJson<PackageJson>(join(srcDir, "package.json"));
    const isContainer = pkg?.workspaces !== undefined || (await exists(join(srcDir, "pnpm-workspace.yaml")));
    if (!isContainer) return "";
  }
  for (const parent of ["apps", "packages", "sites"]) {
    let entries;
    try {
      entries = await readdir(join(srcDir, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = join(parent, e.name);
      if (await exists(join(srcDir, candidate, "package.json"))) {
        const pkg = await readJson<PackageJson>(join(srcDir, candidate, "package.json"));
        const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
        if ("next" in deps || "vite" in deps || "astro" in deps || "react-scripts" in deps) {
          return candidate;
        }
      }
    }
  }
  return "";
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
