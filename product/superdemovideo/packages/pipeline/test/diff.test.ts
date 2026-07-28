import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DIFF_TUNING, pixelDiff } from "@sdv/pipeline";

/**
 * The sensitivity of the regeneration diff.
 *
 * The threshold is the whole product decision in one number. Too high and a
 * rewritten sentence goes unreported — the demo keeps claiming something the
 * app no longer says. Too low and every report is noise, which is the same as
 * no report at all. These render an actual page-sized screen at 1440×900 and
 * measure what each kind of change is worth, so the number is chosen against
 * evidence rather than taste.
 */

const W = 1440;
const H = 900;
let dir = "";

async function screen(name: string, body: string): Promise<string> {
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <rect x="0" y="0" width="${W}" height="64" fill="#f2f4f7"/>
    <text x="48" y="140" font-family="sans-serif" font-size="34" font-weight="700" fill="#101418">Team</text>
    ${body}
    <rect x="48" y="300" width="1000" height="420" fill="#fafbfc" stroke="#e3e7ec"/>
  </svg>`;
  const path = join(dir, `${name}.png`);
  await writeFile(path, await sharp(Buffer.from(svg)).png().toBuffer());
  return path;
}

const LINE = (text: string) =>
  `<text x="48" y="180" font-family="sans-serif" font-size="18" fill="#5b6572">${text}</text>`;

let base = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdv-diff-"));
  base = await screen("base", LINE("Who can see and change work in Acme."));
}, 30_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pixel comparison", () => {
  it("reports nothing when the screen is unchanged", async () => {
    const same = await screen("same", LINE("Who can see and change work in Acme."));
    const ratio = await pixelDiff(base, same);
    expect(ratio).toBe(0);
  });

  it("notices a single rewritten line of copy", async () => {
    const edited = await screen(
      "copy",
      LINE("Everyone who can see and change work inside Acme."),
    );
    const ratio = await pixelDiff(base, edited);
    expect(ratio).toBeGreaterThan(DIFF_TUNING.changedThreshold);
    // With room to spare: a threshold a copy edit only just clears would miss
    // a shorter one.
    expect(ratio).toBeGreaterThan(DIFF_TUNING.changedThreshold * 3);
  });

  it("notices a moved element", async () => {
    const moved = await screen(
      "moved",
      `<text x="360" y="180" font-family="sans-serif" font-size="18" fill="#5b6572">Who can see and change work in Acme.</text>`,
    );
    const ratio = await pixelDiff(base, moved);
    expect(ratio).toBeGreaterThan(DIFF_TUNING.changedThreshold);
  });

  it("reports a redesign as far larger than a copy edit", async () => {
    const redesigned = await screen("dark", LINE("Who can see and change work in Acme."));
    const dark = join(dir, "dark-inverted.png");
    await writeFile(dark, await sharp(redesigned).negate({ alpha: false }).png().toBuffer());

    const copyRatio = await pixelDiff(
      base,
      await screen("copy2", LINE("Everyone who can see and change work inside Acme.")),
    );
    const redesignRatio = await pixelDiff(base, dark);
    expect(redesignRatio).toBeGreaterThan(copyRatio * 10);
  });
});
