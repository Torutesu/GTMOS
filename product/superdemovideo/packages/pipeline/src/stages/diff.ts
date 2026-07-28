import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { DiffReport, type CaptureManifest } from "@sdv/core";
import { insertDiff } from "@sdv/db";
import type { StageContext } from "../context.ts";

/**
 * How much of a screen has to move before we call it changed.
 *
 * A rewritten line of body copy measures about 0.2% of the screen, and that
 * is exactly the change this product exists to catch: the caption describing
 * that screen may now be describing something the app no longer says.
 *
 * Two renders of a deterministically seeded app measure exactly zero, so
 * there is no noise floor to clear. The threshold's job is only to ignore
 * incidental differences — a caret, a scrollbar — not to demand that a change
 * be large. 0.05% of 960×600 is under three hundred pixels: far more than any
 * stray artefact, far less than a sentence.
 */
const CHANGED_THRESHOLD = 0.0005;

/**
 * Resolution the comparison runs at.
 *
 * Small enough to stay cheap per step, large enough that text survives the
 * downscale as something other than grey mush. At 480×300 a changed sentence
 * was indistinguishable from no change at all.
 */
const COMPARE_SIZE = { width: 960, height: 600 };

export const DIFF_TUNING = { changedThreshold: CHANGED_THRESHOLD, compareSize: COMPARE_SIZE };

/**
 * Compare this regeneration against the published one.
 *
 * Regeneration without review would be worse than staleness: a UI change can
 * turn a working demo into a confident lie, and nobody would see it happen.
 * The diff exists so a person approves the new version knowing exactly which
 * steps moved and which stopped resolving.
 */
export async function diff(
  ctx: StageContext,
  opts: {
    baseRunId: string;
    baseDir: string;
    baseManifest: CaptureManifest;
    newDir: string;
    newManifest: CaptureManifest;
  },
): Promise<DiffReport> {
  const steps: DiffReport["steps"] = [];

  const count = Math.max(opts.baseManifest.steps.length, opts.newManifest.steps.length);
  for (let i = 0; i < count; i++) {
    const before = opts.baseManifest.steps[i];
    const after = opts.newManifest.steps[i];

    if (!after) {
      steps.push({
        index: i,
        caption: before?.caption ?? null,
        diffRatio: 1,
        changed: true,
        status: "removed",
      });
      continue;
    }
    if (!before) {
      steps.push({ index: i, caption: after.caption, diffRatio: 1, changed: true, status: "added" });
      continue;
    }

    if (!after.ok) {
      steps.push({
        index: i,
        caption: after.caption,
        diffRatio: 1,
        changed: true,
        status: "broken",
      });
      continue;
    }

    const ratio = await pixelDiff(
      join(opts.baseDir, before.afterPng),
      join(opts.newDir, after.afterPng),
    );
    steps.push({
      index: i,
      caption: after.caption,
      // Five places: a changed sentence is a fraction of a percent, and
      // rounding it to two would report it as zero.
      diffRatio: Number(ratio.toFixed(5)),
      changed: ratio > CHANGED_THRESHOLD,
      status: "ok",
    });
  }

  const changedCount = steps.filter((s) => s.changed).length;
  const brokenCount = steps.filter((s) => s.status === "broken").length;

  const report = DiffReport.parse({
    schemaVersion: 1,
    baseRunId: opts.baseRunId,
    runId: ctx.runId,
    steps,
    changedCount,
    brokenCount,
    summary: summarise(changedCount, brokenCount, steps.length),
  });

  await insertDiff(ctx.db, { runId: ctx.runId, baseRunId: opts.baseRunId, report });
  ctx.log.info("diff computed", { changedCount, brokenCount });
  return report;
}

function summarise(changed: number, broken: number, total: number): string {
  if (broken > 0) {
    return `${broken} of ${total} steps no longer resolve, and ${changed} changed visually. Review before publishing.`;
  }
  if (changed === 0) return `Nothing changed across ${total} steps.`;
  return `${changed} of ${total} steps changed visually. Every step still runs.`;
}

/**
 * Proportion of pixels that differ.
 *
 * Both frames are normalised to the same size first, so two captures taken at
 * different viewport scales still compare cleanly. Anti-aliasing is excluded:
 * without that, re-rendering identical text on a different day registers as a
 * change and every diff report becomes noise.
 */
export async function pixelDiff(aPath: string, bPath: string): Promise<number> {
  const size = COMPARE_SIZE;
  const [a, b] = await Promise.all([normalise(aPath, size), normalise(bPath, size)]);
  const out = new PNG({ width: size.width, height: size.height });
  const differing = pixelmatch(a.data, b.data, out.data, size.width, size.height, {
    threshold: 0.12,
    includeAA: false,
  });
  return differing / (size.width * size.height);
}

async function normalise(path: string, size: { width: number; height: number }): Promise<PNG> {
  const buf = await readFile(path);
  const raw = await sharp(buf)
    .resize(size.width, size.height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const png = new PNG({ width: size.width, height: size.height });
  raw.copy(png.data);
  return png;
}
