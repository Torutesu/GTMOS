#!/usr/bin/env tsx
/**
 * Acceptance: one command, mock mode, no network.
 *
 * This is the definition of "M1 works". It drives the product the way a user
 * does — over HTTP, through the queue, against the golden fixture — and
 * asserts on the files that come out, not on the code that made them. If this
 * passes on a clean checkout, the milestone is done.
 */
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { countFlows, getProject, listArtifacts, listRuns, listStages } from "@sdv/db";
import { createRuntime, startServer, type Runtime, type ServerHandle } from "@sdv/api";
import { runDoctor } from "./doctor.ts";

const exec = promisify(execFile);
const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const FIXTURE = join(ROOT, "fixtures", "demo-app");
const TEAM_PAGE = join(FIXTURE, "src", "pages", "TeamPage.tsx");

const ANALYSE_TIMEOUT_MS = 8 * 60 * 1000;
const PRODUCE_TIMEOUT_MS = 12 * 60 * 1000;

/* ------------------------------ test harness ----------------------------- */

let passed = 0;
const failures: string[] = [];
const started = Date.now();

function assert(condition: unknown, message: string): asserts condition {
  if (condition) {
    passed++;
    console.log(`    ok   ${message}`);
  } else {
    failures.push(message);
    console.log(`    FAIL ${message}`);
  }
}

async function step<T>(title: string, fn: () => Promise<T>): Promise<T> {
  const at = Date.now();
  console.log(`\n${title}`);
  const result = await fn();
  console.log(`    (${((Date.now() - at) / 1000).toFixed(1)}s)`);
  return result;
}

/* --------------------------------- main ---------------------------------- */

let rt: Runtime | null = null;
let server: ServerHandle | null = null;
let varDir = "";
let teamPageOriginal: string | null = null;

