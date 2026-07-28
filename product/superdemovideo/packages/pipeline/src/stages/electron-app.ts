import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import type { Viewport } from "@sdv/core";
import { screenControls, type AppScreen } from "@sdv/llm";
import type { Page } from "playwright-core";
import type { StageContext } from "../context.ts";
import type { BridgeSurface } from "./bridge.ts";

/**
 * Finding out what an Electron app can show, by running it.
 *
 * The renderer is real HTML and we serve it, so unlike a native app there is
 * nothing to guess about its markup — we can read the accessible names off the
 * live page. What we cannot read is the rest of the app: almost every screen
 * past the first is reached by the main process telling the renderer to go
 * there, and the main process is not running.
 *
 * So this delivers the events the main process would have sent and keeps only
 * the ones that visibly changed the page. Guesses are cheap and wrong guesses
 * are free — a value that reaches nothing simply does not become a screen.
 *
 * Everything it puts on the page comes from the app's own repository: a default
 * the app declares, or a fixture the app committed. Nothing here invents
 * content, for the same reason the native path never types into a field.
 */

/* --------------------------- answering the calls -------------------------- */

/** Names that mean "hand me the current value of X". */
const GETTER = /^(get|check|load|fetch|read)([A-Z]\w*)$/;

/** Anything under a key like this is emptied, whatever the repository says. */
const SECRET_KEY = /token|api[_-]?key|secret|password|credential|passphrase/i;

/**
 * Answer a bridge call with the app's own declared default.
 *
 * `getSettings()` and `const DEFAULT_SETTINGS = {…}` are the same fact written
 * twice, and the second one is in the repository. Reading it is the difference
 * between an app that renders its settings screen and one that sits on
 * "Loading settings…" forever.
 */
export async function collectBridgeSeed(
  srcDir: string,
  surfaces: BridgeSurface[],
): Promise<Record<string, unknown>> {
  const files = await sourceFiles(join(srcDir, "src"), srcDir, [".ts", ".tsx", ".js"]);
  const declared = new Map<string, unknown>();

  for (const rel of files.slice(0, 300)) {
    const text = await readFile(join(srcDir, rel), "utf8").catch(() => "");
    if (!text.includes("DEFAULT")) continue;
    for (const [name, value] of declaredDefaults(text)) {
      if (!declared.has(name)) declared.set(name, value);
    }
  }

  const seed: Record<string, unknown> = {};
  for (const surface of surfaces) {
    for (const method of surface.methods) {
      if (method.kind !== "call") continue;
      const subject = GETTER.exec(method.name)?.[2];
      if (!subject) continue;
      for (const key of defaultNamesFor(subject)) {
        if (declared.has(key)) {
          seed[method.name] = redactSecrets(declared.get(key));
          break;
        }
      }
    }
  }
  return seed;
}

function defaultNamesFor(subject: string): string[] {
  const upper = subject.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return [`DEFAULT_${upper}`, `DEFAULT_${upper}S`, `${upper}_DEFAULTS`, `DEFAULTS`];
}

/** `const DEFAULT_X = { … }` declarations, evaluated as far as they are literal. */
export function declaredDefaults(source: string): Array<[string, unknown]> {
  let ast;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
  } catch {
    return [];
  }

  const constants = new Map<string, Node>();
  walk(ast as unknown as Node, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      constants.set(node.id.name, node.init);
    }
  });

  const out: Array<[string, unknown]> = [];
  for (const [name, init] of constants) {
    if (!name.startsWith("DEFAULT") && !name.endsWith("DEFAULTS")) continue;
    const value = literal(init, constants, 0);
    if (value !== MISSING) out.push([name, value]);
  }
  return out;
}

const MISSING = Symbol("not a literal");

/**
 * As much of an expression as is written down.
 *
 * A key whose value is computed at runtime is dropped rather than guessed —
 * the app then falls back to whatever it does when a field is absent, which is
 * its own behaviour rather than ours. The one exception is a choice between
 * two constants: a demo needs one of them and both are the app's, so the first
 * is taken.
 */
function literal(node: Node, constants: Map<string, Node>, depth: number): unknown {
  if (depth > 8) return MISSING;
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? "") : MISSING;
    case "UnaryExpression":
      if (node.operator === "-") {
        const inner = literal(node.argument as Node, constants, depth + 1);
        return typeof inner === "number" ? -inner : MISSING;
      }
      return MISSING;
    case "Identifier": {
      const referenced = constants.get(node.name);
      return referenced ? literal(referenced, constants, depth + 1) : MISSING;
    }
    case "ConditionalExpression": {
      const first = literal(node.consequent as Node, constants, depth + 1);
      return first !== MISSING ? first : literal(node.alternate as Node, constants, depth + 1);
    }
    case "ArrayExpression": {
      const items: unknown[] = [];
      for (const element of node.elements) {
        if (!element) continue;
        const value = literal(element as Node, constants, depth + 1);
        if (value !== MISSING) items.push(value);
      }
      return items;
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return literal(node.expression as Node, constants, depth + 1);
    case "ObjectExpression": {
      const object: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (property.type !== "ObjectProperty") continue;
        const key =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "StringLiteral"
              ? property.key.value
              : null;
        if (!key) continue;
        const value = literal(property.value as Node, constants, depth + 1);
        if (value !== MISSING) object[key] = value;
      }
      return object;
    }
    default:
      return MISSING;
  }
}

