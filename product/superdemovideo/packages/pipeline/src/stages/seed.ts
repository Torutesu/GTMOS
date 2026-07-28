import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SdvError, type RepoProfile } from "@sdv/core";
import sharp from "sharp";
import type { StageContext } from "../context.ts";
import { stagePaths } from "../context.ts";
import { DESKTOP, launchBrowser, newContext, settle } from "../browser.ts";
import { retargetSession } from "../session.ts";

export type SeedStrategy = "e2e-fixtures" | "e2e-setup-run" | "none";

export interface SeedResult {
  strategy: SeedStrategy;
  storageState: unknown | null;
  /** Proportion of the first screen that is not background. */
  contentRatio: number;
}

const EMPTY_SCREEN_THRESHOLD = 0.02;

/**
 * Give the app a believable logged-in state before anything is filmed.
 *
 * The cheapest honest source of that state is the repository's own end-to-end
 * setup: it already knows how to sign in, and it is maintained by the people
 * who own the app. We reuse it rather than inventing a second login path.
 */
export async function seed(
  ctx: StageContext,
  profile: RepoProfile,
  baseUrl: string,
  entryRoute = "/",
): Promise<SeedResult> {
  const paths = stagePaths(ctx.workDir);
  const appDir = profile.appRoot ? join(paths.src, profile.appRoot) : paths.src;

  let storageState: unknown | null = null;
  let strategy: SeedStrategy = "none";

  const statePath = profile.e2e?.storageStatePath;
  if (statePath) {
    // 1. A committed storage state is deterministic and needs no browser.
    try {
      const raw = await readFile(join(appDir, statePath), "utf8");
      storageState = JSON.parse(raw);
      strategy = "e2e-fixtures";
      ctx.log.info("reused committed storage state", { statePath });
    } catch {
      // 2. Otherwise ask the repository's own setup project to produce one.
      const res = await ctx.sandbox.exec(
        `npx --no-install playwright test --project=setup --reporter=line`,
        { cwd: appDir, timeoutMs: 180_000, env: { BASE_URL: baseUrl } },
      );
      if (res.code === 0) {
        try {
          storageState = JSON.parse(await readFile(join(appDir, statePath), "utf8"));
          strategy = "e2e-setup-run";
          ctx.log.info("ran the e2e setup project for a session", { statePath });
        } catch {
          ctx.log.warn("setup project ran but produced no storage state");
        }
      } else {
        ctx.log.warn("could not run the e2e setup project; continuing signed out");
      }
    }
  }

  // Storage state is captured against the app's own origin. If the port moved
  // between the recording and this run, rewrite it so it still applies.
  if (storageState) storageState = retargetSession(storageState, baseUrl);

  const contentRatio = await measureFirstScreen(ctx, baseUrl, entryRoute, storageState);
  if (contentRatio < EMPTY_SCREEN_THRESHOLD) {
    throw new SdvError(
      "SDV-E040",
      `the first screen is ${(contentRatio * 100).toFixed(1)}% content — a demo of an empty app is worse than no demo`,
    );
  }

  await writeFile(
    join(paths.logs, "seed.json"),
    JSON.stringify({ strategy, contentRatio, entryRoute }, null, 2),
  );

  return { strategy, storageState, contentRatio };
}

/**
 * Look at the first screen and decide whether there is anything to film.
 *
 * Cheap proxy: how much of the viewport differs from the most common colour.
 * A skeleton, a spinner or an unauthenticated redirect all collapse toward a
 * single flat colour, and that is exactly the demo we refuse to ship.
 */
async function measureFirstScreen(
  ctx: StageContext,
  baseUrl: string,
  entryRoute: string,
  storageState: unknown | null,
): Promise<number> {
  const browser = await launchBrowser(ctx.cfg.chromiumPath);
  try {
    const context = await newContext(browser, {
      viewport: DESKTOP,
      baseUrl,
      storageState: storageState ?? undefined,
    });
    const page = await context.newPage();
    await page.goto(entryRoute, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settle(page, 400);
    const png = await page.screenshot({ type: "png" });
    await context.close();
    return await nonBackgroundRatio(png);
  } finally {
    await browser.close();
  }
}

export async function nonBackgroundRatio(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png)
    .resize(160, 100, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const counts = new Map<string, number>();
  const total = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    // Quantise so anti-aliasing does not read as content.
    const key = `${data[i]! >> 4},${data[i + 1]! >> 4},${data[i + 2]! >> 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let background = 0;
  for (const n of counts.values()) background = Math.max(background, n);
  return 1 - background / total;
}
