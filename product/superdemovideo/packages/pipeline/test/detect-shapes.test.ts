import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detect } from "@sdv/pipeline";
import { portInBlock, resolveScript } from "../src/stages/detect.ts";

/**
 * Repository shapes that detection got wrong in the field.
 *
 * Each of these is a real layout from a real project, reduced to the part
 * that broke us. They are written as shapes rather than as clones so the
 * lesson survives the repository changing — and so the suite does not need
 * the network.
 */

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function repo(files: Record<string, string | object>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "sdv-shape-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

describe("a workspace whose app is a top-level directory", () => {
  // Excalidraw: workspaces are ["excalidraw-app", "packages/*", "examples/*"],
  // the app is not under apps/, and vite is hoisted to the root so the app's
  // own dependencies mention only react.
  const shape = {
    "package.json": {
      name: "monorepo",
      private: true,
      workspaces: ["the-app", "packages/*", "examples/*"],
      devDependencies: { vite: "5.0.0" },
      scripts: { start: "yarn --cwd ./the-app start", build: "yarn --cwd ./the-app build" },
    },
    "the-app/package.json": {
      name: "the-app",
      dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      scripts: {
        start: "yarn && vite",
        build: "vite build",
        serve: "npx http-server build -p 5001",
      },
    },
    "the-app/index.html": "<!doctype html><div id=root></div>",
    "the-app/vite.config.mts": "export default { plugins: [] }",
    "packages/core/package.json": { name: "core", devDependencies: { vite: "5.0.0" } },
    "examples/with-nextjs/package.json": {
      name: "example",
      dependencies: { next: "15.0.0" },
      scripts: { start: "next start", dev: "next dev" },
    },
  };

  it("finds the app, not a package or an example", async () => {
    const profile = await detect(await repo(shape));
    expect(profile.appRoot).toBe("the-app");
  });

  it("still recognises the framework when the build tool is hoisted", async () => {
    // The app's own dependencies list react and nothing else. Reading only
    // those called this a folder of static files.
    const profile = await detect(await repo(shape));
    expect(profile.framework).toBe("vite");
  });

  it("takes the port from the script that runs, not the one that does not", async () => {
    // `serve` carries -p 5001 but nothing invokes it; `start` runs the Vite
    // dev server on 5173.
    const profile = await detect(await repo(shape));
    expect(profile.build.port).toBe(5173);
  });
});

describe("vite dev versus vite preview", () => {
  it("uses 5173 when the start script runs the dev server", async () => {
    const profile = await detect(
      await repo({
        "package.json": { name: "a", scripts: { start: "vite", build: "vite build" }, devDependencies: { vite: "5.0.0" } },
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.build.port).toBe(5173);
  });

  it("uses 4173 when it serves the build", async () => {
    const profile = await detect(
      await repo({
        "package.json": { name: "a", scripts: { start: "vite preview", build: "vite build" }, devDependencies: { vite: "5.0.0" } },
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.build.port).toBe(4173);
  });

  it("follows a start script that only forwards to another one", async () => {
    const profile = await detect(
      await repo({
        "package.json": {
          name: "a",
          scripts: { start: "npm run preview", preview: "vite preview --port 4300", build: "vite build" },
          devDependencies: { vite: "5.0.0" },
        },
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.build.port).toBe(4300);
  });
});

describe("confidence", () => {
  it("is low when the port had to be guessed", async () => {
    // No start script at all: we do not know where this listens, and saying
    // 0.95 anyway is how a wrong answer gets through without review.
    const profile = await detect(
      await repo({ "package.json": { name: "a", scripts: {} }, "index.html": "<!doctype html>" }),
    );
    expect(profile.build.port).toBeGreaterThan(0);
    expect(profile.confidence).toBeLessThan(0.6);
  });

  it("is high only when the port came from the repository itself", async () => {
    const profile = await detect(
      await repo({
        "package.json": {
          name: "a",
          scripts: { start: "vite preview --port 4321", build: "vite build" },
          devDependencies: { vite: "5.0.0" },
        },
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe("script resolution", () => {
  it("follows a chain and stops rather than looping", () => {
    const scripts = { start: "npm run dev", dev: "yarn serve", serve: "vite --port 3001" };
    expect(resolveScript(scripts, "start")).toBe("vite --port 3001");
    expect(resolveScript({ a: "npm run b", b: "npm run a" }, "a")).toBeTypeOf("string");
  });
});

describe("whether the production build is on the path to a demo", () => {
  it("skips it when the app is served by a dev server", async () => {
    // reveal.js: `start: vite` compiles on demand, while its build script is
    // `tsc && vite build` across seven configs — and it fails. Running it
    // turned a repository that starts in seconds into a failed run.
    const profile = await detect(
      await repo({
        "package.json": {
          name: "a",
          scripts: { start: "vite", build: "tsc && vite build && vite build -c other.ts" },
          devDependencies: { vite: "5.0.0" },
        },
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.build.build).toBeNull();
    expect(profile.build.port).toBe(5173);
  });

  it("keeps it when something has to serve the output", async () => {
    for (const [start, port] of [
      ["vite preview", 4173],
      ["next start", 3000],
    ] as const) {
      const profile = await detect(
        await repo({
          "package.json": {
            name: "a",
            scripts: { start, build: "vite build" },
            devDependencies: { vite: "5.0.0", next: "15.0.0" },
          },
          "index.html": "<!doctype html>",
        }),
      );
      expect(profile.build.build, start).not.toBeNull();
      expect(profile.build.port, start).toBe(port);
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });
});

describe("a port written as an expression in the config", () => {
  // reveal.js and Excalidraw both write
  // `port: Number(process.env.SOMETHING || 8000)`. Matching only a literal
  // assignment found nothing and fell through to a framework default, which
  // is how a repository whose dev server starts in a second failed to be
  // reached for ninety.
  const config = `
    import { defineConfig } from "vite";
    export default defineConfig({
      server: { port: Number(process.env.npm_config_port || 8000), open: true },
      preview: { port: 4999 },
      build: { outDir: "dist" },
    });`;

  it("reads the server block when a dev server is what starts", async () => {
    const profile = await detect(
      await repo({
        "package.json": { name: "a", scripts: { start: "vite" }, devDependencies: { vite: "5.0.0" } },
        "vite.config.ts": config,
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.build.port).toBe(8000);
  });

  it("reads the preview block when the build is what gets served", async () => {
    const profile = await detect(
      await repo({
        "package.json": {
          name: "a",
          scripts: { start: "vite preview", build: "vite build" },
          devDependencies: { vite: "5.0.0" },
        },
        "vite.config.ts": config,
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.build.port).toBe(4999);
  });

  it("ignores a name that merely ends in port", () => {
    // `npm_config_port ||` has no colon after it and must not be read as one.
    expect(portInBlock(`server: { port: Number(process.env.npm_config_port || 8000) }`, "server")).toBe(8000);
    expect(portInBlock(`server: { host: true }`, "server")).toBeNull();
    expect(portInBlock(`build: { outDir: "x" }`, "server")).toBeNull();
  });

  it("does not walk out of its own block", () => {
    const text = `server: { hmr: { port: 24678 } }, preview: { port: 4173 }`;
    expect(portInBlock(text, "preview")).toBe(4173);
  });
});
