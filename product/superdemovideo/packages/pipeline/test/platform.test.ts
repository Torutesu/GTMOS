import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detect, readBridgeSurface, bridgeScript, injectBridge } from "@sdv/pipeline";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function repo(files: Record<string, string | object>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "sdv-plat-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/**
 * What kind of thing the repository builds.
 *
 * Every demo is filmed as HTML in a browser whatever the app is, so the only
 * question the platform answers is how that HTML is obtained. It is separate
 * from the framework because an Electron app is built with Vite and an iOS app
 * has no JavaScript at all.
 */
describe("recognising the platform", () => {
  it("calls an Electron project what it is, not the bundler it uses", async () => {
    // KashinAI: electron-vite, so a framework check alone reports "vite" and
    // the pipeline goes looking for a web server that will never exist.
    const profile = await detect(
      await repo({
        "package.json": {
          name: "desktop",
          scripts: { start: "electron-vite preview", build: "electron-vite build" },
          devDependencies: { electron: "33.2.1", "electron-vite": "2.3.0", vite: "5.4.11" },
        },
        "electron.vite.config.ts": "export default {}",
      }),
    );
    expect(profile.platform).toBe("electron");
  });

  it("chooses the port for an Electron renderer instead of reading one", async () => {
    // We serve the renderer ourselves, so the port is not a discovery — and
    // `electron-vite preview` would otherwise be read as Vite's dev server.
    const profile = await detect(
      await repo({
        "package.json": {
          name: "desktop",
          scripts: { start: "electron-vite preview", build: "electron-vite build" },
          devDependencies: { electron: "33.2.1", "electron-vite": "2.3.0" },
        },
      }),
    );
    expect(profile.build.port).toBe(4180);
    expect(profile.build.build).not.toBeNull(); // the renderer we serve is what it emits
  });

  it("recognises an Android project with no package.json at all", async () => {
    const profile = await detect(
      await repo({
        "settings.gradle.kts": 'include(":app")',
        "gradlew": "#!/bin/sh",
        "app/src/main/AndroidManifest.xml": "<manifest/>",
      }),
    );
    expect(profile.platform).toBe("android");
  });

  it("tells iOS from macOS by what the project says it targets", async () => {
    const ios = await detect(
      await repo({
        "App.xcodeproj/project.pbxproj": "// project",
        "Package.swift": "let package = Package(platforms: [.iOS(.v17)])",
      }),
    );
    expect(ios.platform).toBe("ios");
    await rm(dir, { recursive: true, force: true });
    dir = "";

    const mac = await detect(
      await repo({
        "App.xcodeproj/project.pbxproj": "// project",
        "Package.swift": "let package = Package(platforms: [.macOS(.v14)])",
      }),
    );
    expect(mac.platform).toBe("macos");
  });

  it("leaves an ordinary web app alone", async () => {
    const profile = await detect(
      await repo({
        "package.json": {
          name: "site",
          scripts: { start: "vite preview", build: "vite build" },
          devDependencies: { vite: "5.0.0" },
        },
        "index.html": "<!doctype html>",
      }),
    );
    expect(profile.platform).toBe("web");
  });
});

/**
 * Standing in for the preload bridge.
 *
 * An Electron renderer is a web page; the only thing stopping it opening in a
 * browser is that `contextBridge.exposeInMainWorld` is not there to hand it
 * the functions it calls on its first line.
 */
describe("reading what a preload script exposes", () => {
  const preload = `
    import { contextBridge, ipcRenderer } from 'electron'
    const api = {
      captureContext: () => ipcRenderer.invoke('context:capture'),
      getSettings: () => ipcRenderer.invoke('settings:get'),
      onContextPushed: (cb) => { ipcRenderer.on('ctx', cb); return () => {} },
      onNavigate: (cb) => ipcRenderer.on('nav', cb),
    }
    contextBridge.exposeInMainWorld('api', api)
  `;

  it("finds the object even when it is declared above the call", () => {
    const [surface] = readBridgeSurface(preload);
    expect(surface!.namespace).toBe("api");
    expect(surface!.methods.map((m) => m.name)).toEqual([
      "captureContext",
      "getSettings",
      "onContextPushed",
      "onNavigate",
    ]);
  });

  it("treats an on-prefixed name as a subscription", () => {
    // A caller does `const off = api.onNavigate(fn)` and then calls `off()`.
    // Returning a promise there is an immediate crash.
    const [surface] = readBridgeSurface(preload);
    const kinds = Object.fromEntries(surface!.methods.map((m) => [m.name, m.kind]));
    expect(kinds["onNavigate"]).toBe("subscribe");
    expect(kinds["getSettings"]).toBe("call");
  });

  it("writes a stand-in that defines every name the app will reach for", () => {
    const script = bridgeScript(readBridgeSurface(preload));
    for (const name of ["captureContext", "getSettings", "onContextPushed"]) {
      expect(script).toContain(JSON.stringify(name));
    }
    expect(script).toContain('window["api"]');
    // Electron's own helper is expected by most templates even when unused.
    expect(script).toContain("ipcRenderer");
  });

  it("puts the stand-in ahead of the app's own scripts", () => {
    // After them is too late: the app runs on load and throws before it.
    const html = `<!doctype html><html><head><title>x</title></head><body><script src="/app.js"></script></body></html>`;
    const out = injectBridge(html, "/*bridge*/");
    expect(out.indexOf("/*bridge*/")).toBeLessThan(out.indexOf("/app.js"));
  });

  it("returns nothing rather than guessing when there is no bridge", () => {
    expect(readBridgeSurface("export const x = 1")).toEqual([]);
  });
});

/**
 * The stand-in as something a demo can drive.
 *
 * A renderer served on its own is a still: everything past the first screen in
 * an Electron app is reached by the main process telling it to go there. So the
 * stand-in keeps each subscription's listeners separately and exposes a way to
 * deliver an event to them.
 */
describe("driving the stand-in bridge", () => {
  const surfaces = readBridgeSurface(`
    import { contextBridge } from "electron";
    const api = {
      getSettings: () => ipcRenderer.invoke("settings:get"),
      onNavigate: (cb) => {},
      onContextPushed: (cb) => {},
    };
    contextBridge.exposeInMainWorld("api", api);
  `);

  function run(seed: Record<string, unknown> = {}): Record<string, any> {
    const window: Record<string, any> = {};
    new Function("window", bridgeScript(surfaces, seed))(window);
    return window;
  }

  it("delivers an event only to the subscription it belongs to", () => {
    const window = run();
    const navigated: unknown[] = [];
    const pushed: unknown[] = [];
    window.api.onNavigate((v: unknown) => navigated.push(v));
    window.api.onContextPushed((v: unknown) => pushed.push(v));

    expect(window.__sdvBridge.emit("onNavigate", "settings")).toBe(1);
    expect(navigated).toEqual(["settings"]);
    // A context payload arriving at the navigation handler would move the app
    // somewhere nobody asked for.
    expect(pushed).toEqual([]);
  });

  it("stops delivering after the app unsubscribes", () => {
    const window = run();
    const seen: unknown[] = [];
    const off = window.api.onNavigate((v: unknown) => seen.push(v));
    off();
    expect(window.__sdvBridge.emit("onNavigate", "settings")).toBe(0);
    expect(seen).toEqual([]);
  });

  it("answers a call from the seed, and with null when it has nothing true to say", async () => {
    // Null rather than an empty object on purpose: the app's own default stays
    // in place, where a made-up shape would overwrite it with blanks.
    const window = run({ getSettings: { appDisplayName: "KashinAI" } });
    await expect(window.api.getSettings()).resolves.toEqual({ appDisplayName: "KashinAI" });
    expect(await run().api.getSettings()).toBeNull();
  });
});
