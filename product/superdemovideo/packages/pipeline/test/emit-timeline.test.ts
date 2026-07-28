import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CaptureManifest } from "@sdv/core";
import { buildTimeline, captionCues, toSrt, withPathAliases } from "@sdv/pipeline";
import type { Skeleton } from "../src/compose/timeline.ts";

const TEMPLATE = fileURLToPath(new URL("../../../templates/launch", import.meta.url));

async function skeleton(): Promise<Skeleton> {
  return JSON.parse(await readFile(join(TEMPLATE, "skeleton.json"), "utf8"));
}

function manifest(stepCount: number): CaptureManifest {
  return {
    schemaVersion: 1,
    useCaseId: "uc_1",
    title: { en: "Invite a team member", ja: "メンバーを招待する" },
    viewport: { name: "desktop", width: 1440, height: 900, dpr: 1 },
    capturedAt: new Date(0).toISOString(),
    assetsManifest: null,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      index: i,
      do: i === 0 ? ("goto" as const) : ("click" as const),
      ok: true,
      errorCode: null,
      caption: { en: `Step ${i + 1}`, ja: `手順 ${i + 1}` },
      beforePng: `steps/${i}/before.png`,
      afterPng: `steps/${i}/after.png`,
      domJson: null,
      targetBox: i === 0 ? null : { x: 100, y: 200, w: 120, h: 40 },
      clickPoint: i === 0 ? null : { x: 160, y: 220 },
      durationMs: 400,
    })),
  } as CaptureManifest;
}

describe("timeline duration", () => {
  it("stretches a short flow so each caption can be read", async () => {
    const s = await skeleton();
    const timeline = buildTimeline(manifest(5), s);
    expect(timeline.durationMs).toBeGreaterThanOrEqual(s.minDurationMs);
    expect(timeline.compressed).toBe(false);

    // Stretched, but not to the point where the screen looks frozen.
    for (const seg of timeline.segments.filter((x) => x.kind === "hold")) {
      expect(seg.durationMs).toBeLessThanOrEqual(s.step.maxHoldMs);
    }
  });

  it("squeezes a long flow without dropping a single step", async () => {
    const s = await skeleton();
    const timeline = buildTimeline(manifest(28), s);
    expect(timeline.durationMs).toBeLessThanOrEqual(s.maxDurationMs);
    expect(timeline.compressed).toBe(true);

    const holds = timeline.segments.filter((x) => x.kind === "hold");
    expect(holds).toHaveLength(28);
    for (const seg of holds) expect(seg.durationMs).toBeGreaterThanOrEqual(s.step.minHoldMs);
  });

  it("shows the product before the viewer has decided to leave", async () => {
    const s = await skeleton();
    const timeline = buildTimeline(manifest(5), s);
    const intro = timeline.segments.find((x) => x.kind === "intro");
    expect(intro).toBeDefined();
    expect(intro!.durationMs).toBeLessThan(s.hookMs ?? 1700);
    // The intro runs over a real screen — there is no title-card segment.
    expect(intro!.image).toBeTruthy();
  });

  it("writes one subtitle cue per step in both languages", async () => {
    const s = await skeleton();
    const timeline = buildTimeline(manifest(4), s);
    const cues = captionCues(timeline);
    expect(cues).toHaveLength(4);

    const en = toSrt(cues, "en");
    const ja = toSrt(cues, "ja");
    expect(en).toMatch(/^1\r?\n00:00:/);
    expect(en).toContain("Step 1");
    expect(ja).toContain("手順 1");
    expect(en).not.toEqual(ja);
  });
});

describe("replayed page assets", () => {
  it("also match the root-relative form the markup actually uses", () => {
    const aliased = withPathAliases({
      "http://127.0.0.1:3100/assets/index-CQ_Hpg3K.css": "assets/asset-000.css",
    });
    expect(aliased["/assets/index-CQ_Hpg3K.css"]).toBe("assets/asset-000.css");
    expect(aliased["//127.0.0.1:3100/assets/index-CQ_Hpg3K.css"]).toBe("assets/asset-000.css");
    // The recorded key survives untouched.
    expect(aliased["http://127.0.0.1:3100/assets/index-CQ_Hpg3K.css"]).toBe("assets/asset-000.css");
  });

  it("keeps a query string, because a rewrite that drops it points nowhere", () => {
    const aliased = withPathAliases({ "https://app.test/logo.svg?v=2": "assets/asset-001.svg" });
    expect(aliased["/logo.svg?v=2"]).toBe("assets/asset-001.svg");
    expect(aliased["/logo.svg"]).toBeUndefined();
  });
});