/** Empty anything that reads as a credential, wherever it sits in the shape. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key)
        ? typeof inner === "string"
          ? ""
          : redactSecrets(inner)
        : redactSecrets(inner);
    }
    return out;
  }
  return value;
}

/* ------------------------- reaching the other screens --------------------- */

const VIEW_TYPE = /\b(?:type|enum)\s+\w*(?:View|Screen|Route|Page|Tab)\w*\s*=\s*([^;\n]+)/g;
const VIEW_SETTER = /\bset(?:View|Screen|Route|Page|Tab)\s*\(\s*['"]([\w-]{2,30})['"]/g;

/**
 * The values the app's navigation might accept.
 *
 * A union type of string literals is the app saying, in its own words, which
 * screens exist. Calls to a view setter say the same thing less formally. Both
 * are collected and none is believed: a value only becomes a screen after the
 * page has visibly changed in response to it.
 */
export async function navigationValues(srcDir: string): Promise<string[]> {
  const files = await sourceFiles(join(srcDir, "src"), srcDir, [".ts", ".tsx"]);
  const values = new Set<string>();

  for (const rel of files.slice(0, 300)) {
    const text = await readFile(join(srcDir, rel), "utf8").catch(() => "");
    for (const match of text.matchAll(VIEW_TYPE)) {
      for (const member of match[1]!.matchAll(/['"]([\w-]{2,30})['"]/g)) values.add(member[1]!);
    }
    for (const match of text.matchAll(VIEW_SETTER)) values.add(match[1]!);
  }
  return [...values].sort();
}

/**
 * Fixtures the app committed, grouped by the directory they sit in.
 *
 * The directory name is the match: a repository that keeps
 * `tests/fixtures/context/*.json` is saying those files are contexts, which is
 * what `onContextPushed` delivers. Reusing them is the same move as reusing a
 * committed `storageState` on the web — the team already decided this data was
 * fit to check in.
 */
export async function committedFixtures(
  srcDir: string,
): Promise<Array<{ group: string; path: string; value: unknown }>> {
  const out: Array<{ group: string; path: string; value: unknown }> = [];
  const roots = ["tests/fixtures", "test/fixtures", "fixtures", "__fixtures__", "src/fixtures"];

  for (const root of roots) {
    const base = join(srcDir, root);
    const groups = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const files = await readdir(join(base, group.name)).catch(() => []);
      for (const file of files.slice(0, 40)) {
        // `.expected.json` is what a test asserts, not what the app was given.
        if (extname(file) !== ".json" || file.includes(".expected.") || file.includes(".trace.")) {
          continue;
        }
        const path = join(base, group.name, file);
        const text = await readFile(path, "utf8").catch(() => null);
        if (!text || text.length > 200_000) continue;
        try {
          out.push({ group: group.name, path: relative(srcDir, path), value: JSON.parse(text) });
        } catch {
          // A fixture we cannot read contributes nothing.
        }
      }
    }
  }
  return out;
}

/* -------------------------------- exploring ------------------------------- */

export interface ExploreResult {
  screens: AppScreen[];
}

/**
 * Walk the running app and record every screen it will actually show.
 *
 * The page is reloaded between attempts. An app that has been navigated once
 * is not in its opening state any more, and a screen recorded from a page
 * three navigations deep is not one the demo can reach in one step.
 */
export async function exploreElectron(
  ctx: StageContext,
  page: Page,
  opts: { srcDir: string; baseUrl: string },
): Promise<ExploreResult> {
  const screens: AppScreen[] = [];

  await page.goto(opts.baseUrl, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(1200);

  const subscriptions = await page.evaluate(
    () =>
      (window as unknown as { __sdvBridge?: { subscriptions(): string[] } }).__sdvBridge?.subscriptions() ??
      [],
  );
  ctx.log.info("the renderer subscribed to", { subscriptions: subscriptions.join(" ") });

  const opening = await snapshot(page);
  screens.push({
    name: "opening",
    title: opening.title,
    reach: null,
    controls: opening.controls,
  });

  const navigationSubs = subscriptions.filter((s) => /navigat|route|view|screen/i.test(s));
  const values = await navigationValues(opts.srcDir);

  for (const event of navigationSubs) {
    for (const value of values) {
      const after = await deliver(page, opts.baseUrl, event, value);
      if (!after || after.text === opening.text) continue;
      if (after.text.length < 40) continue; // a blank screen is not a screen
      screens.push({ name: value, title: after.title, reach: { event, payload: value }, controls: after.controls });
    }
  }

  const contentSubs = subscriptions.filter((s) => !navigationSubs.includes(s));
  const fixtures = await committedFixtures(opts.srcDir);

  for (const event of contentSubs) {
    const group = matchingGroup(event, fixtures);
    if (!group) continue;
    const fixture = fixtures.find((f) => f.group === group);
    if (!fixture) continue;

    // Two shapes, because a real preload often wraps what it forwards and the
    // stand-in only reproduces the method names. Whichever moves the page wins.
    for (const payload of [{ [group]: fixture.value }, fixture.value]) {
      const after = await deliver(page, opts.baseUrl, event, payload);
      if (!after || after.text === opening.text) continue;
      screens.push({
        name: `${group}-${basename(fixture.path)}`,
        title: after.title,
        reach: { event, payload },
        controls: after.controls,
        origin: fixture.path,
      });
      break;
    }
  }

  ctx.log.info("explored the running app", {
    screens: screens.map((s) => s.name).join(" "),
    tried: values.length,
  });
  return { screens: screens.slice(0, 7) };
}

function matchingGroup(
  event: string,
  fixtures: Array<{ group: string }>,
): string | null {
  const subject = event.replace(/^on/, "").toLowerCase();
  for (const { group } of fixtures) {
    if (subject.includes(group.toLowerCase())) return group;
  }
  return null;
}

async function deliver(
  page: Page,
  baseUrl: string,
  event: string,
  payload: unknown,
): Promise<{ title: string; text: string; controls: ReturnType<typeof screenControls> } | null> {
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(900);
  const reached = await page
    .evaluate(
      ([name, value]) =>
        (window as unknown as { __sdvBridge?: { emit(e: string, p: unknown): number } }).__sdvBridge?.emit(
          name as string,
          value,
        ) ?? 0,
      [event, payload] as [string, unknown],
    )
    .catch(() => 0);
  if (reached === 0) return null;
  await page.waitForTimeout(1200);
  return snapshot(page);
}

async function snapshot(page: Page) {
  const { title, text, html } = await page.evaluate(() => ({
    title: document.title,
    text: (document.body.innerText || "").replace(/\s+/g, " ").trim(),
    html: document.body.innerHTML,
  }));
  return { title, text, controls: screenControls(html).slice(0, 12) };
}

/* -------------------------------- helpers -------------------------------- */

function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.json$/, "");
}

async function sourceFiles(dir: string, root: string, extensions: string[]): Promise<string[]> {
  const out: string[] = [];
  const walkDir = async (current: string, depth: number): Promise<void> => {
    if (depth > 6 || out.length > 600) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walkDir(path, depth + 1);
      else if (extensions.includes(extname(entry.name))) out.push(relative(root, path));
    }
  };
  await walkDir(dir, 0);
  return out.sort();
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  const skip = new Set(["leadingComments", "trailingComments", "innerComments", "loc"]);
  for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
    if (skip.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) walk(child as Node, visit);
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walk(value as Node, visit);
    }
  }
}

