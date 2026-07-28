import { describe, expect, it } from "vitest";
import { isWorthFilming } from "@sdv/pipeline";

/**
 * Telling a sparse design apart from a broken render.
 *
 * reveal.js opens on a black slide carrying the words "Slide 1" — half a
 * percent of the viewport, and a perfectly good first frame. Refusing it as
 * an empty app was the pipeline's own judgement, not the repository's fault,
 * and it stopped the first foreign repository that ever started.
 */
describe("is there anything worth filming", () => {
  it("accepts a page that is sparse but really rendered", () => {
    expect(isWorthFilming({ contentRatio: 0.005, elements: 14, characters: 42 })).toBe(true);
  });

  it("accepts an ordinary busy page without looking at structure", () => {
    expect(isWorthFilming({ contentRatio: 0.31, elements: 0, characters: 0 })).toBe(true);
  });

  it("refuses a page that is empty by both measures", () => {
    // A spinner, a skeleton, or a redirect that landed nowhere.
    expect(isWorthFilming({ contentRatio: 0.004, elements: 2, characters: 0 })).toBe(false);
    expect(isWorthFilming({ contentRatio: 0, elements: 0, characters: 0 })).toBe(false);
  });

  it("refuses a shell with chrome but nothing to read", () => {
    // Layout containers exist, but the content never arrived.
    expect(isWorthFilming({ contentRatio: 0.01, elements: 20, characters: 3 })).toBe(false);
  });
});