async function main(): Promise<void> {
  varDir = await mkdtemp(join(tmpdir(), "sdv-accept-"));

  /* 1 ------------------------------------------------------------------- */
  await step("1. The machine has everything a run needs", async () => {
    const checks = await runDoctor();
    for (const c of checks) {
      assert(c.ok || !c.fatal, `doctor: ${c.name} — ${c.detail}`);
    }
  });

  /* 2 ------------------------------------------------------------------- */
  const api = await step("2. The API starts against a throwaway var directory", async () => {
    rt = await createRuntime({ varDir, llmMode: "mock", token: null, port: 0 });
    server = await startServer(rt, { port: 0 });
    const base = server.url;
    const health = await fetch(`${base}/healthz`).then((r) => r.json());
    assert(health.ok === true, "GET /healthz is ok");
    assert(health.llmMode === "mock", "running in mock mode — no key, no network");
    return base;
  });

  const http = client(api);

  /* 3 ------------------------------------------------------------------- */
  const projectId = await step("3. A project is created from the golden fixture", async () => {
    const { project } = await http.post<{ project: { id: string } }>("/v1/projects", {
      name: "Taskloop",
      source: { kind: "local", path: FIXTURE },
      ctaUrl: "https://example.com/signup",
    });
    assert(project.id.startsWith("prj_"), `project created (${project.id})`);
    return project.id;
  });

  /* 4 ------------------------------------------------------------------- */
  const runId = await step("4. The first run reaches the point a human decides", async () => {
    const { run } = await http.post<{ run: { id: string } }>(`/v1/projects/${projectId}/runs`, {
      kind: "initial",
    });
    const final = await waitForRun(http, run.id, ["awaiting_selection"], ANALYSE_TIMEOUT_MS);
    assert(final.status === "awaiting_selection", `run is awaiting a selection (${run.id})`);

    const project = await getProject(rt!.db, projectId);
    assert(project?.repo_profile?.framework === "vite", "detect recognised a Vite app");
    assert(
      (project?.repo_profile?.e2e?.specPaths.length ?? 0) >= 3,
      "detect found the Playwright specs",
    );
    return run.id;
  });

  /* 5 ------------------------------------------------------------------- */
  const useCaseId = await step("5. The candidates include one taken from an E2E spec", async () => {
    const { useCases } = await http.get<{ useCases: UseCase[] }>(`/v1/runs/${runId}/use-cases`);
    assert(useCases.length >= 3, `${useCases.length} candidates offered (need 3)`);

    const invite = useCases.find((c) => (c.origin ?? "").includes("invite-team-member"));
    assert(invite !== undefined, "one candidate comes from invite-team-member.spec.ts");
    assert(
      Boolean(invite?.title?.en) && Boolean(invite?.title?.ja),
      "candidates are written in both languages",
    );
    return invite!.id;
  });

  /* 6 ------------------------------------------------------------------- */
  await step("6. Choosing it films the demo to completion", async () => {
    await http.post(`/v1/use-cases/${useCaseId}/select`);
    const final = await waitForRun(http, runId, ["succeeded"], PRODUCE_TIMEOUT_MS);
    assert(
      final.status === "succeeded",
      `run succeeded${final.error_code ? ` (was ${final.error_code}: ${final.error_detail})` : ""}`,
    );
  });

  const artifacts = await listArtifacts(rt!.db, runId);
  const artifact = (kind: string) => artifacts.find((a) => a.kind === kind);
  const files = (kind: string) => (artifact(kind)?.files ?? {}) as Record<string, string>;

  /* 7 ------------------------------------------------------------------- */
  await step("7. Every cut is a real H.264 file of a sensible length", async () => {
    const landscape = files("video_169")["video_169.mp4"];
    const portrait = files("video_916")["video_916.mp4"];
    const square = files("video_11")["video_11.mp4"];
    assert(landscape !== undefined && existsSync(landscape), "video_169.mp4 exists");
    assert(portrait !== undefined && existsSync(portrait), "video_916.mp4 exists");
    assert(square !== undefined && existsSync(square), "video_11.mp4 exists");

    for (const [label, path, w, h] of [
      ["16:9", landscape, 1920, 1080],
      ["9:16", portrait, 1080, 1920],
      ["1:1", square, 1080, 1080],
    ] as const) {
      if (!path) continue;
      const probe = await ffprobe(path);
      assert(probe.codec === "h264", `${label} is h264 (${probe.codec})`);
      assert(probe.width === w && probe.height === h, `${label} is ${w}x${h} (${probe.width}x${probe.height})`);
      assert(probe.fps === 30, `${label} is 30fps (${probe.fps})`);
      assert(
        probe.duration >= 15 && probe.duration <= 70,
        `${label} runs ${probe.duration.toFixed(1)}s (want 15–70)`,
      );
    }
  });

  /* 8 ------------------------------------------------------------------- */
  await step("8. The interactive demo is complete and can be clicked through", async () => {
    const demoDir = files("demo")["demoDir"];
    assert(demoDir !== undefined && existsSync(join(demoDir, "index.html")), "demo/index.html exists");
    assert(existsSync(join(demoDir!, "demo.json")), "demo/demo.json exists");

    const manifest = JSON.parse(await readFile(join(demoDir!, "demo.json"), "utf8")) as {
      steps: unknown[];
      cta: unknown;
    };
    const flowSteps = await flowStepCount(projectId);
    assert(
      manifest.steps.length === flowSteps,
      `the demo has one step per flow step (${manifest.steps.length} of ${flowSteps})`,
    );
    assert(manifest.cta !== null, "the CTA travelled with the demo");

    const player = await readFile(join(demoDir!, "player.js"));
    const gzip = gzipSync(player).byteLength;
    assert(gzip < 50 * 1024, `player.js is ${(gzip / 1024).toFixed(1)}KB gzipped (budget 50KB)`);

    // Over HTTP, not file:// — the player fetches demo.json, and a file URL
    // has no origin to fetch from. Serving it the way a visitor gets it is
    // also the only version of this assertion worth trusting.
    const demoUrl = `${api}/v1/artifacts/${artifact("demo")!.id}/files/index.html`;
    const { reached, blocked } = await clickThroughDemo(demoUrl, manifest.steps.length);
    assert(
      reached === manifest.steps.length - 1,
      `a real browser clicked to the last step (reached ${reached + 1} of ${manifest.steps.length})`,
    );
    assert(
      blocked.length === 0,
      `the replayed page loaded every asset it needs${blocked.length ? ` (blocked: ${blocked[0]})` : ""}`,
    );

    // The single-file export is the version that leaves the machine.
    const exported = await fetch(`${api}/v1/runs/${runId}/standalone.html`);
    assert(exported.status === 200, "the demo exports as one file");
    const single = join(rt!.cfg.workDir, "standalone.html");
    await writeFile(single, await exported.text());

    const offline = await clickThroughDemo(`file://${single}`, manifest.steps.length, {
      countExternal: true,
    });
    assert(
      offline.reached === manifest.steps.length - 1,
      `…and clicks through from a file:// URL (reached ${offline.reached + 1})`,
    );
    assert(
      offline.external === 0,
      `…making no network requests at all (${offline.external} attempted)`,
    );
  });

  /* 9 ------------------------------------------------------------------- */
  await step("9. Captions and a poster ship alongside the video", async () => {
    const f = files("video_169");
    for (const name of ["captions.en.srt", "captions.ja.srt", "poster.png"]) {
      assert(f[name] !== undefined && existsSync(f[name]!), `${name} exists`);
    }
    const srt = await readFile(f["captions.en.srt"]!, "utf8");
    assert(/^1\r?\n00:00:/.test(srt.trimStart()), "the English SRT starts with a numbered cue");
    const ja = await readFile(f["captions.ja.srt"]!, "utf8");
    assert(ja.length > 0 && ja !== srt, "the Japanese SRT is present and different");
  });

  /* 10 ------------------------------------------------------------------ */
  const slug = await step("10. Publishing puts it behind a stable URL", async () => {
    await http.post("/v1/publications", { runId });
    const published = await waitFor(
      async () => {
        const { publication } = await http.get<{ publication: Pub | null }>(
          `/v1/projects/${projectId}`,
        );
        return publication?.run_id === runId ? publication : null;
      },
      60_000,
      "the demo to go live",
    );
    assert(published.alias_slug.length > 0, `published as /d/${published.alias_slug}`);

    const page = await fetch(`${api}/d/${published.alias_slug}`);
    assert(page.status === 200, "GET /d/{slug} serves the demo");
    assert((await page.text()).includes("data-demo"), "…and it is the player page");

    // The manifest has to resolve from the page's own URL, or the player boots
    // into an empty frame on a page that returned 200.
    const res = await fetch(`${api}/d/${published.alias_slug}/demo.json`);
    assert(res.status === 200, "…and its manifest resolves relative to it");
    const publicManifest = (await res.json()) as { steps: unknown[] };

    const clicked = await clickThroughDemo(
      `${api}/d/${published.alias_slug}/`,
      publicManifest.steps.length,
    );
    assert(clicked.blocked.length === 0, "the published demo loads every asset it needs");

    const badge = await fetch(`${api}/badge/${published.alias_slug}.svg`);
    assert(badge.status === 200, "GET /badge/{slug}.svg serves an image");
    assert((await badge.text()).includes("synced"), "the badge reads synced");
    return published.alias_slug;
  });

  /* 11 ------------------------------------------------------------------ */
  await step("11. Changing the UI makes the demo stale, and regeneration says what moved", async () => {
    teamPageOriginal = await readFile(TEAM_PAGE, "utf8");
    // Visible copy that no step targets. A change to a selector's own label
    // would break the step instead of moving it, and this assertion is about
    // the pixel comparison — the broken-step path is a different test.
    const edited = teamPageOriginal.replace(
      "Who can see and change work in",
      "Everyone who can see and change work inside",
    );
    assert(edited !== teamPageOriginal, "the fixture's visible copy was changed");
    await writeFile(TEAM_PAGE, edited);

    const flowsBefore = await countFlows(rt!.db, projectId);

    const { run } = await http.post<{ run: { id: string } }>(`/v1/projects/${projectId}/runs`, {
      kind: "regen",
    });
    const final = await waitForRun(http, run.id, ["succeeded"], PRODUCE_TIMEOUT_MS);
    assert(
      final.status === "succeeded",
      `the regeneration finished${final.error_code ? ` (was ${final.error_code}: ${final.error_detail})` : ""}`,
    );

    const flowsAfter = await countFlows(rt!.db, projectId);
    assert(flowsAfter === flowsBefore, "the stored flow was reused, not regenerated");

    const detail = await http.get<{ diff: Diff | null }>(`/v1/runs/${run.id}`);
    assert(detail.diff !== null, "a diff report was produced");
    assert(
      (detail.diff?.changedCount ?? 0) >= 1,
      `${detail.diff?.changedCount ?? 0} step(s) reported as changed`,
    );
    assert(
      (detail.diff?.brokenCount ?? 0) === 0,
      `every step still resolved after the change (${detail.diff?.brokenCount ?? 0} broken)`,
    );

    const stale = await fetch(`${api}/badge/${slug}.svg`).then((r) => r.text());
    assert(stale.includes("stale"), "the badge turned stale while the new run waits for approval");

    await http.post("/v1/publications", { runId: run.id });
    await waitFor(
      async () => {
        const svg = await fetch(`${api}/badge/${slug}.svg`).then((r) => r.text());
        return svg.includes("synced") ? svg : null;
      },
      60_000,
      "the badge to go green again",
    );
    assert(true, "publishing the new run makes it synced again");

    const page = await fetch(`${api}/d/${slug}`);
    assert(page.status === 200, "the public URL never changed");
  });

  /* 12 ------------------------------------------------------------------ */
  await step("12. Every stage that ran recorded how long it took", async () => {
    const runs = await listRuns(rt!.db, projectId);
    for (const run of runs.filter((r) => r.status === "succeeded")) {
      const stages = await listStages(rt!.db, run.id);
      const seconds = (run.cost as { stageSeconds?: Record<string, number> }).stageSeconds ?? {};
      const missing = stages
        .filter((s) => s.status === "succeeded")
        .map((s) => s.stage)
        .filter((name) => seconds[name] === undefined);
      assert(missing.length === 0, `${run.id}: every stage is costed${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
      assert(
        ((run.cost as { totalSeconds?: number }).totalSeconds ?? 0) > 0,
        `${run.id}: total time is recorded`,
      );
    }
  });
}

/* ------------------------------- assertions ------------------------------ */

interface UseCase {
  id: string;
  title: { en: string; ja: string };
  origin: string | null;
}
interface Pub {
  alias_slug: string;
  run_id: string;
}
interface Diff {
  changedCount: number;
  brokenCount: number;
}
interface RunView {
  id: string;
  status: string;
  error_code: string | null;
  error_detail: string | null;
}

function client(base: string) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
  return {
    get: <T,>(path: string) => request<T>("GET", path),
    post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  };
}

async function waitForRun(
  http: ReturnType<typeof client>,
  runId: string,
  wanted: string[],
  timeoutMs: number,
): Promise<RunView> {
  let last = "";
  const run = await waitFor(
    async () => {
      const { run } = await http.get<{ run: RunView }>(`/v1/runs/${runId}`);
      if (run.status !== last) {
        last = run.status;
        console.log(`    …${run.status}`);
      }
      if (wanted.includes(run.status) || run.status === "failed") return run;
      return null;
    },
    timeoutMs,
    `run ${runId} to reach ${wanted.join(" or ")}`,
  );
  return run;
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* --------------------------------- probes -------------------------------- */

async function ffprobe(
  path: string,
): Promise<{ codec: string; width: number; height: number; fps: number; duration: number }> {
  const mod = (await import("ffprobe-static")) as unknown as { default: { path: string } };
  const bin = mod.default.path;
  await chmod(bin, 0o755).catch(() => {});
  const { stdout } = await exec(bin, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,avg_frame_rate:format=duration",
    "-of",
    "json",
    path,
  ]);
  const data = JSON.parse(stdout) as {
    streams: Array<{ codec_name: string; width: number; height: number; avg_frame_rate: string }>;
    format: { duration: string };
  };
  const s = data.streams[0]!;
  const [num, den] = s.avg_frame_rate.split("/").map(Number);
  return {
    codec: s.codec_name,
    width: s.width,
    height: s.height,
    fps: Math.round((num ?? 0) / (den || 1)),
    duration: Number(data.format.duration),
  };
}

/**
 * Open the emitted demo in a real browser and click to the end.
 *
 * A demo whose files exist but whose hotspots do not advance is worse than no
 * demo: the visitor clicks, nothing happens, and they leave. This is the only
 * assertion that can catch that, so it runs the actual player in actual
 * Chromium rather than inspecting the JSON that describes it.
 */
async function clickThroughDemo(
  demoUrl: string,
  expectedSteps: number,
  opts: { countExternal?: boolean } = {},
): Promise<{ reached: number; blocked: string[]; external: number }> {
  const { chromium } = await import("playwright-core");
  const executablePath = await findChromium();
  const browser = await chromium.launch({ executablePath: executablePath ?? undefined });
  const blocked: string[] = [];
  let external = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    if (opts.countExternal) {
      page.on("request", (r) => {
        const url = r.url();
        if (!url.startsWith("file:") && !url.startsWith("data:") && !url.startsWith("about:")) {
          external++;
        }
      });
    }
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // A replayed page that cannot load its own stylesheet renders as naked
      // HTML — the files all exist and the demo still looks broken.
      if (/CORS|ERR_FAILED|Failed to load/i.test(text) && !blocked.includes(text)) {
        blocked.push(text);
      }
    });
    await page.goto(demoUrl);
    await page.waitForSelector(".sdv-dot", { timeout: 20_000 });

    // `.sdv-btn` is also the class on the CTA link that appears at the end, so
    // the Next button is addressed by role — matching on class alone becomes
    // ambiguous exactly when the demo reaches the state we are testing for.
    const next = page.getByRole("button", { name: "Next" });
    for (let i = 0; i < expectedSteps + 2; i++) {
      if (await next.isDisabled()) break;
      const hotspot = page.locator(".sdv-hot").first();
      if (await hotspot.count()) await hotspot.click({ timeout: 5000 }).catch(() => {});
      else await next.click({ timeout: 5000 });
      await page.waitForTimeout(120);
    }

    const current = await page.locator('.sdv-dot[aria-current="true"]').first();
    const label = (await current.getAttribute("aria-label")) ?? "Step 1";
    return { reached: Number(label.replace(/\D/g, "")) - 1, blocked, external };
  } finally {
    await browser.close();
  }
}

async function findChromium(): Promise<string | null> {
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (!root) return null;
  const entries = await readdir(root).catch(() => [] as string[]);
  const dirs = entries
    .filter((e) => e.startsWith("chromium") && !e.includes("headless_shell"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const candidate = join(root, d, "chrome-linux", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function flowStepCount(projectId: string): Promise<number> {
  const { latestFlowForProject } = await import("@sdv/db");
  const row = await latestFlowForProject(rt!.db, projectId);
  const flow = row?.flow_json as { steps: Array<{ do: string }> } | undefined;
  // `goto` and `wait` steps move the app along but are not screens a visitor
  // clicks, so the demo carries one entry per captured step, not per DSL step.
  return flow?.steps.length ?? 0;
}

/* -------------------------------- teardown ------------------------------- */

async function cleanup(): Promise<void> {
  if (teamPageOriginal !== null) {
    await writeFile(TEAM_PAGE, teamPageOriginal).catch(() => {});
    console.log("\n    restored the fixture");
  }
  await server?.close().catch(() => {});
  await rt?.close().catch(() => {});
  if (varDir) await rm(varDir, { recursive: true, force: true }).catch(() => {});
}

main()
  .catch((err) => {
    failures.push(`the run stopped early: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\n${err instanceof Error ? err.stack : String(err)}`);
  })
  .finally(async () => {
    await cleanup();
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`\n${"─".repeat(60)}`);
    if (failures.length === 0) {
      console.log(`${passed} assertions passed in ${seconds}s. M1 is accepted.`);
      process.exit(0);
    }
    console.log(`${passed} passed, ${failures.length} failed in ${seconds}s:\n`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  });
