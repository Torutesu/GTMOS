import type { Caption, CaptureManifest, Point } from "@sdv/core";
import { clamp } from "@sdv/core";

export interface Skeleton {
  id: string;
  version: string;
  targetDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  hookMs?: number;
  fps: number;
  intro: { durationMs: number };
  step: {
    cursorMoveMs: number;
    clickRippleMs: number;
    holdMs: number;
    minHoldMs: number;
    maxHoldMs: number;
    transitionMs: number;
  };
  outro: { durationMs: number };
  formats: Array<{
    name: string;
    width: number;
    height: number;
    frame: "browser" | "focus";
    safeBottomRatio?: number;
    captionSizeRatio?: number;
  }>;
}

export type SegmentKind = "intro" | "cursor" | "ripple" | "hold" | "transition" | "outro";

export interface Segment {
  kind: SegmentKind;
  stepIndex: number;
  startMs: number;
  durationMs: number;
  /** Screenshot this segment renders over. */
  image: string;
  /** For a transition, the frame being crossfaded to. */
  imageTo?: string;
  caption: Caption | null;
  cursorFrom: Point | null;
  cursorTo: Point | null;
  focus: { x: number; y: number; w: number; h: number } | null;
}

export interface Timeline {
  fps: number;
  durationMs: number;
  segments: Segment[];
  /** True when holds were shortened to fit the target duration. */
  compressed: boolean;
}

const DEFAULT_CURSOR: Point = { x: 40, y: 40 };

/**
 * Lay the capture out in time.
 *
 * Two rules shape this. The opening frames are the product already on screen —
 * a viewer scrolling a feed decides in about three seconds, and a title card
 * spends all three saying nothing. And when the cut runs long, holds compress
 * toward a floor rather than steps being dropped: a shorter demo of the whole
 * job beats a comfortable demo of half of it.
 */
export function buildTimeline(manifest: CaptureManifest, skeleton: Skeleton): Timeline {
  const usable = manifest.steps.filter((s) => s.ok);
  const steps = usable.length > 0 ? usable : manifest.steps;

  const segments: Segment[] = [];
  let cursor: Point = DEFAULT_CURSOR;
  let t = 0;

  const first = steps[0];
  if (!first) {
    return { fps: skeleton.fps, durationMs: 0, segments: [], compressed: false };
  }

  // Intro over the first live screen — never a card.
  segments.push({
    kind: "intro",
    stepIndex: 0,
    startMs: t,
    durationMs: skeleton.intro.durationMs,
    image: first.afterPng,
    caption: null,
    cursorFrom: cursor,
    cursorTo: cursor,
    focus: null,
  });
  t += skeleton.intro.durationMs;

  for (const [i, step] of steps.entries()) {
    const isFirst = i === 0;
    const target = step.clickPoint;
    const interactive = step.do === "click" || step.do === "fill" || step.do === "select";

    if (target && interactive) {
      segments.push({
        kind: "cursor",
        stepIndex: step.index,
        startMs: t,
        durationMs: skeleton.step.cursorMoveMs,
        image: step.beforePng,
        caption: step.caption,
        cursorFrom: cursor,
        cursorTo: target,
        focus: step.targetBox,
      });
      t += skeleton.step.cursorMoveMs;

      segments.push({
        kind: "ripple",
        stepIndex: step.index,
        startMs: t,
        durationMs: skeleton.step.clickRippleMs,
        image: step.beforePng,
        caption: step.caption,
        cursorFrom: target,
        cursorTo: target,
        focus: step.targetBox,
      });
      t += skeleton.step.clickRippleMs;
      cursor = target;
    }

    segments.push({
      kind: "hold",
      stepIndex: step.index,
      startMs: t,
      durationMs: skeleton.step.holdMs,
      image: step.afterPng,
      caption: step.caption,
      cursorFrom: cursor,
      cursorTo: cursor,
      focus: step.targetBox,
    });
    t += skeleton.step.holdMs;

    const next = steps[i + 1];
    if (next && !isFirstEqual(step.afterPng, next.beforePng)) {
      segments.push({
        kind: "transition",
        stepIndex: step.index,
        startMs: t,
        durationMs: skeleton.step.transitionMs,
        image: step.afterPng,
        imageTo: next.beforePng,
        caption: null,
        cursorFrom: cursor,
        cursorTo: cursor,
        focus: null,
      });
      t += skeleton.step.transitionMs;
    }
    void isFirst;
  }

  const last = steps.at(-1)!;
  segments.push({
    kind: "outro",
    stepIndex: last.index,
    startMs: t,
    durationMs: skeleton.outro.durationMs,
    image: last.afterPng,
    caption: null,
    cursorFrom: cursor,
    cursorTo: cursor,
    focus: null,
  });
  t += skeleton.outro.durationMs;

  let compressed = false;
  if (t > skeleton.targetDurationMs) {
    compressed = compressHolds(segments, skeleton);
  } else if (t < skeleton.minDurationMs) {
    expandHolds(segments, skeleton);
  }

  return { fps: skeleton.fps, durationMs: total(segments), segments, compressed };
}

