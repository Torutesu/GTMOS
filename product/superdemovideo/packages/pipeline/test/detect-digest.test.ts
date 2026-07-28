import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detect } from "@sdv/pipeline";
import { buildDigest, parseSpecFile } from "@sdv/pipeline";
import { createMockLlm, renderDigest } from "@sdv/llm";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/demo-app", import.meta.url));

describe("detect", () => {
  it("reads the fixture's build profile from the repository alone", async () => {
    const p = await detect(FIXTURE);
    expect(p.framework).toBe("vite");
    expect(p.packageManager).toBe("npm");
    expect(p.appRoot).toBe("");
    expect(p.build.install).toBe("npm ci");
    expect(p.build.build).toBe("npm run build");
    expect(p.build.start).toBe("npm run start");
    expect(p.build.port).toBe(3100);
    expect(p.confidence).toBeGreaterThan(0.8);
  });

  it("finds the playwright suite and its storage state", async () => {
    const p = await detect(FIXTURE);
    expect(p.e2e?.kind).toBe("playwright");
    expect(p.e2e?.testDir).toBe("e2e");
    expect(p.e2e?.storageStatePath).toBe("e2e/.auth/user.json");
    expect(p.e2e?.specPaths).toContain("e2e/invite-team-member.spec.ts");
    expect(p.e2e?.specPaths).toContain("e2e/auth.setup.ts");
  });

  it("lists the placeholder env keys without reading any real value", async () => {
    const p = await detect(FIXTURE);
    expect(p.env.map((e) => e.key)).toEqual(["VITE_API_URL", "VITE_WORKSPACE_NAME"]);
    expect(p.env.every((e) => e.strategy === "placeholder")).toBe(true);
  });
});

describe("spec parsing", () => {
  it("recovers roles and names from Playwright locators", async () => {
    const src = await readFile(join(FIXTURE, "e2e/invite-team-member.spec.ts"), "utf8");
    const [spec] = parseSpecFile(src, "e2e/invite-team-member.spec.ts");
    expect(spec!.title).toBe("invite a team member");
    expect(spec!.isSetup).toBe(false);

    const kinds = spec!.actions.map((a) => a.kind);
    expect(kinds).toEqual(["goto", "fill", "select", "click", "expect"]);

    const goto = spec!.actions[0]!;
    expect(goto.value).toBe("/settings/team");

    const fill = spec!.actions[1]!;
    expect(fill.locator).toBe("getByLabel");
    expect(fill.name).toBe("Email address");
    expect(fill.value).toBe("noor@northwind.design");

    const click = spec!.actions[3]!;
    expect(click.locator).toBe("getByRole");
    expect(click.role).toBe("button");
    expect(click.name).toBe("Send invite");
  });

  it("marks the auth setup so it is never offered as a demo", async () => {
    const src = await readFile(join(FIXTURE, "e2e/auth.setup.ts"), "utf8");
    const [spec] = parseSpecFile(src, "e2e/auth.setup.ts");
    expect(spec!.isSetup).toBe(true);
  });
});

describe("digest", () => {
  it("collects routes, specs and prose", async () => {
    const profile = await detect(FIXTURE);
    const digest = await buildDigest(FIXTURE, profile);

    expect(digest.projectName).toBe("taskloop");
    expect(digest.routes.map((r) => r.path)).toEqual(
      expect.arrayContaining(["/dashboard", "/login", "/settings/team", "/tasks/new"]),
    );
    expect(digest.specs.filter((s) => !s.isSetup)).toHaveLength(3);
    expect(digest.readme).toContain("Taskloop");
    expect(digest.approxTokens).toBeGreaterThan(200);
  });

  it("renders identically twice, so it can be cached across calls", async () => {
    const profile = await detect(FIXTURE);
    const a = renderDigest(await buildDigest(FIXTURE, profile));
    const b = renderDigest(await buildDigest(FIXTURE, profile));
    expect(a).toBe(b);
    expect(a).toContain("### invite a team member");
  });
});

describe("mock llm", () => {
  it("derives candidates from the suite, preferring tests over routes", async () => {
    const profile = await detect(FIXTURE);
    const digest = await buildDigest(FIXTURE, profile);
    const llm = createMockLlm();
    const cases = await llm.extractUseCases(digest);

    expect(cases.length).toBeGreaterThanOrEqual(3);
    const invite = cases.find((c) => c.origin === "e2e/invite-team-member.spec.ts");
    expect(invite).toBeDefined();
    expect(invite!.signals).toContain("e2e-test");
    expect(invite!.entryRoute).toBe("/settings/team");
    // the auth setup must never become a demo
    expect(cases.some((c) => c.origin?.includes("auth.setup"))).toBe(false);
  });

  it("turns a spec into a valid flow with stable targets", async () => {
    const profile = await detect(FIXTURE);
    const digest = await buildDigest(FIXTURE, profile);
    const llm = createMockLlm();
    const [draft] = (await llm.extractUseCases(digest)).filter(
      (c) => c.origin === "e2e/invite-team-member.spec.ts",
    );
    const flow = await llm.generateFlow(digest, { ...draft!, id: "uc_test" });

    expect(flow.steps[0]!.do).toBe("goto");
    const click = flow.steps.find((s) => s.do === "click");
    expect(click).toBeDefined();
    expect((click as { target: { role?: unknown } }).target.role).toEqual({
      role: "button",
      name: "Send invite",
    });
    // no CSS selectors: they are the first thing to break on a UI change
    expect(JSON.stringify(flow)).not.toContain('"css"');
  });

  it("is deterministic", async () => {
    const profile = await detect(FIXTURE);
    const digest = await buildDigest(FIXTURE, profile);
    const llm = createMockLlm();
    const a = await llm.extractUseCases(digest);
    const b = await llm.extractUseCases(digest);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
