import { spawn } from "node:child_process";
import { SdvError, tailLines } from "@sdv/core";

/** Resolve the bundled ffmpeg binary. Nothing is fetched at run time. */
export async function ffmpegPath(): Promise<string> {
  const mod = (await import("ffmpeg-static")) as unknown as { default: string | null };
  const bin = mod.default;
  if (!bin) throw new SdvError("SDV-E060", "ffmpeg-static did not resolve to a binary");
  return bin;
}

export interface EncodeOptions {
  framesDir: string;
  pattern: string;
  fps: number;
  outPath: string;
  width: number;
  height: number;
}

/**
 * Encode a frame sequence to H.264.
 *
 * `yuv420p` and `+faststart` are not cosmetic: without the first, Safari and
 * most social platforms refuse the file; without the second, playback waits
 * for the whole download before it starts, which for a demo in a feed is the
 * same as not playing.
 */
export async function encodeMp4(opts: EncodeOptions): Promise<void> {
  const bin = await ffmpegPath();
  const args = [
    "-y",
    "-framerate",
    String(opts.fps),
    "-i",
    opts.pattern,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    // H.264 requires even dimensions; a stray odd pixel fails the encode.
    "-vf",
    `scale=${opts.width}:${opts.height}:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    opts.outPath,
  ];

  const result = await run(bin, args, opts.framesDir, 15 * 60_000);
  if (result.code !== 0) {
    throw new SdvError("SDV-E060", `ffmpeg failed\n${tailLines(result.output, 20)}`);
  }
}

export interface ProbeResult {
  codec: string;
  width: number;
  height: number;
  durationSec: number;
  fps: number;
}

/** Read back what was actually produced, rather than what we intended. */
export async function probe(path: string): Promise<ProbeResult> {
  const bin = await ffmpegPath();
  const result = await run(bin, ["-i", path, "-hide_banner"], process.cwd(), 60_000);
  const text = result.output;

  const stream = /Stream #\d+:\d+.*?: Video: ([a-z0-9]+).*?, (\d+)x(\d+)[^,]*.*?, ([\d.]+) fps/s.exec(
    text,
  );
  const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);

  if (!stream || !duration) {
    throw new SdvError("SDV-E060", `could not read video metadata from ${path}\n${tailLines(text, 15)}`);
  }
  return {
    codec: stream[1]!,
    width: Number(stream[2]),
    height: Number(stream[3]),
    fps: Number(stream[4]),
    durationSec:
      Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
  };
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (b: Buffer) => {
      output += b.toString();
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${err.message}` });
    });
  });
}
