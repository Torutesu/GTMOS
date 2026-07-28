import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CaptureManifest, Flow, loadConfig, waitFor } from "@sdv/core";
import { migrate, openDb, type Db } from "@sdv/db";
import { createMockLlm } from "@sdv/llm";
import { capture, createSandbox, createStorage, nonBackgroundRatio, type StageContext } from "@sdv/pipeline";
import type { StartedProcess } from "@sdv/pipeline";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/demo-app", import.meta.url));
const PORT = 3177;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let dir: string;
let db: Db;
let app: StartedProcess;
let ctx: StageContext;

const FLOW = Flow.parse({
  schemaVersion: 1,
  useCaseId: "uc_invite",
  title: { en: "Invite a teammate", ja: "メンバーを招待する" },
  steps: [
    { do: "goto", path: "/settings/team", caption: { en: "Open the team page", ja: "チーム画面を開く" } },
    {
      do: "fill",
      target: { label: "Email address" },
      value: "noor@northwind.design",
      caption: { en: "Enter their email", ja: "メールアドレスを入力" },
    },
    {
      do: "select",
      target: { label: "Role" },
      value: "Editor",
      caption: { en: "Choose their role", ja: "権限を選ぶ" },
    },
    {
      do: "click",
      target: { role: { role: "button", name: "Send invite" } },
      caption: { en: "Send the invite", ja: "招待を送る" },
    },
    {
      do: "expect",
      target: { text: "Invitation sent to noor@northwind.design" },
      caption: { en: "It is on its way", ja: "送信できた" },
    },
  ],
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdv-capture-"));
  db = await openDb({ databaseUrl: null, dbDir: join(dir, "db") });
  await migrate(db);

  const sandbox = createSandbox("local");
  app = sandbox.start(`npx vite preview --port ${PORT} --host 127.0.0.1`, { cwd: FIXTURE });
  const up = await waitFor(
    async () => {
      try {
        return (await fetch(BASE_URL)).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 60_000, intervalMs: 400 },
  );
  if (!up) throw new Error(`fixture app never came up on ${BASE_URL}:\n${app.output()}`);

  ctx = {
    cfg: loadConfig({ varDir: dir }),
    db,
    storage: createStorage({ driver: "fs", root: join(dir, "storage") }),
    sandbox,
    llm: createMockLlm(),
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return ctx.log; } },
    runId: "run_test",
    projectId: "prj_test",
    workDir: join(dir, "work"),
    progress: () => {},
  };
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("capture", () => {
  it("records pixels and structure for every step of a real flow", async () => {
    const out = join(dir, "capture-desktop");
    // The session the fixture's own e2e setup produced, reused verbatim.
    const storageState = JSON.parse(await readFile(join(FIXTURE, "e2e/.auth/user.json"), "utf8"));

    const result = await capture(ctx, {
      baseUrl: BASE_URL,
      flow: FLOW,
      useCaseId: "uc_invite",
      storageState,
      outDir: out,
    });

    expect(result.brokenSteps).toEqual([]);
    const manifest = CaptureManifest.parse(
      JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
    );
    expect(manifest.steps).toHaveLength(FLOW.steps.length);
    expect(manifest.fidelity).toBe("L2");
    expect(manifest.viewport.name).toBe("desktop");

    for (const step of manifest.steps) {
      expect(step.ok).toBe(true);
      const after = await readFile(join(out, step.afterPng));
      expect(after.byteLength).toBeGreaterThan(1000);
      // pixels and structure, from the same moment
      expect(step.domJson).not.toBeNull();
      const dom = JSON.parse(await readFile(join(out, step.domJson!), "utf8"));
      expect(dom.html).toContain("<body");
      expect(dom.styles.join("").length).toBeGreaterThan(100);
    }

    // interactive targets are what the demo player turns into hotspots
    const click = manifest.steps.find((s) => s.do === "click")!;
    expect(click.targetBox).not.toBeNull();
    expect(click.targetBox!.w).toBeGreaterThan(10);
    expect(click.clickPoint).not.toBeNull();

    // the flow actually changed the app, rather than filming a static page
    const last = manifest.steps.at(-1)!;
    const lastDom = JSON.parse(await readFile(join(out, last.domJson!), "utf8"));
    expect(lastDom.html).toContain("Invitation sent to noor@northwind.design");

    // page assets travel with the bundle so the replay needs no network
    const assets = await readdir(join(out, "assets"));
    expect(assets).toContain("manifest.json");

    // and the screens are not blank
    expect(await nonBackgroundRatio(await readFile(join(out, last.afterPng)))).toBeGreaterThan(0.05);
  }, 180_000);

  it("marks a step broken instead of failing the whole capture", async () => {
    const out = join(dir, "capture-broken");
    const flow = Flow.parse({
      ...FLOW,
      steps: [
        FLOW.steps[0]!,
        { do: "click", target: { role: { role: "button", name: "This Button Does Not Exist" } } },
        FLOW.steps[1]!,
      ],
    });

    const result = await capture(ctx, {
      baseUrl: BASE_URL,
      flow,
      useCaseId: "uc_invite",
      storageState: JSON.parse(await readFile(join(FIXTURE, "e2e/.auth/user.json"), "utf8")),
      outDir: out,
      withDom: false,
    });

    expect(result.brokenSteps).toEqual([1]);
    expect(result.manifest.steps[1]!.ok).toBe(false);
    expect(result.manifest.steps[1]!.errorCode).toBe("SDV-E050");
    // the steps around it still ran
    expect(result.manifest.steps[0]!.ok).toBe(true);
    expect(result.manifest.steps[2]!.ok).toBe(true);
  }, 180_000);
});
