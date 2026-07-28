import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SdvError, shortSha } from "@sdv/core";
import { getProject } from "@sdv/db";
import type { StageContext } from "../context.ts";
import { stagePaths } from "../context.ts";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

/** Never source, always large. Skipped whatever the repository says. */
const ALWAYS_SKIP = new Set(["node_modules", ".git"]);

/**
 * Names that usually mean generated output — but only usually.
 *
 * reveal.js keeps `build/dts-paths.ts` in version control and imports it from
 * its vite config. Deleting the directory on the strength of its name left a
 * config that could not load, and the dev server never came up: a failure
 * that looked like the repository's and was entirely ours. So a directory
 * here is only dropped when the repository's own .gitignore says it is
 * generated.
 */
const PROBABLY_OUTPUT = new Set([
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".astro",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  "test-results",
  "playwright-report",
]);

export interface IngestResult {
  srcDir: string;
  gitSha: string;
  bytes: number;
}

/**
 * Bring the repository into this run's scratch space.
 *
 * The copy is deliberate: later stages install and build, and neither should
 * be able to touch the caller's checkout. Build output and dependency trees
 * are skipped so the source we reason about is the source in version control.
 */
export async function ingest(ctx: StageContext): Promise<IngestResult> {
  const project = await getProject(ctx.db, ctx.projectId);
  if (!project) throw new SdvError("SDV-E001", "project not found");

  const { src } = stagePaths(ctx.workDir);
  await rm(src, { recursive: true, force: true });
  await mkdir(src, { recursive: true });

  ctx.progress({ stage: "ingest", status: "running", message: `Reading ${project.source_url}` });

  if (project.source_kind === "local") {
    await copyTree(project.source_url, src);
  } else {
    await fetchRemote(project.source_url, src, ctx);
  }

  const bytes = await dirSize(src);
  if (bytes > MAX_BYTES) {
    throw new SdvError("SDV-E001", `repository is ${(bytes / 1e9).toFixed(1)}GB, limit is 2GB`);
  }

  // A content hash stands in for a commit sha on local sources, which is what
  // lets regeneration notice a change without a git remote.
  const gitSha = await contentHash(src);

  ctx.log.info("ingested", { bytes, gitSha });
  return { srcDir: src, gitSha, bytes };
}

async function copyTree(from: string, to: string): Promise<void> {
  try {
    await stat(from);
  } catch {
    throw new SdvError("SDV-E001", `no such path: ${from}`);
  }
  const skip = await skipPredicate(from);
  await cp(from, to, {
    recursive: true,
    filter: (source) => !skip(source.split("/").pop() ?? ""),
  });
}

/**
 * Which directory names to drop, according to the repository.
 *
 * The .gitignore is the only authority on what is generated here. Without one
 * we fall back to the conventional names, which is a guess — but a guess made
 * where there is nothing better to go on, rather than in preference to an
 * answer sitting in the repository root.
 */
async function skipPredicate(root: string): Promise<(name: string) => boolean> {
  const ignored = await ignoredNames(root);
  if (ignored === null) {
    return (name) => ALWAYS_SKIP.has(name) || PROBABLY_OUTPUT.has(name);
  }
  return (name) => ALWAYS_SKIP.has(name) || (PROBABLY_OUTPUT.has(name) && ignored.has(name));
}

async function ignoredNames(root: string): Promise<Set<string> | null> {
  let text: string;
  try {
    text = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    // Only whole-directory rules matter here: `dist/`, `/dist`, `dist`.
    // A rule aimed at a file inside one (`dist/reveal.es5.js`) leaves the
    // directory itself tracked, which is precisely the distinction that got
    // reveal.js's source deleted.
    const cleaned = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (cleaned && !cleaned.includes("/") && !cleaned.includes("*")) names.add(cleaned);
  }
  return names;
}

/**
 * Fetch a remote repository.
 *
 * `git clone` first, because it is what actually works: it follows the
 * machine's git configuration, so credentials, proxies and enterprise hosts
 * are already handled, and it is not limited to GitHub. The archive download
 * stays as a fallback for a machine with no git, but it is the narrower path —
 * on this one it is refused outright by the egress proxy.
 */
async function fetchRemote(url: string, to: string, ctx: StageContext): Promise<void> {
  const clone = await ctx.sandbox.exec(
    `git clone --depth 1 --quiet ${JSON.stringify(url)} ${JSON.stringify(to)}`,
    { cwd: to, timeoutMs: 300_000 },
  );
  if (clone.code === 0) {
    ctx.log.info("cloned", { url });
    await rm(join(to, ".git"), { recursive: true, force: true });
    return;
  }

  ctx.log.warn("clone failed, trying the archive instead", {
    detail: tailOf(clone.combined),
  });
  await fetchTarball(url, to, ctx, clone.combined);
}

function tailOf(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

async function fetchTarball(
  url: string,
  to: string,
  ctx: StageContext,
  cloneError = "",
): Promise<void> {
  const match = /github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/#?]+))?$/.exec(url);
  if (!match) {
    throw new SdvError(
      "SDV-E001",
      `could not clone ${url}${cloneError ? `: ${tailOf(cloneError)}` : ""}`,
    );
  }
  const [, owner, repo, ref = "HEAD"] = match;
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;

  const res = await fetch(tarUrl);
  if (!res.ok) {
    throw new SdvError(
      "SDV-E001",
      `neither clone nor archive worked. git said: ${tailOf(cloneError) || "n/a"}. ` +
        `${tarUrl} returned ${res.status}.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new SdvError("SDV-E001", "archive exceeds 2GB");

  const tmp = join(ctx.workDir, "archive.tar.gz");
  await writeFile(tmp, buf);
  const result = await ctx.sandbox.exec(`tar -xzf ${JSON.stringify(tmp)} --strip-components=1`, {
    cwd: to,
    timeoutMs: 120_000,
  });
  await rm(tmp, { force: true });
  if (result.code !== 0) throw new SdvError("SDV-E001", `extract failed: ${result.combined.slice(-500)}`);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await stat(p)).size;
    }
  };
  await walk(dir);
  return total;
}

/** Stable hash over relative paths plus sizes and mtimes — cheap and adequate. */
async function contentHash(dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (d: string, prefix: string) => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, rel);
      else if (e.isFile()) {
        const s = await stat(p);
        parts.push(`${rel}:${s.size}`);
      }
    }
  };
  await walk(dir, "");
  return shortSha(parts.join("\n"));
}
