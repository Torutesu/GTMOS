#!/usr/bin/env tsx
/**
 * Environment check. Everything Superdemovideo needs must already be on the
 * machine — this run never downloads a browser or starts a container.
 */
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "@sdv/core";

const exec = promisify(execFile);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fatal: boolean;
}

/**
 * Check the machine, return the findings.
 *
 * This returns rather than prints so the CLI and the acceptance script can
 * both assert on the same list instead of parsing console output.
 */
export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fatal = true) =>
    checks.push({ name, ok, detail, fatal });
  const cfg = loadConfig();

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  add("node >= 22", major >= 22, `found ${process.versions.node}`);

  // pnpm
  try {
    const { stdout } = await exec("pnpm", ["--version"]);
    add("pnpm", true, `v${stdout.trim()}`);
  } catch {
    add("pnpm", false, "not on PATH");
  }

  // ffmpeg (bundled binary)
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default: string | null };
    const bin = mod.default;
    if (bin) {
      await access(bin, constants.X_OK);
      const { stdout } = await exec(bin, ["-version"]);
      add("ffmpeg", true, stdout.split("\n")[0]?.slice(0, 60) ?? bin);
    } else {
      add("ffmpeg", false, "ffmpeg-static resolved to null");
    }
  } catch (e) {
    add("ffmpeg", false, `ffmpeg-static unusable: ${(e as Error).message}`);
  }

  // sharp
  try {
    const sharp = (await import("sharp")).default;
    const buf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    add("sharp", buf.length > 0, `renders png (${buf.length}B)`);
  } catch (e) {
    add("sharp", false, (e as Error).message);
  }

  // Chromium
  const chromium = await findChromium(cfg.chromiumPath);
  add("chromium", chromium !== null, chromium ?? "no browser found — set SDV_CHROMIUM_PATH");

  // var dir writable
  try {
    await mkdir(cfg.varDir, { recursive: true });
    const probe = join(cfg.varDir, ".doctor-probe");
    await writeFile(probe, "ok");
    await rm(probe);
    add("var dir writable", true, cfg.varDir);
  } catch (e) {
    add("var dir writable", false, (e as Error).message);
  }

  // Embedded database
  try {
    const { openDb, migrate } = await import("@sdv/db");
    const dir = join(cfg.varDir, "db-doctor");
    const db = await openDb({ databaseUrl: null, dbDir: dir });
    await migrate(db);
    await db.close();
    await rm(dir, { recursive: true, force: true });
    add("embedded postgres", true, "PGlite migrates cleanly");
  } catch (e) {
    add("embedded postgres", false, (e as Error).message);
  }

  // LLM mode
  if (cfg.llmMode === "live") {
    add("anthropic key", cfg.anthropicApiKey !== null, cfg.anthropicApiKey ? "present" : "missing");
  } else {
    add("llm mode", true, "mock (no key or network needed)", false);
  }

  return checks;
}

/** Print the findings and return whether anything required failed. */
export function reportDoctor(checks: Check[]): boolean {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.fatal ? "FAIL" : "warn";
    console.log(`${mark}  ${c.name.padEnd(width)}  ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok && c.fatal);
  if (failed.length > 0) {
    console.error(`\n${failed.length} required check(s) failed.`);
    return false;
  }
  console.log("\nAll required checks passed.");
  return true;
}

/** Locate a Chromium binary without ever triggering a download. */
export async function findChromium(explicit: string | null): Promise<string | null> {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);

  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (root) {
    try {
      const entries = await readdir(root);
      // Prefer a full Chromium over headless_shell: the shell cannot take
      // full-page screenshots with the same fidelity we need for capture.
      const dirs = entries
        .filter((x) => x.startsWith("chromium"))
        .sort((a, b) => {
          const shellA = a.includes("headless_shell") ? 1 : 0;
          const shellB = b.includes("headless_shell") ? 1 : 0;
          return shellA - shellB || b.localeCompare(a);
        });
      for (const e of dirs) {
        candidates.push(join(root, e, "chrome-linux", "chrome"));
        candidates.push(join(root, e, "chrome-linux", "headless_shell"));
        candidates.push(join(root, e, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"));
      }
    } catch {
      /* directory unreadable — fall through to the system paths */
    }
  }
  candidates.push(
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );

  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDoctor()
    .then((checks) => process.exit(reportDoctor(checks) ? 0 : 1))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
