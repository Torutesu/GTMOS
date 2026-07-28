import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, Response } from "playwright-core";
import {
  CaptureManifest,
  SdvError,
  nowIso,
  type Box,
  type CaptureStep,
  type Flow,
  type Step,
  type Target,
  type Viewport,
} from "@sdv/core";
import type { StageContext } from "../context.ts";
import { DESKTOP, launchBrowser, newContext, settle } from "../browser.ts";
import { retargetSession } from "../session.ts";

const STEP_TIMEOUT_MS = 15_000;

export interface CaptureOptions {
  baseUrl: string;
  flow: Flow;
  useCaseId: string;
  storageState: unknown | null;
  viewport?: Viewport;
  outDir: string;
  /** Collect DOM snapshots and page assets. Off for the mobile pass. */
  withDom?: boolean;
}

export interface CaptureOutcome {
  manifest: CaptureManifest;
  dir: string;
  brokenSteps: number[];
}

/**
 * Drive the flow against the running app and record it twice over.
 *
 * Pixels alone give a video but nothing to click; structure alone gives an
 * interactive replica with no motion. Taking both in the same pass is what
 * lets one run produce a film and a playable demo that agree with each other
 * frame for frame — and it is why the executor, not a person with a browser
 * extension, has to be the one holding the camera.
 */
