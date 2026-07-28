import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildStandalone, placeholderFor } from "@sdv/pipeline";

let dir = "";
let html = "";

/**
 * The single-file export.
 *
 * A demo that needs a web server never leaves the machine that made it. This
 * checks the property that makes the export worth having: after opening the
 * file there is nothing left to fetch.
 */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdv-standalone-"));
  await mkdir(join(dir, "steps", "000"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(dir, "steps", "000", "screen.png"), png);
  await writeFile(
    join(dir, "steps", "000", "dom.json"),
    JSON.stringify({ html: "<body>hi</body>", styles: [], title: "t", url: "/", scroll: { x: 0, y: 0 }, viewport: { width: 1440, height: 900 } }),
  );
  await writeFile(join(dir, "assets", "asset-000.css"), "body{color:#111}");
  await writeFile(join(dir, "player.js"), "/* player */console.log(1<2);");
  await writeFile(
    join(dir, "demo.json"),
    JSON.stringify({
      schemaVersion: 1,
      // The captured page's own title lands in here, so it is untrusted.
      title: { en: "Invite </script><img src=x onerror=alert(1)>", ja: "招待" },
      fidelity: "L2",
      seededData: true,
      cta: { label: "Try it", url: "https://example.com" },
      viewport: { width: 1440, height: 900 },
      steps: [
        {
          index: 0,
          caption: { en: "Open your team", ja: "チームを開く" },
          hotspot: null,
          screenshot: "steps/000/screen.png",
          dom: "steps/000/dom.json",
        },
      ],
      assets: { "http://127.0.0.1:3100/x.css": "assets/asset-000.css" },
    }),
  );

  html = await buildStandalone(dir);
}, 30_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("standalone export", () => {
  it("leaves nothing to fetch", () => {
    // Every reference must be inline. `data:` is fine; a relative path is not.
    expect(html).not.toMatch(/steps\/000\/screen\.png/);
    expect(html).not.toMatch(/assets\/asset-000\.css/);
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("data:application/json;base64,");
    expect(html).toContain("data:text/css;base64,");
  });

  it("reads its manifest from the page instead of the network", () => {
    expect(html).toContain('data-demo="#sdv-manifest"');
    expect(html).toContain('id="sdv-manifest"');
    expect(html).toContain("/* player */");
  });

  it("cannot be broken out of by a title containing markup", () => {
    // Titles come from the captured page, so they are not ours to trust. A raw
    // </script> inside the JSON block would close it early and run whatever
    // followed, on whichever machine opened the file.
    const block = /<script type="application\/json" id="sdv-manifest">([\s\S]*?)<\/script>/.exec(
      html,
    );
    expect(block).not.toBeNull();
    expect(block![1]).not.toContain("</script>");
    expect(block![1]).toContain("\\u003c/script");
    // And the visible heading escapes it too.
    expect(html).not.toMatch(/<h1>[^<]*<img/);
  });
});

describe("environment placeholders", () => {
  it("gives display copy a value that can appear on screen", () => {
    expect(placeholderFor("VITE_WORKSPACE_NAME")).toBe("Northwind");
    expect(placeholderFor("NEXT_PUBLIC_COMPANY")).toBe("Northwind");
    expect(placeholderFor("SUPPORT_EMAIL")).toBe("hello@northwind.design");
  });

  it("keeps the obvious marker on anything that is not copy", () => {
    // A token rendered into the frame is a bug, and it should look like one.
    expect(placeholderFor("STRIPE_SECRET_KEY")).toMatch(/^sdv-placeholder-/);
    expect(placeholderFor("DATABASE_URL")).not.toMatch(/^sdv-placeholder-/);
    expect(placeholderFor("DATABASE_URL")).toBe("https://example.com");
  });
});
