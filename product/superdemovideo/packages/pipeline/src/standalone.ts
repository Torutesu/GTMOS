import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

interface DemoManifest {
  title: { en: string; ja: string };
  steps: Array<{ screenshot: string; dom: string | null; [k: string]: unknown }>;
  assets?: Record<string, string>;
  [k: string]: unknown;
}

/**
 * Fold an emitted demo into one HTML file.
 *
 * A demo that needs a web server is a demo that never leaves the machine it
 * was made on. This version opens from a download, an email attachment or a
 * file:// URL, which is the difference between "we have a demo" and "here,
 * click this". Everything is inlined as a data URI; there is no request to
 * make and therefore nothing to break later.
 *
 * The cost is size — a few megabytes of base64 — so it is an export, not the
 * default. The hosted directory stays the thing you embed.
 */
export async function buildStandalone(demoDir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(demoDir, "demo.json"), "utf8"),
  ) as DemoManifest;

  const inline = async (rel: string): Promise<string> => {
    const buf = await readFile(join(demoDir, rel));
    const mime = MIME[extname(rel).toLowerCase()] ?? "application/octet-stream";
    return `data:${mime};base64,${buf.toString("base64")}`;
  };

  // Assets first: the DOM snapshots refer to them, and the snapshots are about
  // to be embedded whole.
  const assets: Record<string, string> = {};
  for (const [original, local] of Object.entries(manifest.assets ?? {})) {
    assets[original] = await inline(local).catch(() => local);
  }

  const steps = [];
  for (const step of manifest.steps) {
    steps.push({
      ...step,
      screenshot: await inline(step.screenshot),
      dom: step.dom ? await inline(step.dom) : null,
    });
  }

  const embedded = JSON.stringify({ ...manifest, steps, assets });
  const player = await readFile(join(demoDir, "player.js"), "utf8");
  const title = escapeHtml(manifest.title.en);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
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
  <h1>${title}</h1>
  <p class="sub">Click through the demo, or use the arrow keys.</p>
  <div data-demo="#sdv-manifest"></div>
</main>
<script type="application/json" id="sdv-manifest">${embedded
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}</script>
<script>${player}</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