/* --------------------------- the shape of the window ---------------------- */

/**
 * Film a desktop app at the size it asks to be.
 *
 * KashinAI opens a 560×460 panel. Filmed at the web default of 1440×900 its
 * text wraps in a narrow column with half the frame empty — a shape the product
 * never has and nobody would recognise. The main process states the size it
 * wants, so there is nothing to guess.
 *
 * The pixel density is raised to compensate: a 560-wide capture upscaled into a
 * 1920-wide video is soft, and asking the browser for the same layout at three
 * times the pixels costs nothing but memory.
 */
export async function declaredWindowSize(
  srcDir: string,
): Promise<{ width: number; height: number } | null> {
  const files = await sourceFiles(join(srcDir, "src"), srcDir, [".ts", ".js"]);
  for (const rel of files.slice(0, 300)) {
    const text = await readFile(join(srcDir, rel), "utf8").catch(() => "");
    if (!text.includes("BrowserWindow")) continue;

    const call = /new\s+BrowserWindow\s*\(\s*\{([\s\S]{0,600}?)\}/.exec(text);
    if (!call) continue;
    const options = call[1]!;

    const dimension = (key: string): number | null => {
      const raw = new RegExp(`\\b${key}\\s*:\\s*([\\w.]+)`).exec(options)?.[1];
      if (!raw) return null;
      if (/^\d+$/.test(raw)) return Number(raw);
      // `width: ASSISTANT_WIDTH` — the constant is declared in the same file.
      const constant = new RegExp(`\\b${raw}\\s*=\\s*(\\d+)`).exec(text)?.[1];
      return constant ? Number(constant) : null;
    };

    const width = dimension("width");
    const height = dimension("height");
    if (width && height && width >= 200 && height >= 200) return { width, height };
  }
  return null;
}

/** A viewport that matches the window, at enough pixels to fill a 1080p frame. */
export function windowViewport(size: { width: number; height: number }): Viewport {
  const dpr = Math.min(4, Math.max(2, Math.ceil(1440 / size.width)));
  return { name: "desktop", width: size.width, height: size.height, dpr };
}
