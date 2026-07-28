import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SdvError, type CaptureManifest, type LocalizedText } from "@sdv/core";
import type { StageContext } from "../context.ts";
import { buildTimeline, captionCues, toSrt, type Skeleton } from "../compose/timeline.ts";
import { FrameRenderer, type Format, type Theme } from "../compose/render.ts";
import { encodeMp4, probe } from "../compose/encode.ts";

export interface ComposeOptions {
  bundleDir: string;
  manifest: CaptureManifest;
  templateDir: string;
  outDir: string;
  workDir: string;
  /** Burn a "Made with" mark into the corner. */
  watermark: boolean;
  script?: { intro: LocalizedText; outro: LocalizedText } | null;
}

export interface ComposeResult {
  videos: Array<{ name: string; path: string; width: number; height: number; durationSec: number }>;
  poster: string;
  subtitles: { en: string; ja: string };
  templateVersion: string;
  compressed: boolean;
}

/**
 * Turn the capture into finished video.
 *
 * Two cuts come out of one capture: a landscape one framed in browser chrome,
 * and a portrait one that crops toward whatever each step is about. The second
 * is not a convenience — a 16:9 screenshot letterboxed into a phone frame is
 * unreadable, and unreadable is the same as unwatched.
 */
export async function compose(ctx: StageContext, opts: ComposeOptions): Promise<ComposeResult> {
  const skeleton: Skeleton = JSON.parse(
    await readFile(join(opts.templateDir, "skeleton.json"), "utf8"),
  );
  const theme: Theme = JSON.parse(await readFile(join(opts.templateDir, "theme.json"), "utf8"));

  const timeline = buildTimeline(opts.manifest, skeleton);
  if (timeline.segments.length === 0) {
    throw new SdvError("SDV-E060", "nothing usable in the capture to compose");
  }
  if (timeline.compressed) {
    ctx.log.warn("holds were shortened to fit the target duration", {
      durationMs: timeline.durationMs,
      target: skeleton.targetDurationMs,
    });
  }

  await mkdir(opts.outDir, { recursive: true });
  const cues = captionCues(timeline);
  await writeFile(join(opts.outDir, "captions.en.srt"), toSrt(cues, "en"));
  await writeFile(join(opts.outDir, "captions.ja.srt"), toSrt(cues, "ja"));

  const totalFrames = Math.max(1, Math.round((timeline.durationMs / 1000) * timeline.fps));
  const videos: ComposeResult["videos"] = [];
  let poster = "";

  for (const format of skeleton.formats as Format[]) {
    const framesDir = join(opts.workDir, "frames", format.name);
    await rm(framesDir, { recursive: true, force: true });
    await mkdir(framesDir, { recursive: true });

    const renderer = new FrameRenderer({
      bundleDir: opts.bundleDir,
      theme,
      format,
      sourceCssWidth: opts.manifest.viewport.width,
      watermark: opts.watermark,
    });

    for (let i = 0; i < totalFrames; i++) {
      const png = await renderer.renderFrame(timeline, i);
      await writeFile(join(framesDir, `${String(i).padStart(6, "0")}.png`), png);

      if (i % 60 === 0) {
        ctx.progress({
          stage: "compose",
          status: "running",
          message: `Rendering ${format.name}: ${Math.round((i / totalFrames) * 100)}%`,
        });
      }
      // The poster is the first frame that shows the product, not a title card.
      if (i === Math.round(timeline.fps * 0.8) && format.frame === "browser") {
        poster = join(opts.outDir, "poster.png");
        await writeFile(poster, png);
      }
    }

    const outPath = join(opts.outDir, `${format.name}.mp4`);
    ctx.progress({ stage: "compose", status: "running", message: `Encoding ${format.name}` });
    await encodeMp4({
      framesDir,
      pattern: "%06d.png",
      fps: timeline.fps,
      outPath,
      width: format.width,
      height: format.height,
    });

    const meta = await probe(outPath);
    videos.push({
      name: format.name,
      path: outPath,
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
    });

    // Frames are large and single-use: 1800 PNGs per format is gigabytes.
    await rm(framesDir, { recursive: true, force: true });
  }

  if (!poster) {
    poster = join(opts.outDir, "poster.png");
    const renderer = new FrameRenderer({
      bundleDir: opts.bundleDir,
      theme,
      format: (skeleton.formats as Format[])[0]!,
      sourceCssWidth: opts.manifest.viewport.width,
      watermark: opts.watermark,
    });
    await writeFile(poster, await renderer.renderFrame(timeline, 0));
  }

  return {
    videos,
    poster,
    subtitles: {
      en: join(opts.outDir, "captions.en.srt"),
      ja: join(opts.outDir, "captions.ja.srt"),
    },
    templateVersion: `${skeleton.id}@${skeleton.version}`,
    compressed: timeline.compressed,
  };
}
