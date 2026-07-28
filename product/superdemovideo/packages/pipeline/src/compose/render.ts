import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { easeInOut, lerp, type Point } from "@sdv/core";
import type { Segment, Timeline } from "./timeline.ts";

/** sharp does not export its overlay type by name. */
type Overlay = NonNullable<Parameters<ReturnType<typeof sharp>["composite"]>[0]>[number];

export interface Theme {
  background: { type: string; from: string; to: string };
  browserFrame: {
    chrome: string;
    border: string;
    dot: string[];
    radius: number;
    chromeHeight: number;
    shadow: { blur: number; opacity: number };
  };
  cursor: { fill: string; stroke: string; size: number; ripple: { color: string; maxRadius: number } };
  caption: {
    font: string;
    sizeRatio: number;
    color: string;
    background: string;
    accent: string;
    paddingRatio: number;
    bottomRatio: number;
    radius: number;
  };
  watermark: { text: string; color: string; sizeRatio: number };
}

export interface Format {
  name: string;
  width: number;
  height: number;
  frame: "browser" | "focus";
  /**
   * Where the caption sits, as a fraction of height from the bottom.
   *
   * Feeds overlay their own chrome on a vertical video — the reply bar, the
   * handle, the progress line — and a caption pinned near the bottom edge is
   * simply covered. Tall formats push the text up into the middle band where
   * nothing else is drawn. Falls back to the theme when unset.
   */
  safeBottomRatio?: number;
  /** Caption size override, as a fraction of height. Tall frames need larger text. */
  captionSizeRatio?: number;
}

export interface RenderContext {
  bundleDir: string;
  theme: Theme;
  format: Format;
  /** Screenshot dimensions in CSS pixels — boxes are recorded in that space. */
  sourceCssWidth: number;
  watermark: boolean;
}

/**
 * Frame compositor.
 *
 * Consecutive frames differ only in where the cursor is, so the expensive part
 * — scaling a screenshot into a device frame and drawing the caption — is done
 * once per distinct screen and reused. Without that cache a sixty-second cut
 * would re-composite the same background eighteen hundred times.
 */
export class FrameRenderer {
  private plates = new Map<string, Buffer>();
  private cursorCache: { svg: string; width: number; height: number } | null = null;

  constructor(private ctx: RenderContext) {}

  async renderFrame(timeline: Timeline, frameIndex: number): Promise<Buffer> {
    const tMs = (frameIndex / timeline.fps) * 1000;
    const seg = segmentAt(timeline, tMs);
    const local = tMs - seg.startMs;
    const progress = seg.durationMs > 0 ? local / seg.durationMs : 1;

    const plate = await this.plate(seg, progress);
    const overlays: Overlay[] = [];

    const cursor = cursorAt(seg, progress);
    if (cursor) {
      const scaled = this.toOutput(cursor, seg);
      // Both overlays are drawn at their own small size and positioned, not
      // painted onto a full-frame canvas. Rasterising a 1920×1080 SVG once per
      // frame costs more than everything else in the loop put together.
      if (seg.kind === "ripple") {
        const sprite = this.rippleSprite(progress);
        overlays.push(place(sprite.svg, scaled.x - sprite.size / 2, scaled.y - sprite.size / 2, sprite.size, sprite.size, this.ctx.format));
      }
      const cur = this.cursorSprite();
      overlays.push(place(cur.svg, scaled.x, scaled.y, cur.width, cur.height, this.ctx.format));
    }

    if (overlays.length === 0) return plate;
    return sharp(plate).composite(overlays).png({ compressionLevel: 1 }).toBuffer();
  }

  /** Background + device frame + caption + watermark, cached per screen. */
  private async plate(seg: Segment, progress: number): Promise<Buffer> {
    const captionKey = seg.caption?.en ?? "";
    const focusKey = this.ctx.format.frame === "focus" ? JSON.stringify(seg.focus) : "";
    const key =
      seg.kind === "transition"
        ? `xf:${seg.image}|${seg.imageTo}|${Math.round(progress * 8)}|${focusKey}`
        : `${seg.image}|${captionKey}|${focusKey}`;

    const cached = this.plates.get(key);
    if (cached) return cached;

    let base: Buffer;
    if (seg.kind === "transition" && seg.imageTo) {
      base = await this.crossfade(seg.image, seg.imageTo, progress, seg);
    } else {
      base = await this.screenPlate(seg.image, seg);
    }

    const overlays: Overlay[] = [];
    if (seg.caption) {
      overlays.push({ input: Buffer.from(this.captionSvg(seg.caption.en)), top: 0, left: 0 });
    }
    if (this.ctx.watermark) {
      overlays.push({ input: Buffer.from(this.watermarkSvg()), top: 0, left: 0 });
    }

    const out =
      overlays.length > 0
        ? await sharp(base).composite(overlays).png({ compressionLevel: 1 }).toBuffer()
        : base;

    // Bound the cache: a long flow with many screens should not grow forever.
    if (this.plates.size > 120) this.plates.clear();
    this.plates.set(key, out);
    return out;
  }

