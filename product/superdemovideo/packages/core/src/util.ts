import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(ALPHABET, 12);
const slugNano = customAlphabet(ALPHABET, 8);

export function id(prefix: string): string {
  return `${prefix}_${nano()}`;
}

export function slug(): string {
  return slugNano();
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortSha(input: string | Buffer): string {
  return sha256(input).slice(0, 12);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns true or `timeoutMs` elapses. */
export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  { timeoutMs, intervalMs = 250 }: { timeoutMs: number; intervalMs?: number },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Cubic ease-in-out — used for cursor motion between steps. */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Redact obvious secrets from text before it is stored or shown. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-***")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA***")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "jwt.***");
}

/** Last N lines of a long log, for user-facing summaries. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}
