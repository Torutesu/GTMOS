import { describe, expect, it } from "vitest";
import { Flow, RepoProfile, SdvError, Step, Target, easeInOut, redact, toSdvError } from "@sdv/core";

describe("Flow DSL", () => {
  const goto = { do: "goto", path: "/dashboard" } as const;
  const click = { do: "click", target: { role: { role: "button", name: "Invite" } } } as const;

  it("accepts a well-formed flow", () => {
    const parsed = Flow.parse({
      schemaVersion: 1,
      useCaseId: "uc_1",
      title: { en: "Invite", ja: "招待" },
      steps: [goto, click],
    });
    expect(parsed.steps).toHaveLength(2);
  });

  it("requires the first step to be a goto", () => {
    expect(() =>
      Flow.parse({
        schemaVersion: 1,
        useCaseId: "uc_1",
        title: { en: "a", ja: "あ" },
        steps: [click, goto],
      }),
    ).toThrow();
  });

  it("rejects consecutive waits", () => {
    expect(() =>
      Flow.parse({
        schemaVersion: 1,
        useCaseId: "uc_1",
        title: { en: "a", ja: "あ" },
        steps: [goto, { do: "wait", ms: 100 }, { do: "wait", ms: 100 }],
      }),
    ).toThrow();
  });

  it("rejects an absolute url in goto", () => {
    expect(() => Step.parse({ do: "goto", path: "https://evil.example.com" })).toThrow();
  });

  it("rejects an empty target", () => {
    expect(() => Target.parse({})).toThrow();
  });

  it("caps a flow at 30 steps", () => {
    const steps = [goto, ...Array.from({ length: 30 }, () => click)];
    expect(() =>
      Flow.parse({ schemaVersion: 1, useCaseId: "uc", title: { en: "a", ja: "あ" }, steps }),
    ).toThrow();
  });
});

describe("RepoProfile", () => {
  it("round-trips a detected profile", () => {
    const p = RepoProfile.parse({
      framework: "vite",
      packageManager: "npm",
      nodeVersion: "22",
      appRoot: "",
      build: { install: "npm ci", build: "npm run build", start: "npm start", port: 3100 },
      e2e: {
        kind: "playwright",
        configPath: "playwright.config.ts",
        testDir: "e2e",
        specPaths: ["e2e/a.spec.ts"],
        storageStatePath: "e2e/.auth/user.json",
      },
      env: [{ key: "API_URL", source: ".env.example", strategy: "placeholder" }],
      confidence: 0.9,
    });
    expect(p.framework).toBe("vite");
    expect(p.e2e?.specPaths).toHaveLength(1);
  });
});

describe("errors", () => {
  it("keeps the original code when normalising", () => {
    const e = toSdvError(new SdvError("SDV-E021", "build blew up"));
    expect(e.code).toBe("SDV-E021");
    expect(e.hint).toMatch(/build log/i);
  });

  it("falls back to the given code for unknown throws", () => {
    expect(toSdvError("boom", "SDV-E050").code).toBe("SDV-E050");
  });
});

describe("util", () => {
  it("redacts credential-shaped strings", () => {
    const out = redact("token sk-ant-abcdefghijklmno and ghp_012345678901234567890123");
    expect(out).not.toContain("abcdefghijklmno");
    expect(out).toContain("sk-ant-***");
    expect(out).toContain("gh*_***");
  });

  it("eases from 0 to 1 monotonically", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.25)).toBeLessThan(easeInOut(0.75));
  });
});
