import { describe, expect, it } from "vitest";
import { SdvError, type RepoProfile } from "@sdv/core";
import { requireE2e } from "@sdv/pipeline";
import { createMockLlm } from "@sdv/llm";
import type { RepoDigest } from "@sdv/llm";

function profile(e2e: RepoProfile["e2e"]): RepoProfile {
  return {
    platform: "web",
    framework: "vite",
    packageManager: "npm",
    nodeVersion: "22",
    appRoot: "",
    build: { install: "npm ci", build: null, start: "vite", port: 5173 },
    e2e,
    env: [],
    confidence: 0.9,
  };
}

/**
 * A demo is built from the repository's end-to-end tests.
 *
 * A spec is an ordered list of user actions with selectors already proven to
 * resolve against the running app, and it marks a journey the team decided
 * was worth protecting. Nothing else in a repository carries that. The route
 * names we used to fall back on produced one generic candidate on every real
 * repository tried, built on selectors we had guessed.
 */
describe("requiring end-to-end tests", () => {
  it("refuses a repository with no suite", () => {
    expect(() => requireE2e(profile(null))).toThrow(SdvError);
    try {
      requireE2e(profile(null));
    } catch (e) {
      expect((e as SdvError).code).toBe("SDV-E011");
      expect((e as SdvError).hint).toMatch(/Playwright or Cypress/);
    }
  });

  it("refuses a config that has no specs under it", () => {
    // A config left behind by a template, with an empty directory.
    const empty = profile({
      kind: "playwright",
      configPath: "playwright.config.ts",
      testDir: "e2e",
      specPaths: [],
      storageStatePath: null,
    });
    expect(() => requireE2e(empty)).toThrow(/no specs/);
  });

  it("accepts a suite without a saved sign-in", () => {
    // Plenty of products have nothing behind a login. That is not our call to
    // refuse — it only means the demo is filmed signed out.
    const noAuth = profile({
      kind: "playwright",
      configPath: "playwright.config.ts",
      testDir: "e2e",
      specPaths: ["e2e/draw.spec.ts"],
      storageStatePath: null,
    });
    expect(() => requireE2e(noAuth)).not.toThrow();
  });

  it("refuses before anything expensive has run", () => {
    // The check sits after detect and before understand: seconds in, not
    // eight minutes in with an app built and a browser open.
    expect(() => requireE2e(profile(null))).toThrow();
  });
});

describe("where candidates come from", () => {
  const digest = (specs: RepoDigest["specs"], routes: RepoDigest["routes"]): RepoDigest => ({
    projectName: "app",
    description: null,
    framework: "vite",
    readme: "",
    routes,
    specs,
    analyticsEvents: [],
    changelog: null,
    packageScripts: {},
    approxTokens: 0,
  });

  it("derives them from specs", async () => {
    const llm = createMockLlm();
    const cases = await llm.extractUseCases(
      digest(
        [
          {
            file: "e2e/invite.spec.ts",
            title: "invite a team member",
            isSetup: false,
            actions: [
              { kind: "goto", locator: null, role: null, name: null, value: "/team", raw: "" },
              { kind: "click", locator: "getByRole", role: "button", name: "Send", value: null, raw: "" },
            ],
          },
        ],
        [{ path: "/dashboard", file: "src/App.tsx", label: "Dashboard" }],
      ),
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]!.origin).toBe("e2e/invite.spec.ts");
    expect(cases[0]!.signals).toContain("e2e-test");
  });

  it("does not invent one from route names when there are no specs", async () => {
    // The old fallback returned a candidate here. It was the only thing every
    // real repository produced, and it was always the same generic entry.
    const llm = createMockLlm();
    const cases = await llm.extractUseCases(
      digest([], [{ path: "/dashboard", file: "src/App.tsx", label: "Dashboard" }]),
    );
    expect(cases).toHaveLength(0);
  });
});

describe("platforms we cannot get HTML for yet", () => {
  const on = (platform: RepoProfile["platform"], e2e: RepoProfile["e2e"] = null): RepoProfile => ({
    ...profile(e2e),
    platform,
  });

  it("refuses a native app for being native, not for missing tests", () => {
    // Someone told to add Playwright specs would write them and still have
    // nothing filmable: there is no HTML to point a browser at.
    for (const platform of ["macos", "ios", "android"] as const) {
      try {
        requireE2e(on(platform));
        throw new Error(`should have refused ${platform}`);
      } catch (e) {
        expect((e as SdvError).code, platform).toBe("SDV-E012");
      }
    }
  });

  it("refuses a native app even when it does have a test suite", () => {
    // The tests are not the problem. Having no HTML is.
    try {
      requireE2e(
        on("ios", {
          kind: "playwright",
          configPath: "playwright.config.ts",
          testDir: "e2e",
          specPaths: ["e2e/a.spec.ts"],
          storageStatePath: null,
        }),
      );
      throw new Error("should have refused");
    } catch (e) {
      expect((e as SdvError).code).toBe("SDV-E012");
    }
  });

  it("lets an Electron app through, because its renderer is already HTML", () => {
    // It still needs specs like anything else — but for that reason, not for
    // being a desktop app.
    try {
      requireE2e(on("electron"));
      throw new Error("should have refused");
    } catch (e) {
      expect((e as SdvError).code).toBe("SDV-E011");
    }
  });
});
