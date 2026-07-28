import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { SdvError, type Platform } from "@sdv/core";
import type { StageContext } from "../context.ts";

/**
 * Render a native app's screens as HTML.
 *
 * A macOS, iOS or Android app has no web page to point a browser at. But its
 * screens are declared, not drawn: SwiftUI, Jetpack Compose and Android XML
 * all describe a hierarchy of labelled controls, which is the same shape as a
 * document. Turning that description into HTML gives the rest of the pipeline
 * exactly what it already knows how to work with — a page with real text, real
 * controls and real accessibility roles, on a port.
 *
 * What this is and is not: it is a faithful rendition of the screens the source
 * declares, laid out in a device frame. It is not a screenshot of the app, and
 * it is not a running build. A control that only exists at runtime will not
 * appear, and neither will anything the source does not say.
 */

export interface NativeScreen {
  /** Route the flow navigates to, e.g. `/settings`. */
  path: string;
  /** What the screen is called in the source, for the candidate list and captions. */
  title: string;
  /** Source file this came from, so a person can check the rendition. */
  source: string;
  html: string;
}

export interface RenderNativeResult {
  dir: string;
  screens: NativeScreen[];
  port: number;
}

const UI_EXTENSIONS: Record<Platform, string[]> = {
  macos: [".swift"],
  ios: [".swift", ".m", ".mm"],
  android: [".kt", ".java", ".xml"],
  web: [],
  electron: [],
};

const MAX_FILES = 40;
const MAX_BYTES_PER_FILE = 24_000;

/**
 * Collect the files that describe the interface.
 *
 * Everything else in a native project — networking, persistence, the model —
 * says nothing about what a screen looks like, and sending it would crowd out
 * what does. A file counts when it declares a view.
 */
export async function collectUiSource(
  root: string,
  platform: Platform,
): Promise<Array<{ path: string; text: string }>> {
  const extensions = UI_EXTENSIONS[platform];
  if (extensions.length === 0) return [];

  const declares =
    platform === "android"
      ? /@Composable|setContentView|<androidx\.|<LinearLayout|<ConstraintLayout/
      : /:\s*View\b|struct\s+\w+\s*:\s*View|UIViewController|NSViewController/;

  const found: Array<{ path: string; text: string; score: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || found.length > 400) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!extensions.includes(extname(entry.name))) continue;
      const text = await readFile(path, "utf8").catch(() => "");
      if (!text || !declares.test(text)) continue;
      // A screen is usually bigger than a single reusable control, and the
      // ones worth demonstrating are bigger still.
      found.push({ path, text: text.slice(0, MAX_BYTES_PER_FILE), score: text.length });
    }
  };
  await walk(root, 0);

  found.sort((a, b) => b.score - a.score);
  return found.slice(0, MAX_FILES).map(({ path, text }) => ({ path: relative(root, path), text }));
}

const SKIP = new Set([
  "node_modules",
  "build",
  "Build",
  "DerivedData",
  "Pods",
  ".gradle",
  ".git",
  "Carthage",
]);

/**
 * Turn the UI source into a servable site.
 *
 * One page per screen plus an index, written into the run's working
 * directory. The static server the build stage would have started for a web
 * app serves this instead, so seed, capture, compose and emit are reached
 * unchanged — which is the entire reason for rendering to HTML rather than
 * driving a simulator.
 */
export type NativePlatform = Extract<Platform, "macos" | "ios" | "android">;

export function isNativePlatform(p: Platform): p is NativePlatform {
  return p === "macos" || p === "ios" || p === "android";
}

export async function renderNative(
  ctx: StageContext,
  opts: { srcDir: string; platform: NativePlatform; outDir: string; port: number },
): Promise<RenderNativeResult> {
  const files = await collectUiSource(opts.srcDir, opts.platform);
  if (files.length === 0) {
    throw new SdvError(
      "SDV-E012",
      `found no ${opts.platform} interface source to render — looked for view declarations under ${opts.srcDir}`,
    );
  }

  ctx.progress({
    stage: "build",
    status: "running",
    message: `Rendering ${files.length} ${opts.platform} view file(s) as HTML`,
  });

  const screens = await ctx.llm.renderScreens({
    platform: opts.platform,
    files,
  });
  if (screens.length === 0) {
    throw new SdvError("SDV-E012", "the interface source produced no screens");
  }

  await mkdir(opts.outDir, { recursive: true });
  for (const screen of screens) {
    const rel = screen.path === "/" ? "index.html" : `${screen.path.replace(/^\//, "")}.html`;
    const path = join(opts.outDir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, screen.html);
  }

  // A visitor arriving at / must land somewhere real even when no screen
  // claimed the root path.
  if (!screens.some((s) => s.path === "/")) {
    await writeFile(join(opts.outDir, "index.html"), screens[0]!.html);
  }

  // The manifest is what lets the production phase serve exactly what the
  // candidates were built from. Rendering again there would cost a second
  // model call and, on the live path, would not come back the same — the demo
  // would then be filmed against pages nobody chose.
  await writeFile(
    join(opts.outDir, MANIFEST),
    JSON.stringify({ platform: opts.platform, screens }, null, 2),
  );

  ctx.log.info("rendered native screens", {
    platform: opts.platform,
    screens: screens.map((s) => s.path).join(" "),
  });

  return { dir: opts.outDir, screens, port: opts.port };
}

/** What an earlier stage already rendered into this directory, if anything. */
export async function readRendered(outDir: string): Promise<NativeScreen[] | null> {
  const raw = await readFile(join(outDir, MANIFEST), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { screens?: NativeScreen[] };
    return parsed.screens?.length ? parsed.screens : null;
  } catch {
    return null;
  }
}

const MANIFEST = "screens.json";

/**
 * The command that serves what was rendered.
 *
 * No single-page fallback: each screen is its own file, and rewriting every
 * unmatched path to the first screen would turn a mistyped route into a demo
 * that silently films the wrong page.
 */
export function serveNativeCommand(dir: string, port: number): string {
  return `npx --yes serve -l ${port} ${JSON.stringify(dir)}`;
}