  private async crossfade(a: string, b: string, progress: number, seg: Segment): Promise<Buffer> {
    const [fromPlate, toPlate] = await Promise.all([
      this.screenPlate(a, seg),
      this.screenPlate(b, seg),
    ]);
    const alpha = Math.round(easeInOut(progress) * 255);
    const mask = await sharp({
      create: {
        width: this.ctx.format.width,
        height: this.ctx.format.height,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: alpha / 255 },
      },
    })
      .png()
      .toBuffer();
    const faded = await sharp(toPlate)
      .composite([{ input: mask, blend: "dest-in" }])
      .png({ compressionLevel: 1 })
      .toBuffer();
    return sharp(fromPlate)
      .composite([{ input: faded, blend: "over" }])
      .png({ compressionLevel: 1 })
      .toBuffer();
  }

  /** Place one screenshot into the output frame. */
  private async screenPlate(image: string, seg: Segment): Promise<Buffer> {
    const { width, height, frame } = this.ctx.format;
    const raw = await readFile(join(this.ctx.bundleDir, image));

    if (frame === "focus") {
      return this.focusPlate(raw, seg, width, height);
    }
    return this.browserPlate(raw, width, height);
  }

  /**
   * Landscape: the screenshot inside a browser chrome, floated on a gradient.
   * The chrome is what tells a viewer in one frame that this is real software.
   */
  private async browserPlate(png: Buffer, width: number, height: number): Promise<Buffer> {
    const t = this.ctx.theme.browserFrame;
    const margin = Math.round(width * 0.055);
    const innerW = width - margin * 2;

    // Bounded on both sides, not just width. A desktop app is filmed at the
    // window size it asks for, and a 560x460 panel scaled to the full frame
    // width is taller than the frame — sharp then refuses to composite it, and
    // the run dies after the filming is already done.
    const shot = await sharp(png)
      .resize({
        width: innerW,
        height: height - t.chromeHeight - margin * 2,
        fit: "inside",
      })
      .toBuffer();
    const meta = await sharp(shot).metadata();
    const shotH = meta.height ?? 0;
    const shotW = meta.width ?? innerW;
    const totalH = shotH + t.chromeHeight;
    const top = Math.round((height - totalH) / 2);
    // The chrome hugs the screenshot rather than the frame, so a narrow window
    // gets a narrow window rather than a wide box with a picture in the middle.
    const left = Math.round((width - shotW) / 2);

    const chromeSvg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${this.ctx.theme.background.from}"/>
            <stop offset="100%" stop-color="${this.ctx.theme.background.to}"/>
          </linearGradient>
          <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="16" stdDeviation="${t.shadow.blur / 3}"
              flood-color="#000" flood-opacity="${t.shadow.opacity}"/>
          </filter>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#bg)"/>
        <g filter="url(#sh)">
          <rect x="${left}" y="${top}" width="${shotW}" height="${totalH}"
                rx="${t.radius}" fill="${t.chrome}" stroke="${t.border}"/>
        </g>
        ${t.dot
          .map(
            (c, i) =>
              `<circle cx="${left + 22 + i * 20}" cy="${top + t.chromeHeight / 2}" r="6" fill="${c}"/>`,
          )
          .join("")}
      </svg>`;

    return sharp(Buffer.from(chromeSvg))
      .composite([{ input: shot, top: top + t.chromeHeight, left }])
      .png({ compressionLevel: 1 })
      .toBuffer();
  }

  /**
   * Portrait: crop toward whatever the step is about.
   *
   * A 16:9 screenshot letterboxed into a vertical frame is unreadable on a
   * phone. Following the target keeps the thing being demonstrated large
   * enough to see at arm's length.
   */
  private async focusPlate(
    png: Buffer,
    seg: Segment,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const meta = await sharp(png).metadata();
    const srcW = meta.width ?? this.ctx.sourceCssWidth;
    const srcH = meta.height ?? Math.round((srcW * 9) / 16);
    const scale = srcW / this.ctx.sourceCssWidth;

    const cropW = Math.min(srcW, Math.round(srcH * (width / height)));
    const cropH = Math.min(srcH, Math.round(cropW * (height / width)));

    let cx = srcW / 2;
    let cy = srcH / 2;
    if (seg.focus) {
      cx = (seg.focus.x + seg.focus.w / 2) * scale;
      cy = (seg.focus.y + seg.focus.h / 2) * scale;
    }
    const left = Math.round(Math.max(0, Math.min(srcW - cropW, cx - cropW / 2)));
    const top = Math.round(Math.max(0, Math.min(srcH - cropH, cy - cropH / 2)));

    const cropped = await sharp(png)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(width, height, { fit: "cover" })
      .png({ compressionLevel: 1 })
      .toBuffer();
    return cropped;
  }

  /** Map a CSS-pixel point into output coordinates. */
  private toOutput(p: Point, seg: Segment): Point {
    const { width, height, frame } = this.ctx.format;
    if (frame === "browser") {
      const margin = Math.round(width * 0.055);
      const innerW = width - margin * 2;
      const scale = innerW / this.ctx.sourceCssWidth;
      const shotH = Math.round((this.ctx.sourceCssWidth * (9 / 16)) * scale);
      const totalH = shotH + this.ctx.theme.browserFrame.chromeHeight;
      const top = Math.round((height - totalH) / 2) + this.ctx.theme.browserFrame.chromeHeight;
      return { x: margin + p.x * scale, y: top + p.y * scale };
    }
    // Focus crops follow the target, so the cursor sits near the middle.
    const focus = seg.focus;
    if (!focus) return { x: width / 2, y: height / 2 };
    const rel = { x: p.x - focus.x, y: p.y - focus.y };
    return { x: width / 2 + rel.x, y: height / 2 + rel.y };
  }

  /** The pointer, drawn once at its own size. Identical every frame. */
  private cursorSprite(): { svg: string; width: number; height: number } {
    if (this.cursorCache) return this.cursorCache;
    const c = this.ctx.theme.cursor;
    const s = c.size;
    const w = Math.ceil(s * 0.8) + 4;
    const h = Math.ceil(s * 1.1) + 4;
    this.cursorCache = {
      width: w,
      height: h,
      svg: `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 2 L2 ${s + 2} L${s * 0.28 + 2} ${s * 0.74 + 2} L${s * 0.46 + 2} ${s * 1.06 + 2} L${s * 0.62 + 2} ${s * 0.98 + 2} L${s * 0.44 + 2} ${s * 0.68 + 2} L${s * 0.76 + 2} ${s * 0.66 + 2} Z"
              fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`,
    };
    return this.cursorCache;
  }

  private rippleSprite(progress: number): { svg: string; size: number } {
    const r = this.ctx.theme.cursor.ripple;
    const radius = 6 + easeInOut(progress) * r.maxRadius;
    const opacity = (1 - progress) * 0.55;
    const size = Math.ceil((radius + 3) * 2);
    return {
      size,
      svg: `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${size / 2}" cy="${size / 2}" r="${radius.toFixed(1)}"
                fill="none" stroke="${r.color}" stroke-width="3" opacity="${opacity.toFixed(3)}"/>
      </svg>`,
    };
  }

  private captionSvg(text: string): string {
    const { width, height } = this.ctx.format;
    const c = this.ctx.theme.caption;
    const size = Math.round(height * (this.ctx.format.captionSizeRatio ?? c.sizeRatio));
    const pad = Math.round(height * c.paddingRatio);
    const bottom = Math.round(height * (this.ctx.format.safeBottomRatio ?? c.bottomRatio));
    const charW = size * 0.55;
    const boxW = Math.min(width - pad * 4, Math.round(text.length * charW + pad * 3));
    const boxH = size + pad * 2;
    const x = Math.round((width - boxW) / 2);
    const y = height - bottom - boxH;

    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${c.radius}" fill="${c.background}"/>
      <rect x="${x}" y="${y}" width="4" height="${boxH}" rx="2" fill="${c.accent}"/>
      <text x="${x + pad * 1.5}" y="${y + boxH / 2}" fill="${c.color}"
            font-family="${c.font}" font-size="${size}" font-weight="600"
            dominant-baseline="central">${escapeXml(text)}</text>
    </svg>`;
  }

  private watermarkSvg(): string {
    const { width, height } = this.ctx.format;
    const w = this.ctx.theme.watermark;
    const size = Math.round(height * w.sizeRatio);
    // Sit above the caption's safe area so the mark is never the thing a
    // platform's own chrome covers, and never covers the caption itself.
    const bottom = Math.round(height * (this.ctx.format.safeBottomRatio ?? 0)) + size;
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${width - size}" y="${height - bottom}" fill="${w.color}"
            font-family="sans-serif" font-size="${size}" text-anchor="end">${escapeXml(w.text)}</text>
    </svg>`;
  }
}

/**
 * Position a small sprite on the frame.
 *
 * sharp refuses a composite that would fall outside the base image, so the
 * position is clamped rather than clipped. At the edge of the frame the
 * pointer sits a few pixels in from where it strictly belongs — which nobody
 * can see, and which is better than an exception mid-render.
 */
function place(
  svg: string,
  x: number,
  y: number,
  w: number,
  h: number,
  format: { width: number; height: number },
): Overlay {
  const left = Math.max(0, Math.min(Math.round(x), format.width - w));
  const top = Math.max(0, Math.min(Math.round(y), format.height - h));
  return { input: Buffer.from(svg), left, top };
}

export function segmentAt(timeline: Timeline, tMs: number): Segment {
  for (const s of timeline.segments) {
    if (tMs >= s.startMs && tMs < s.startMs + s.durationMs) return s;
  }
  return timeline.segments.at(-1)!;
}

export function cursorAt(seg: Segment, progress: number): Point | null {
  if (!seg.cursorFrom || !seg.cursorTo) return null;
  if (seg.kind === "intro" || seg.kind === "outro" || seg.kind === "transition") return null;
  const t = easeInOut(progress);
  return {
    x: lerp(seg.cursorFrom.x, seg.cursorTo.x, t),
    y: lerp(seg.cursorFrom.y, seg.cursorTo.y, t),
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
