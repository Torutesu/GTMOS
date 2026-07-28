import { describe, expect, it } from "vitest";
import { relaxInstall } from "@sdv/pipeline";

/**
 * Recovering from a stale lockfile.
 *
 * Every repository the field test reached died at the install step, and one
 * of them died for a reason that is not a real problem: `npm ci` refuses when
 * package.json and the lockfile have drifted, which is an ordinary state for
 * a project nobody has installed in a while. Refusing to film a demo over
 * that helps nobody, so the strict form runs first and the permissive one is
 * the fallback.
 */
describe("relaxing an install command", () => {
  it("drops the lockfile requirement for each package manager", () => {
    expect(relaxInstall("npm ci")).toBe("npm install --no-audit --no-fund");
    expect(relaxInstall("pnpm install --frozen-lockfile")).toBe(
      "pnpm install --no-frozen-lockfile",
    );
    expect(relaxInstall("yarn install --frozen-lockfile")).toBe("yarn install");
    expect(relaxInstall("yarn install --immutable")).toBe("yarn install");
  });

  it("returns null when there is nothing left to relax", () => {
    // Otherwise the retry runs the identical command and reports the same
    // failure as though it were a second opinion.
    for (const already of ["npm install", "pnpm install", "yarn install", "bun install"]) {
      expect(relaxInstall(already), already).toBeNull();
    }
  });

  it("keeps the rest of a command it did not write", () => {
    expect(relaxInstall("npm ci --ignore-scripts")).toBe(
      "npm install --no-audit --no-fund --ignore-scripts",
    );
  });
});
