import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import type { RepoProfile } from "@sdv/core";
import type { RepoDigest, RouteInfo, SpecAction, SpecInfo } from "@sdv/llm";
import { readJson, readMaybe, type PackageJson } from "./stages/detect.ts";

const MAX_README = 8_000;
const MAX_CHANGELOG = 3_000;

/**
 * Build the deterministic picture of the repository.
 *
 * Ranked by signal, strongest first: the end-to-end suite, then routes, then
 * analytics events, then prose. A test is worth more than a README because it
 * is executable — the selectors in it are known to resolve, and the order of
 * actions is a journey someone actually cared about.
 */
export async function buildDigest(srcDir: string, profile: RepoProfile): Promise<RepoDigest> {
  const appDir = profile.appRoot ? join(srcDir, profile.appRoot) : srcDir;
  const pkg = (await readJson<PackageJson>(join(appDir, "package.json"))) ?? {};

  const specs = await extractSpecs(appDir, profile);
  const routes = await extractRoutes(appDir, profile);
  const readme = (await firstOf(appDir, ["README.md", "readme.md", "Readme.md"]))?.slice(0, MAX_README) ?? "";
  const changelog = (await firstOf(appDir, ["CHANGELOG.md", "changelog.md"]))?.slice(0, MAX_CHANGELOG) ?? null;
  const analyticsEvents = await extractAnalyticsEvents(appDir);

  const digest: RepoDigest = {
    projectName: pkg.name ?? "the app",
    description: pkg.description ?? null,
    framework: profile.framework,
    readme,
    routes,
    specs,
    analyticsEvents,
    changelog,
    packageScripts: pkg.scripts ?? {},
    approxTokens: 0,
  };
  digest.approxTokens = Math.round(JSON.stringify(digest).length / 3.6);
  return digest;
}

/* ------------------------------- e2e specs ------------------------------- */

const LOCATORS = new Set([
  "getByRole",
  "getByLabel",
  "getByText",
  "getByTestId",
  "getByPlaceholder",
  "getByTitle",
  "getByAltText",
  "locator",
]);

const ACTIONS: Record<string, SpecAction["kind"]> = {
  click: "click",
  fill: "fill",
  type: "fill",
  selectOption: "select",
  press: "press",
  hover: "hover",
  check: "click",
  uncheck: "click",
};

/**
 * Read the Playwright suite as structure, not text.
 *
 * Parsing the AST rather than regexing the source is what makes the extracted
 * actions trustworthy: `page.getByRole('button', { name: 'Send invite' })` is
 * recovered as a role and a name, which is exactly the shape the Flow DSL
 * wants, and the shape that survives a UI change.
 */
async function extractSpecs(appDir: string, profile: RepoProfile): Promise<SpecInfo[]> {
  if (!profile.e2e || profile.e2e.kind !== "playwright") return [];
  const out: SpecInfo[] = [];

  for (const rel of profile.e2e.specPaths) {
    const source = await readMaybe(join(appDir, rel));
    if (!source) continue;
    try {
      out.push(...parseSpecFile(source, rel));
    } catch {
      // A spec we cannot parse is not a failure — it just contributes nothing.
    }
  }
  return out;
}

export function parseSpecFile(source: string, file: string): SpecInfo[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: true,
  });

  const specs: SpecInfo[] = [];

  // Each `test(...)` / `setup(...)` call becomes one journey.
  walk(ast.program as unknown as Node, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    const name = calleeName(callee);
    if (name !== "test" && name !== "setup" && name !== "it") return;

    const [titleNode, bodyNode] = node.arguments ?? [];
    if (!titleNode || titleNode.type !== "StringLiteral") return;
    const title = String(titleNode.value);
    const isSetup = name === "setup" || /auth|setup/i.test(file);

    const actions: SpecAction[] = [];
    if (bodyNode) collectActions(bodyNode, actions, source);
    specs.push({ file, title, isSetup, actions });
  });

  return specs;
}

