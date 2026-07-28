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

  const screen = await measureFirstScreen(ctx, baseUrl, entryRoute, storageState);
  if (!isWorthFilming(screen)) {
    throw new SdvError(
      "SDV-E040",
      `the first screen is ${(screen.contentRatio * 100).toFixed(1)}% content with ` +
        `${screen.elements} laid-out elements and ${screen.characters} characters of text — ` +
        `a demo of an empty app is worse than no demo`,
    );
  }
  if (screen.contentRatio < EMPTY_SCREEN_THRESHOLD) {
    ctx.log.info("first screen is sparse but real", { ...screen });
  }

  await writeFile(
    join(paths.logs, "seed.json"),
    JSON.stringify({ strategy, entryRoute, ...screen }, null, 2),
  );

  return { strategy, storageState, contentRatio: screen.contentRatio };
}

export interface FirstScreen {
  contentRatio: number;
  /** Rendered elements of a meaningful size, and how much text they carry. */
  elements: number;
  characters: number;
}

/**
 * Look at the first screen and decide whether there is anything to film.
 *
 * Two measurements, because either one alone is wrong.
 *
 * Ink coverage catches a spinner, a skeleton or a redirect to a login page —
 * they all collapse toward one flat colour. But it also condemns a page that
 * is sparse on purpose: reveal.js opens on a black slide carrying the words
 * "Slide 1", which is half a percent of the viewport and a perfectly good
 * first frame. So the structure of the page gets a vote. A rendered app has
 * laid-out elements and text in them; a failed one has neither, whatever its
 * background colour.
 */
async function measureFirstScreen(
  ctx: StageContext,
  baseUrl: string,
  entryRoute: string,
  storageState: unknown | null,
): Promise<FirstScreen> {
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

    const structure = await page.evaluate(() => {
      let elements = 0;
      let characters = 0;
      for (const el of Array.from(document.body?.querySelectorAll("*") ?? [])) {
        const box = el.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) continue;
        if (box.top > window.innerHeight || box.left > window.innerWidth) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
          continue;
        }
        elements++;
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === 3) characters += (node.textContent ?? "").trim().length;
        }
      }
      return { elements, characters };
    });

    const png = await page.screenshot({ type: "png" });
    await context.close();
    return { contentRatio: await nonBackgroundRatio(png), ...structure };
  } finally {
    await browser.close();
  }
}

/**
 * Whether the first screen is worth filming.
 *
 * Ink alone is not enough evidence to refuse. A page only fails when it is
 * both visually empty and structurally empty — nothing laid out and nothing
 * to read.
 */
export function isWorthFilming(
  screen: FirstScreen,
  inkThreshold = EMPTY_SCREEN_THRESHOLD,
): boolean {
  if (screen.contentRatio >= inkThreshold) return true;
  return screen.elements >= 5 && screen.characters >= 12;
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