export async function capture(ctx: StageContext, opts: CaptureOptions): Promise<CaptureOutcome> {
  const viewport = opts.viewport ?? DESKTOP;
  const withDom = opts.withDom ?? viewport.name === "desktop";
  const dir = opts.outDir;
  await mkdir(join(dir, "steps"), { recursive: true });
  await mkdir(join(dir, "assets"), { recursive: true });

  const browser = await launchBrowser(ctx.cfg.chromiumPath);
  const assets = new Map<string, string>();
  const steps: CaptureStep[] = [];
  const broken: number[] = [];

  try {
    const context = await newContext(browser, {
      viewport,
      baseUrl: opts.baseUrl,
      storageState: retargetSession(opts.storageState, opts.baseUrl) ?? undefined,
    });

    if (withDom) await collectAssets(context, dir, assets);

    const page = await context.newPage();
    await installCursorTracking(page);

    for (const [index, step] of opts.flow.steps.entries()) {
      const stepDir = join(dir, "steps", String(index).padStart(3, "0"));
      await mkdir(stepDir, { recursive: true });
      const started = Date.now();

      ctx.progress({
        stage: "capture",
        status: "running",
        message: `Step ${index + 1}/${opts.flow.steps.length}: ${step.do}`,
      });

      const before = await page.screenshot({ type: "png" });
      await writeFile(join(stepDir, "before.png"), before);

      let ok = true;
      let errorCode: string | null = null;
      let targetBox: Box | null = null;
      let clickPoint: { x: number; y: number } | null = null;

      try {
        const located = await resolveTarget(page, step);
        if (located) {
          targetBox = await boxOf(located, viewport.dpr);
          if (targetBox) {
            clickPoint = { x: targetBox.x + targetBox.w / 2, y: targetBox.y + targetBox.h / 2 };
          }
        }
        await performStep(page, step, located);
      } catch (err) {
        // One retry: a step that lost a race with a re-render usually wins the
        // second time, and a real break still fails twice.
        try {
          await page.waitForTimeout(600);
          const located = await resolveTarget(page, step);
          if (located) {
            targetBox = await boxOf(located, viewport.dpr);
            if (targetBox) {
              clickPoint = { x: targetBox.x + targetBox.w / 2, y: targetBox.y + targetBox.h / 2 };
            }
          }
          await performStep(page, step, located);
        } catch (retryErr) {
          ok = false;
          errorCode = "SDV-E050";
          broken.push(index);
          ctx.log.warn(`step ${index} could not run`, {
            step: step.do,
            reason: (retryErr as Error).message.split("\n")[0],
          });
        }
      }

      await settle(page, 200);
      const after = await page.screenshot({ type: "png" });
      await writeFile(join(stepDir, "after.png"), after);

      let domRel: string | null = null;
      if (withDom) {
        const dom = await snapshotDom(page);
        if (dom) {
          await writeFile(join(stepDir, "dom.json"), JSON.stringify(dom));
          domRel = `steps/${String(index).padStart(3, "0")}/dom.json`;
        }
      }

      steps.push({
        index,
        do: step.do,
        caption: step.caption ?? null,
        beforePng: `steps/${String(index).padStart(3, "0")}/before.png`,
        afterPng: `steps/${String(index).padStart(3, "0")}/after.png`,
        domJson: domRel,
        targetBox,
        clickPoint,
        durationMs: Date.now() - started,
        ok,
        errorCode,
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  if (withDom) {
    await writeFile(
      join(dir, "assets", "manifest.json"),
      JSON.stringify(Object.fromEntries(assets), null, 2),
    );
  }

  // A capture where nothing resolved is not a thin demo, it is a wrong one.
  if (broken.length === opts.flow.steps.length) {
    throw new SdvError("SDV-E050", "no step in the flow could be executed against the running app");
  }

  const manifest = CaptureManifest.parse({
    schemaVersion: 1,
    runId: ctx.runId,
    flowId: opts.flow.useCaseId,
    useCaseId: opts.useCaseId,
    title: opts.flow.title,
    fidelity: "L2",
    viewport,
    baseUrl: opts.baseUrl,
    steps,
    assetsManifest: withDom ? "assets/manifest.json" : null,
    createdAt: nowIso(),
  });

  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { manifest, dir, brokenSteps: broken };
}

/* ------------------------------ step driving ----------------------------- */

async function resolveTarget(page: Page, step: Step): Promise<Locator | null> {
  if (!("target" in step) || !step.target) return null;
  const locator = buildLocator(page, step.target);
  await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  return locator;
}

/** Selector precedence mirrors the DSL: role, label, testId, text, then css. */
function buildLocator(page: Page, target: Target): Locator {
  if (target.role) {
    return page.getByRole(target.role.role as never, { name: target.role.name }).first();
  }
  if (target.label) return page.getByLabel(target.label).first();
  if (target.testId) return page.getByTestId(target.testId).first();
  if (target.text) return page.getByText(target.text).first();
  if (target.css) return page.locator(target.css).first();
  throw new SdvError("SDV-E050", "step target has no selector");
}

async function performStep(page: Page, step: Step, located: Locator | null): Promise<void> {
  switch (step.do) {
    case "goto":
      await page.goto(step.path, { waitUntil: "domcontentloaded", timeout: 30_000 });
      break;
    case "click":
      await located!.click({ timeout: STEP_TIMEOUT_MS });
      break;
    case "fill":
      await located!.fill(step.value, { timeout: STEP_TIMEOUT_MS });
      break;
    case "select":
      await located!.selectOption(step.value, { timeout: STEP_TIMEOUT_MS });
      break;
    case "hover":
      await located!.hover({ timeout: STEP_TIMEOUT_MS });
      break;
    case "press":
      await page.keyboard.press(step.key);
      break;
    case "expect":
      await located!.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      break;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
  }
  await settle(page, 250);
}

async function boxOf(locator: Locator, _dpr: number): Promise<Box | null> {
  try {
    const b = await locator.boundingBox({ timeout: 3000 });
    if (!b) return null;
    // CSS pixels: the compositor scales to the output resolution itself.
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  } catch {
    return null;
  }
}

/* --------------------------------- DOM ----------------------------------- */

/**
 * Serialise the live DOM into a replayable snapshot.
 *
 * The snapshot is what the interactive demo replays, so it has to be
 * self-contained: inline styles are kept, cross-origin stylesheets are
 * inlined where readable, and inputs keep the values the user just typed.
 */
async function snapshotDom(page: Page): Promise<unknown | null> {
  try {
    const src = await import("rrweb-snapshot");
    const script = `(${String(src.snapshot)})`;
    void script;
  } catch {
    /* fall through to the browser-side implementation */
  }

  try {
    return await page.evaluate(() => {
      const cloned = document.documentElement.cloneNode(true) as HTMLElement;

      // Persist what the user typed: the value property is live, the
      // attribute is not, and only the attribute survives serialisation.
      const liveInputs = document.querySelectorAll("input, textarea, select");
      const clonedInputs = cloned.querySelectorAll("input, textarea, select");
      liveInputs.forEach((live, i) => {
        const copy = clonedInputs[i];
        if (!copy) return;
        if (live instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
          copy.setAttribute("value", live.value);
          if (live.checked) copy.setAttribute("checked", "");
        } else if (live instanceof HTMLTextAreaElement) {
          copy.textContent = live.value;
        } else if (live instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
          Array.from(copy.options).forEach((o, idx) => {
            if (idx === live.selectedIndex) o.setAttribute("selected", "");
            else o.removeAttribute("selected");
          });
        }
      });

      /**
       * Decide the colour scheme here, not on the viewer's machine.
       *
       * A recorded stylesheet still carries its
       * `@media (prefers-color-scheme: …)` blocks, and on replay those are
       * evaluated against whoever is looking. The same demo then renders
       * light for one visitor and dark for another while the video — filmed
       * once, in one scheme — stays as it was. The two disagreeing is the one
       * thing this product promises cannot happen.
       *
       * So the query is answered now, by the browser that is doing the
       * filming: a block that applied is unwrapped so it always applies, and
       * one that did not is dropped.
       */
      // Written as flat loops with no helper functions on purpose: this body
      // is serialised and run inside the page, and a named function here gets
      // an esbuild `__name` annotation that does not exist over there. The
      // whole snapshot then throws and comes back empty.
      const CSS_MEDIA_RULE = 4;
      const sheets: string[] = [];

      // Same-origin stylesheets can be read out and inlined; that is what
      // makes the replayed page look like the real one without a network.
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const out: string[] = [];
          for (const rule of Array.from(sheet.cssRules ?? [])) {
            const media = rule as CSSMediaRule;
            const condition =
              rule.type === CSS_MEDIA_RULE
                ? (media.conditionText ?? media.media?.mediaText ?? "")
                : "";

            if (!condition || !/prefers-color-scheme/i.test(condition)) {
              out.push(rule.cssText);
              continue;
            }

            const inner = Array.from(media.cssRules ?? [])
              .map((r) => r.cssText)
              .join("\n");
            if (!inner) continue;

            // Keep only the parts of the condition that applied, with the
            // colour-scheme term removed from each — it has been answered.
            const kept: string[] = [];
            let unconditional = false;
            for (const part of condition.split(",")) {
              const term = part.trim();
              if (!term) continue;
              if (!/prefers-color-scheme/i.test(term)) {
                kept.push(term);
                continue;
              }
              if (!window.matchMedia(term).matches) continue;
              const rest = term
                .replace(/\(\s*prefers-color-scheme\s*:\s*[\w-]+\s*\)/gi, "")
                .replace(/^\s*and\b|\band\s*$/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();
              if (!rest) {
                unconditional = true;
                break;
              }
              kept.push(rest);
            }

            if (unconditional) out.push(inner);
            else if (kept.length) out.push(`@media ${kept.join(", ")} {\n${inner}\n}`);
            // else: it did not apply while filming, so it is gone.
          }
          const text = out.filter(Boolean).join("\n");
          if (text) sheets.push(text);
        } catch {
          /* cross-origin sheet — the asset map will carry the href instead */
        }
      }

      cloned.querySelectorAll("script").forEach((s) => s.remove());

      return {
        html: cloned.outerHTML,
        styles: sheets,
        title: document.title,
        url: location.pathname + location.search,
        scroll: { x: window.scrollX, y: window.scrollY },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        // Recorded so a reader of the bundle can see which scheme the video
        // and the demo were both built from.
        colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
      };
    });
  } catch {
    return null;
  }
}

/* -------------------------------- assets --------------------------------- */

/**
 * Keep a copy of everything the page loaded.
 *
 * A demo that reaches back to the customer's origin is not a demo; it breaks
 * the moment the app is redeployed or taken down. Fonts, images and
 * stylesheets are pulled aside during the run so the replay is self-contained.
 */
async function collectAssets(
  context: import("playwright-core").BrowserContext,
  dir: string,
  map: Map<string, string>,
): Promise<void> {
  let n = 0;
  context.on("response", (res: Response) => {
    void (async () => {
      try {
        const type = res.request().resourceType();
        if (!["image", "font", "stylesheet"].includes(type)) return;
        if (!res.ok()) return;
        const body = await res.body();
        if (body.byteLength > 3_000_000) return;
        const url = res.url();
        if (map.has(url)) return;
        const ext = extensionFor(url, type);
        const name = `asset-${String(n++).padStart(3, "0")}${ext}`;
        await writeFile(join(dir, "assets", name), body);
        map.set(url, `assets/${name}`);
      } catch {
        /* an asset we cannot keep is not worth failing the run over */
      }
    })();
  });
}

function extensionFor(url: string, type: string): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url);
  if (m) return `.${m[1]!.toLowerCase()}`;
  if (type === "stylesheet") return ".css";
  if (type === "font") return ".woff2";
  return ".png";
}

/** Record real pointer positions so composed motion can follow them. */
async function installCursorTracking(page: Page): Promise<void> {
  await page
    .addInitScript(() => {
      (window as unknown as { __sdvPointer: { x: number; y: number } }).__sdvPointer = {
        x: 0,
        y: 0,
      };
      window.addEventListener(
        "pointermove",
        (e) => {
          (window as unknown as { __sdvPointer: { x: number; y: number } }).__sdvPointer = {
            x: e.clientX,
            y: e.clientY,
          };
        },
        { passive: true },
      );
    })
    .catch(() => {});
}