function collectActions(body: Node, out: SpecAction[], source: string): void {
  walk(body, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!callee || callee.type !== "MemberExpression") return;
    const method = propName(callee.property);
    if (!method) return;

    // page.goto('/settings/team')
    if (method === "goto") {
      const arg = (node.arguments ?? [])[0];
      if (arg?.type === "StringLiteral") {
        out.push({
          kind: "goto",
          locator: null,
          role: null,
          name: null,
          value: String(arg.value),
          raw: snippet(node, source),
        });
      }
      return;
    }

    const kind = ACTIONS[method];
    const isVisibility = method === "toBeVisible";
    if (!kind && !isVisibility) return;

    const locator = findLocator(callee.object);
    if (!locator) return;

    const value =
      kind === "fill" || kind === "select" || kind === "press"
        ? stringArg(node.arguments)
        : null;

    out.push({
      kind: isVisibility ? "expect" : kind!,
      locator: locator.fn,
      role: locator.role,
      name: locator.name,
      value,
      raw: snippet(node, source),
    });
  });
}

interface LocatorInfo {
  fn: string;
  role: string | null;
  name: string | null;
}

/** Walk back down a chain like `page.getByRole(...).first()` to the locator. */
function findLocator(node: Node | undefined): LocatorInfo | null {
  let cur: Node | undefined = node;
  for (let depth = 0; cur && depth < 12; depth++) {
    if (cur.type === "CallExpression") {
      const callee = cur.callee;
      if (callee?.type === "MemberExpression") {
        const fn = propName(callee.property);
        if (fn && LOCATORS.has(fn)) {
          const args = cur.arguments ?? [];
          const first = args[0];
          if (fn === "getByRole") {
            const role = first?.type === "StringLiteral" ? String(first.value) : null;
            const name = objectStringProp(args[1], "name");
            return { fn, role, name };
          }
          const name = first?.type === "StringLiteral" ? String(first.value) : null;
          return { fn, role: null, name };
        }
      }
      // `expect(page.getByText(...)).toBeVisible()` — the locator is the
      // argument, not the callee.
      const name = cur.callee?.name;
      if (name === "expect") {
        cur = (cur.arguments ?? [])[0];
        continue;
      }
      cur = cur.callee;
      continue;
    }
    if (cur.type === "MemberExpression") {
      cur = cur.object;
      continue;
    }
    if (cur.type === "AwaitExpression") {
      cur = cur.argument;
      continue;
    }
    break;
  }
  return null;
}

/* -------------------------------- routes --------------------------------- */

async function extractRoutes(appDir: string, profile: RepoProfile): Promise<RouteInfo[]> {
  if (profile.framework === "nextjs") return nextRoutes(appDir);
  return routerRoutes(appDir);
}

