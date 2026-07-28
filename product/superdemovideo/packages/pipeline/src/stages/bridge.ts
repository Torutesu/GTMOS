import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";

/**
 * What an Electron app's window expects to find waiting for it.
 *
 * An Electron renderer is already the HTML we want to film — it is a web page
 * that happens to be shown in a desktop window. The only reason it cannot be
 * opened in an ordinary browser is the bridge: `contextBridge.exposeInMainWorld`
 * hands it an object of functions backed by the main process, and without them
 * the first line of the app throws. KashinAI calls `window.api` twenty-five
 * times in one component.
 *
 * So we read the preload source, find what it promised to expose, and stand in
 * for it. Nothing here talks to a real main process; the point is a window
 * that renders, which is what a demo is.
 */
export interface BridgeSurface {
  /** Global name, e.g. `api` from `exposeInMainWorld("api", …)`. */
  namespace: string;
  methods: BridgeMethod[];
}

export interface BridgeMethod {
  name: string;
  /** A subscription returns an unsubscribe function; a call returns a value. */
  kind: "subscribe" | "call";
}

const PRELOAD_FILES = ["index.ts", "index.js", "preload.ts", "preload.js", "main.ts"];

/** Find the preload entry point without being told where it is. */
export async function findPreload(appDir: string): Promise<string | null> {
  for (const dir of ["src/preload", "electron/preload", "preload", "src/main/preload"]) {
    for (const file of PRELOAD_FILES) {
      const path = join(appDir, dir, file);
      if (await readFile(path, "utf8").then(() => true, () => false)) return path;
    }
  }
  for (const guess of ["src/preload.ts", "src/preload.js", "preload.js"]) {
    const path = join(appDir, guess);
    if (await readFile(path, "utf8").then(() => true, () => false)) return path;
  }
  return null;
}

/**
 * Read the preload source for the surface it exposes.
 *
 * Parsed rather than pattern-matched: the object handed to
 * `exposeInMainWorld` is usually a variable declared above it, and the method
 * names are the whole point. A name beginning `on` is treated as a
 * subscription because that is the near-universal convention for one, and
 * getting it wrong is visible immediately — the app registers a listener and
 * receives a value it cannot call.
 */
export function readBridgeSurface(source: string): BridgeSurface[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
    errorRecovery: true,
  });

  const objects = new Map<string, string[]>();
  const surfaces: BridgeSurface[] = [];

  const keysOf = (node: Node): string[] => {
    if (node.type !== "ObjectExpression") return [];
    const names: string[] = [];
    for (const prop of node.properties) {
      if (prop.type === "ObjectProperty" || prop.type === "ObjectMethod") {
        const key = prop.key;
        if (key.type === "Identifier") names.push(key.name);
        else if (key.type === "StringLiteral") names.push(key.value);
      }
    }
    return names;
  };

  walk(ast as unknown as Node, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const names = keysOf(node.init);
      if (names.length) objects.set(node.id.name, names);
    }

    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "exposeInMainWorld"
    ) {
      const [nameArg, valueArg] = node.arguments;
      if (!nameArg || nameArg.type !== "StringLiteral" || !valueArg) return;
      const names =
        valueArg.type === "Identifier"
          ? (objects.get(valueArg.name) ?? [])
          : keysOf(valueArg as Node);
      surfaces.push({
        namespace: nameArg.value,
        methods: names.map((name) => ({
          name,
          kind: /^on[A-Z]/.test(name) ? "subscribe" : "call",
        })),
      });
    }
  });

  return surfaces;
}

/**
 * The script that stands in for the bridge.
 *
 * Every call resolves; every subscription hands back an unsubscribe function.
 * The values are deliberately empty rather than invented: a run that needs
 * realistic data gets it from the seed stage, and a stand-in quietly making
 * up content would put things on screen that the product does not do.
 */
export function bridgeScript(surfaces: BridgeSurface[], seed: Record<string, unknown> = {}): string {
  const body = surfaces
    .map((surface) => {
      const entries = surface.methods
        .map((m) =>
          m.kind === "subscribe"
            ? `    ${JSON.stringify(m.name)}: function (fn) { return subscribe(${JSON.stringify(m.name)}, fn); }`
            : `    ${JSON.stringify(m.name)}: function () { return Promise.resolve(answer(${JSON.stringify(m.name)})); }`,
        )
        .join(",\n");
      return `  window[${JSON.stringify(surface.namespace)}] = {\n${entries}\n  };`;
    })
    .join("\n");

  return `(function () {
  // Stand-in for the Electron preload bridge, generated from the app's own
  // preload source. It exists so the renderer can run in a browser at all.
  var seed = ${JSON.stringify(seed)};

  // Listeners are kept per subscription, not in one pile. An app registers
  // several — onContext, onNavigate, onCollapsedChanged — and delivering a
  // context payload to the navigation handler would move the app somewhere
  // nobody asked for.
  var listeners = {};

  function subscribe(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
    return function () {
      listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; });
    };
  }

  function answer(name) {
    // Absent from the seed means we have nothing true to say. Returning null
    // rather than an empty object is deliberate: the app's own default stays
    // in place, where a made-up shape would overwrite it with blanks.
    return Object.prototype.hasOwnProperty.call(seed, name) ? seed[name] : null;
  }

${body}

  // How a flow step delivers an event the main process would normally send.
  // Without it the renderer is a still: every screen past the first one in an
  // Electron app is reached by the main process telling it to go there.
  window.__sdvBridge = {
    subscriptions: function () { return Object.keys(listeners); },
    emit: function (name, payload) {
      var fns = listeners[name] || [];
      for (var i = 0; i < fns.length; i++) fns[i](payload);
      return fns.length;
    },
  };

  // Electron's own helper is expected by most templates even when unused.
  window.electron = window.electron || {
    ipcRenderer: {
      send: function () {},
      on: function () { return function () {}; },
      invoke: function () { return Promise.resolve(null); },
    },
    process: { platform: "darwin", versions: {} },
  };
})();`;
}

/** Put the stand-in ahead of the app's own scripts in a built index.html. */
export function injectBridge(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return `${tag}\n${html}`;
}

/** Where electron-vite and friends leave the built renderer. */
export async function findRendererOutput(appDir: string): Promise<string | null> {
  const candidates = [
    "out/renderer",
    "dist/renderer",
    "build/renderer",
    ".vite/renderer",
    "dist",
    "out",
  ];
  for (const rel of candidates) {
    const dir = join(appDir, rel);
    const entries = await readdir(dir).catch(() => null);
    if (entries?.includes("index.html")) return dir;
  }
  return null;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  // Comments hang off nodes with a `type` of their own and are not worth
  // descending into; skipping them by key is cheaper than type-testing each.
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
