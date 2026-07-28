import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { slug as newSlug } from "@sdv/core";
import { getPublicationByProject, listArtifacts, upsertPublication, type PublicationRow } from "@sdv/db";
import type { StageContext } from "../context.ts";

export interface PublishResult {
  slug: string;
  demoUrl: string;
  badgeUrl: string;
  files: string[];
}

/**
 * Make a run's output the live one.
 *
 * The published location is a stable alias and the swap is atomic, so the
 * embed code a customer pasted last month keeps working and starts showing
 * this run — and rolling back is the same operation pointed the other way.
 * That is the whole promise: the URL does not change, the demo does.
 */
export async function publish(
  ctx: StageContext,
  opts: { runId: string; gitSha: string | null; stagingDir: string },
): Promise<PublishResult> {
  const existing = await getPublicationByProject(ctx.db, ctx.projectId);
  const slug = existing?.alias_slug ?? newSlug();

  const artifacts = await listArtifacts(ctx.db, opts.runId);
  if (artifacts.length === 0) throw new Error("nothing to publish: the run produced no artifacts");

  const staging = join(opts.stagingDir, `publish-${slug}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // Assemble the exact tree that will go live, then swap it in one move.
  for (const artifact of artifacts) {
    const files = artifact.files as Record<string, string>;
    for (const [name, path] of Object.entries(files)) {
      if (name === "demoDir") {
        await cp(path, staging, { recursive: true });
      } else {
        await cp(path, join(staging, name)).catch(() => {});
      }
    }
  }

  await ctx.storage.swapDir(`published/${slug}`, staging);
  await rm(staging, { recursive: true, force: true });

  const row: PublicationRow = await upsertPublication(ctx.db, {
    projectId: ctx.projectId,
    slug,
    runId: opts.runId,
    artifactIds: artifacts.map((a) => a.id),
    syncedSha: opts.gitSha,
  });

  const files = await ctx.storage.list(`published/${slug}`);
  ctx.log.info("published", { slug, files: files.length, syncedSha: row.synced_sha });

  return {
    slug,
    demoUrl: `/d/${slug}`,
    badgeUrl: `/badge/${slug}.svg`,
    files,
  };
}

/**
 * The freshness badge.
 *
 * This is the visible half of the product's claim. A demo that has drifted
 * from the code says so on the customer's own README, which is the pressure
 * that makes anyone regenerate it.
 */
export function badgeSvg(opts: { synced: boolean; label: string }): string {
  const colour = opts.synced ? "#3ecf8e" : "#f5b544";
  const status = opts.synced ? opts.label : "stale";
  const left = "demo";
  const charW = 6.4;
  const leftW = Math.round(left.length * charW + 18);
  const rightW = Math.round(status.length * charW + 22);
  const total = leftW + rightW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${left}: ${status}">
  <title>${left}: ${status}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-color="#aaa" stop-opacity=".1"/><stop offset=".9" stop-opacity=".3"/><stop offset="1" stop-opacity=".5"/></linearGradient>
  <rect rx="3" width="${total}" height="20" fill="#20252e"/>
  <rect rx="3" x="${leftW}" width="${rightW}" height="20" fill="${colour}"/>
  <rect rx="3" width="${total}" height="20" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
    <text x="${leftW / 2}" y="14" fill="#c9d1da">${left}</text>
    <text x="${leftW + rightW / 2}" y="14" fill="#0b0f14" font-weight="600">${escapeXml(status)}</text>
  </g>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