/** React Router / TanStack style: `<Route path="/x" .../>` or `path: "/x"`. */
async function routerRoutes(appDir: string): Promise<RouteInfo[]> {
  const files = await sourceFiles(join(appDir, "src"), appDir);
  const routes = new Map<string, RouteInfo>();
  for (const rel of files) {
    const text = await readMaybe(join(appDir, rel));
    if (!text) continue;
    for (const m of text.matchAll(/<Route\s+path=["'`]([^"'`]+)["'`]/g)) {
      addRoute(routes, m[1]!, rel, text);
    }
    for (const m of text.matchAll(/path\s*:\s*["'`](\/[^"'`]*)["'`]/g)) {
      addRoute(routes, m[1]!, rel, text);
    }
    for (const m of text.matchAll(/<NavLink\s+to=["'`]([^"'`]+)["'`][^>]*>\s*([^<{]{2,40})</g)) {
      const r = routes.get(normalisePath(m[1]!));
      if (r && !r.label) r.label = m[2]!.trim();
    }
  }
  return [...routes.values()]
    .filter((r) => !r.path.includes("*") && !r.path.includes(":"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function addRoute(map: Map<string, RouteInfo>, path: string, file: string, text: string): void {
  const clean = normalisePath(path);
  if (!clean.startsWith("/")) return;
  if (map.has(clean)) return;
  const label = labelFor(clean, text);
  map.set(clean, { path: clean, file, label });
}

function normalisePath(p: string): string {
  return p.startsWith("/") ? p : `/${p}`;
}

function labelFor(path: string, text: string): string | null {
  const nav = new RegExp(`to=["'\`]${path}["'\`][^>]*>\\s*([^<{]{2,40})<`).exec(text);
  if (nav) return nav[1]!.trim();
  const seg = path.split("/").filter(Boolean).pop();
  return seg ? seg.replace(/[-_]/g, " ") : null;
}

/** Next.js App Router: directories under app/ carrying a page file. */
async function nextRoutes(appDir: string): Promise<RouteInfo[]> {
  const roots = [join(appDir, "app"), join(appDir, "src", "app")];
  const out: RouteInfo[] = [];
  for (const root of roots) {
    const walk = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
          const segment = e.name.startsWith("(") ? "" : `/${e.name}`;
          await walk(join(dir, e.name), prefix + segment);
        } else if (/^page\.(tsx|ts|jsx|js)$/.test(e.name)) {
          const path = prefix || "/";
          out.push({ path, file: relative(appDir, join(dir, e.name)), label: labelOf(path) });
        }
      }
    };
    await walk(root, "");
  }
  return out.filter((r) => !r.path.includes("[")).sort((a, b) => a.path.localeCompare(b.path));
}

function labelOf(path: string): string | null {
  const seg = path.split("/").filter(Boolean).pop();
  return seg ? seg.replace(/[-_]/g, " ") : "home";
}

/* ---------------------------- analytics events --------------------------- */

async function extractAnalyticsEvents(appDir: string): Promise<string[]> {
  const files = await sourceFiles(join(appDir, "src"), appDir);
  const events = new Set<string>();
  for (const rel of files.slice(0, 200)) {
    const text = await readMaybe(join(appDir, rel));
    if (!text) continue;
    for (const m of text.matchAll(
      /(?:track|capture|logEvent|analytics\.\w+)\(\s*["'`]([^"'`]{3,60})["'`]/g,
    )) {
      events.add(m[1]!);
    }
  }
  return [...events].sort().slice(0, 40);
}

/* -------------------------------- helpers -------------------------------- */

async function sourceFiles(dir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(relative(root, p));
    }
  };
  await walk(dir);
  return out.sort();
}

async function firstOf(dir: string, names: string[]): Promise<string | null> {
  for (const n of names) {
    const text = await readMaybe(join(dir, n));
    if (text) return text;
  }
  return null;
}

/* --------------------------- tiny AST utilities -------------------------- */

interface Node {
  type: string;
  start?: number;
  end?: number;
  callee?: Node;
  object?: Node;
  property?: Node;
  arguments?: Node[];
  argument?: Node;
  properties?: Node[];
  key?: Node;
  name?: string;
  value?: unknown;
  [key: string]: unknown;
}

function walk(node: Node | undefined | null, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walk(item as Node, visit);
    } else if (value && typeof value === "object" && "type" in (value as object)) {
      walk(value as Node, visit);
    }
  }
}

function calleeName(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "MemberExpression") return calleeName(node.object);
  return null;
}

function propName(node: unknown): string | null {
  const n = node as Node | undefined;
  if (!n) return null;
  if (n.type === "Identifier") return String(n.name);
  if (n.type === "StringLiteral") return String(n.value);
  return null;
}

function stringArg(args: unknown): string | null {
  const list = (args ?? []) as Node[];
  for (const a of list) {
    if (a?.type === "StringLiteral") return String(a.value);
    if (a?.type === "ObjectExpression") {
      const v = objectStringProp(a, "value") ?? objectStringProp(a, "label");
      if (v) return v;
    }
  }
  return null;
}

function objectStringProp(node: unknown, key: string): string | null {
  const n = node as Node | undefined;
  if (!n || n.type !== "ObjectExpression") return null;
  for (const prop of n.properties ?? []) {
    if (prop.type !== "ObjectProperty") continue;
    if (propName(prop.key) !== key) continue;
    const value = prop.value as Node;
    if (value?.type === "StringLiteral") return String(value.value);
  }
  return null;
}

function snippet(node: Node, source: string): string {
  if (typeof node.start !== "number" || typeof node.end !== "number") return "";
  return source.slice(node.start, Math.min(node.end, node.start + 160));
}