/**
 * Squeeze the holds, never the steps.
 *
 * Dropping a step would change what the demo claims the product does. A hold
 * that is half a second shorter only asks the viewer to read a little faster.
 */
function compressHolds(segments: Segment[], skeleton: Skeleton): boolean {
  const holds = segments.filter((s) => s.kind === "hold");
  if (holds.length === 0) return false;

  const fixed = segments.filter((s) => s.kind !== "hold").reduce((a, s) => a + s.durationMs, 0);
  const budget = skeleton.targetDurationMs - fixed;
  const perHold = budget / holds.length;

  if (perHold >= skeleton.step.holdMs) return false;
  const clamped = clamp(perHold, skeleton.step.minHoldMs, skeleton.step.holdMs);
  for (const h of holds) h.durationMs = Math.round(clamped);

  retime(segments);
  return true;
}

/**
 * Let a short flow breathe.
 *
 * A four-step demo comes out at fourteen seconds, and every caption in it
 * flashes past in under a second and a half. The captions are the only
 * narration a muted video has, so a viewer who cannot finish reading one has
 * effectively watched a silent film. Holds stretch — up to a ceiling, because
 * a screen that sits still too long reads as a stall, not as emphasis.
 */
function expandHolds(segments: Segment[], skeleton: Skeleton): void {
  const holds = segments.filter((s) => s.kind === "hold");
  if (holds.length === 0) return;

  const fixed = segments.filter((s) => s.kind !== "hold").reduce((a, s) => a + s.durationMs, 0);
  const perHold = (skeleton.minDurationMs - fixed) / holds.length;
  const target = clamp(perHold, skeleton.step.holdMs, skeleton.step.maxHoldMs);
  if (target <= skeleton.step.holdMs) return;

  for (const h of holds) h.durationMs = Math.round(target);
  retime(segments);
}

function retime(segments: Segment[]): void {
  let t = 0;
  for (const s of segments) {
    s.startMs = t;
    t += s.durationMs;
  }
}

function total(segments: Segment[]): number {
  const last = segments.at(-1);
  return last ? last.startMs + last.durationMs : 0;
}

function isFirstEqual(a: string, b: string): boolean {
  return a === b;
}

/** Cue list for the subtitle track, merged across a step's segments. */
export function captionCues(timeline: Timeline): Array<{
  startMs: number;
  endMs: number;
  caption: Caption;
}> {
  const cues: Array<{ startMs: number; endMs: number; caption: Caption }> = [];
  for (const seg of timeline.segments) {
    if (!seg.caption) continue;
    const prev = cues.at(-1);
    if (prev && prev.caption.en === seg.caption.en && prev.endMs === seg.startMs) {
      prev.endMs = seg.startMs + seg.durationMs;
      continue;
    }
    cues.push({
      startMs: seg.startMs,
      endMs: seg.startMs + seg.durationMs,
      caption: seg.caption,
    });
  }
  return cues;
}

export function toSrt(
  cues: Array<{ startMs: number; endMs: number; caption: Caption }>,
  lang: "en" | "ja",
): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.caption[lang]}\n`)
    .join("\n");
}

function srtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = Math.floor(ms % 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
}
