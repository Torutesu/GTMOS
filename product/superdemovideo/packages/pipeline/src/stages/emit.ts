import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureManifest } from "@sdv/core";
import type { StageContext } from "../context.ts";

const PLAYER_DIST = fileURLToPath(new URL("../../../player/dist/player.js", import.meta.url));

export interface EmitOptions {
  bundleDir: string;
  manifest: CaptureManifest;
  outDir: string;
  seededData: boolean;
  cta: { label: string; url: string } | null;
}

export interface EmitResult {
  dir: string;
  files: string[];
  stepCount: number;
}

/**
 * Assemble the interactive demo from the same capture the video came from.
 *
 * Nothing is re-recorded here: the screens, the DOM and the target boxes were
 * all taken in one pass, so the demo and the film agree by construction rather
 * than by discipline. Only steps that actually ran are included — a hotspot
 * over an element that was never found is a dead end for the visitor.
 */
export async function emit(ctx: StageContext, opts: EmitOptions): Promise<EmitResult> {
  const out = opts.outDir;
  await mkdir(join(out, "steps"), { recursive: true });

  const usable = opts.manifest.steps.filter((s) => s.ok);
  const steps = usable.length > 0 ? usable : opts.manifest.steps;

  const demoSteps = [];
  for (const [i, step] of steps.entries()) {
    const dir = `steps/${String(i).padStart(3, "0")}`;
    await mkdir(join(out, dir), { recursive: true });
    await cp(join(opts.bundleDir, step.afterPng), join(out, dir, "screen.png"));
    let domRel: string | null = null;
    if (step.domJson) {
      await cp(join(opts.bundleDir, step.domJson), join(out, dir, "dom.json"));
      domRel = `${dir}/dom.json`;
    }
    demoSteps.push({
      index: i,
      caption: step.caption,
      hotspot: step.targetBox,
      screenshot: `${dir}/screen.png`,
      dom: domRel,
    });
  }

  // Page assets travel with the demo so the replay never calls the origin.
  let assets: Record<string, string> = {};
  if (opts.manifest.assetsManifest) {
    try {
      const recorded: Record<string, string> = JSON.parse(
        await readFile(join(opts.bundleDir, opts.manifest.assetsManifest), "utf8"),
      );
      assets = withPathAliases(recorded);
      await cp(join(opts.bundleDir, "assets"), join(out, "assets"), { recursive: true });
    } catch {
      ctx.log.warn("no page assets travelled with the capture");
    }
  }

  const manifest = {
    schemaVersion: 1 as const,
    title: opts.manifest.title,
    fidelity: "L2" as const,
    seededData: opts.seededData,
    cta: opts.cta,
    viewport: {
      width: opts.manifest.viewport.width,
      height: opts.manifest.viewport.height,
    },
    steps: demoSteps,
    assets,
  };
  await writeFile(join(out, "demo.json"), JSON.stringify(manifest, null, 2));

  await cp(PLAYER_DIST, join(out, "player.js")).catch(() => {
    throw new Error("player bundle is missing — run `pnpm build:player` first");
  });

  await writeFile(join(out, "index.html"), standalonePage(opts.manifest.title.en));

  ctx.log.info("interactive demo emitted", { steps: demoSteps.length });
  return {
    dir: out,
    files: ["demo.json", "player.js", "index.html"],
    stepCount: demoSteps.length,
  };
}

/**
 * Key each captured asset by every form the page might refer to it as.
 *
 * The network records absolute URLs; the markup almost always contains the
 * root-relative path instead. Rewriting only the absolute form leaves the
 * replay pointing at `/assets/…` on whatever host the demo is served from —
 * which in a sandboxed iframe is an opaque origin, so the stylesheet is
 * blocked and the demo renders as unstyled HTML. The bug is invisible in the
 * manifest and glaring on the screen.
 */
export function withPathAliases(recorded: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...recorded };
  for (const [url, local] of Object.entries(recorded)) {
    try {
      const parsed = new URL(url);
      out[`${parsed.pathname}${parsed.search}`] = local;
      out[`//${parsed.host}${parsed.pathname}${parsed.search}`] = local;
    } catch {
      /* not an absolute URL — the recorded key is already the only form */
    }
  }
  return out;
}

function standalonePage(title: string): string {
  const safe = title.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe}</title>
<style>
  body{margin:0;background:#07090c;color:#f2f5f7;
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  main{max-width:1080px;margin:0 auto;padding:36px 20px 60px}
  h1{font-size:22px;letter-spacing:-.01em;margin:0 0 4px}
  p.sub{color:#98a2ad;margin:0 0 22px;font-size:14px}
</style>
</head>
<body>
<main>
  <h1>${safe}</h1>
  <p class="sub">Click through the demo, or use the arrow keys.</p>
  <div data-demo="./demo.json"></div>
</main>
<script src="./player.js"></script>
</body>
</html>
`;
}
