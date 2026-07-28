import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import type { FastifyReply } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".srt": "application/x-subrip; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Join a user-supplied path onto a directory without leaving it.
 *
 * The wildcard on the artifact and demo routes is attacker-controlled, and a
 * naive join would happily serve `../../db`. Nothing is stripped or rewritten
 * — a path that escapes is rejected outright, because silently sanitising
 * `../../etc/passwd` into `etc/passwd` turns an attack into a plausible-looking
 * request. Returns null rather than throwing so the caller answers 404.
 */
export function safeJoin(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, normalize(rel));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function sendFile(reply: FastifyReply, path: string): Promise<FastifyReply> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return reply.code(404).send({ error: "not found" });
  }
  if (info.isDirectory()) return reply.code(404).send({ error: "not found" });

  return (
    reply
      .header("content-type", contentType(path))
      .header("content-length", String(info.size))
      .header("accept-ranges", "bytes")
      // The demo replays a captured page inside a sandboxed iframe, which has
      // an opaque origin — so even same-host requests for its stylesheet and
      // fonts are cross-origin and need this. These files are public static
      // assets meant to be embedded on other people's pages; without the
      // header the replay renders as naked HTML and looks broken.
      .header("access-control-allow-origin", "*")
      .send(createReadStream(path))
  );
}
