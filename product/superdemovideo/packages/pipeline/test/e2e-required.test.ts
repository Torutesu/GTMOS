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
    screens: [],
    appScreens: [],
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

describe("what the test requirement applies to", () => {
  const on = (platform: RepoProfile["platform"], e2e: RepoProfile["e2e"] = null): RepoProfile => ({
    ...profile(e2e),
    platform,
  });

  it("does not ask a native app for specs it has no use for", () => {
    // The requirement exists because we cannot know a web app's journeys and
    // cannot trust selectors we guessed at. Neither holds here: the screens are
    // rendered by us, from the source that declares them, so the markup, the
    // roles and the labels are ours and the screens are the journeys.
    for (const platform of ["macos", "ios", "android"] as const) {
      expect(() => requireE2e(on(platform)), platform).not.toThrow();
    }
  });

  it("does not ask an Electron app for specs either", () => {
    // Its renderer is the app's real HTML and we serve it, so the controls are
    // read off the live page rather than guessed. What a spec could not have
    // given us is the way between screens: in a desktop app that is the main
    // process moving the renderer, and a suite driving the real app would go
    // through a main process we do not have.
    expect(() => requireE2e(on("electron"))).not.toThrow();
  });

  it("still requires them of a web app, which is the only case the reason fits", () => {
    expect(() => requireE2e(on("web"))).toThrow(SdvError);
  });
});
