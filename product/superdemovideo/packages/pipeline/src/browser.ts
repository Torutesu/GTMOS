import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { SdvError, type Viewport } from "@sdv/core";

export const DESKTOP: Viewport = { name: "desktop", width: 1440, height: 900, dpr: 2 };
export const MOBILE: Viewport = { name: "mobile", width: 390, height: 844, dpr: 2 };

/**
 * Find a Chromium already present on this machine.
 *
 * Capture never downloads a browser. An explicit path wins; otherwise we scan
 * PLAYWRIGHT_BROWSERS_PATH, preferring a full Chromium over headless_shell
 * because the shell cannot produce the screenshots we need.
 */
export async function findChromium(explicit?: string | null): Promise<string> {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);

  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (root) {
    try {
      const dirs = (await readdir(root))
        .filter((x) => x.startsWith("chromium"))
        .sort((a, b) => {
          const shellA = a.includes("headless_shell") ? 1 : 0;
          const shellB = b.includes("headless_shell") ? 1 : 0;
          return shellA - shellB || b.localeCompare(a);
        });
      for (const d of dirs) {
        candidates.push(join(root, d, "chrome-linux", "chrome"));
        candidates.push(join(root, d, "chrome-linux", "headless_shell"));
        candidates.push(join(root, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"));
      }
    } catch {
      /* fall through to system paths */
    }
  }
  candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");

  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  throw new SdvError(
    "SDV-E050",
    "no Chromium found — set SDV_CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH",
  );
}

export async function launchBrowser(explicitPath?: string | null): Promise<Browser> {
  const executablePath = await findChromium(explicitPath);
  return chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-lcd-text",
      "--force-color-profile=srgb",
      // Deterministic frames: animations must not vary between runs.
      "--force-prefers-reduced-motion",
      "--hide-scrollbars",
    ],
  });
}

export async function newContext(
  browser: Browser,
  opts: { viewport: Viewport; baseUrl: string; storageState?: unknown },
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: opts.viewport.width, height: opts.viewport.height },
    deviceScaleFactor: opts.viewport.dpr,
    baseURL: opts.baseUrl,
    isMobile: opts.viewport.name === "mobile",
    hasTouch: opts.viewport.name === "mobile",
    reducedMotion: "reduce",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    storageState: (opts.storageState as never) ?? undefined,
  });
}

/** Settle the page: network quiet, fonts loaded, animations finished. */
export async function settle(page: import("playwright-core").Page, extraMs = 250): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page
    .evaluate(async () => {
      await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
      await Promise.all(
        document.getAnimations().map((a) => a.finished.catch(() => undefined)),
      );
    })
    .catch(() => {});
  await page.waitForTimeout(extraMs);
}
