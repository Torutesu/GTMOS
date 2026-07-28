import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SdvError, shortSha } from "@sdv/core";
import { getProject } from "@sdv/db";
import type { StageContext } from "../context.ts";
import { stagePaths } from "../context.ts";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
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
    await fetchTarball(project.source_url, src, ctx);
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
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      const name = source.split("/").pop() ?? "";
      return !SKIP.has(name);
    },
  });
}

async function fetchTarball(url: string, to: string, ctx: StageContext): Promise<void> {
  const match = /github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/#?]+))?$/.exec(url);
  if (!match) throw new SdvError("SDV-E001", `unsupported repository url: ${url}`);
  const [, owner, repo, ref = "HEAD"] = match;
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;

  const res = await fetch(tarUrl);
  if (!res.ok) throw new SdvError("SDV-E001", `${tarUrl} returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new SdvError("SDV-E001", "archive exceeds 2GB");

  const tmp = join(ctx.workDir, "archive.tar.gz");
  await (await import("node:fs/promises")).writeFile(tmp, buf);
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
      if (SKIP.has(e.name)) continue;
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
      if (SKIP.has(e.name)) continue;
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
