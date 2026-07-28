import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CaptureManifest,
  Flow,
  SdvError,
  toSdvError,
  type RepoProfile,
  type Stage,
  type UseCase,
} from "@sdv/core";
import {
  finishStage,
  getProject,
  getRun,
  getUseCase,
  latestFlowForProject,
  insertArtifact,
  insertCapture,
  listRuns,
  mergeRunCost,
  selectUseCase,
  setRepoProfile,
  setRunStatus,
  startStage,
} from "@sdv/db";
import type { RepoDigest } from "@sdv/llm";
import { ensureWorkDirs, stagePaths, type StageContext } from "./context.ts";
import { ingest } from "./stages/ingest.ts";
import { detect } from "./stages/detect.ts";
import { build } from "./stages/build.ts";
import { seed, type SeedResult } from "./stages/seed.ts";
import { understand } from "./stages/understand.ts";
import { flowgen } from "./stages/flowgen.ts";
import { capture, type CaptureOutcome } from "./stages/capture.ts";
import { compose } from "./stages/compose.ts";
import { emit } from "./stages/emit.ts";
import { diff } from "./stages/diff.ts";

export const TEMPLATES_DIR = fileURLToPath(new URL("../../../templates", import.meta.url));
const LAUNCH_TEMPLATE = join(TEMPLATES_DIR, "launch");

/**
 * Run orchestration.
 *
 * The run is split at the point a human has to choose. Analysis only reads
 * source, so it finishes in seconds and the candidate list is ready almost
 * immediately; production then builds, films and renders in one uninterrupted
 * pass. The split is deliberate — holding a preview server alive across an
 * open-ended wait for someone to pick a candidate leaks a process every time
 * they never come back.
 */

/* ----------------------------- phase: analyse ---------------------------- */

export interface AnalyseResult {
  profile: RepoProfile;
  useCases: UseCase[];
  gitSha: string;
}

export async function analyse(ctx: StageContext): Promise<AnalyseResult> {
  await ensureWorkDirs(ctx.workDir);
  await setRunStatus(ctx.db, ctx.runId, "running");

  const { gitSha } = await timed(ctx, "ingest", () => ingest(ctx));
  await setRunStatus(ctx.db, ctx.runId, "running", { gitSha });

  const project = await getProject(ctx.db, ctx.projectId);
  const paths = stagePaths(ctx.workDir);

  const profile = await timed(ctx, "detect", async () => {
    // A profile the user already corrected wins over anything we infer.
    const detected = await detect(paths.src, project?.app_root ?? "");
    const stored = project?.repo_profile;
    return stored ? { ...detected, ...stored } : detected;
  });
  await setRepoProfile(ctx.db, ctx.projectId, profile);

  const { digest, useCases } = await timed(ctx, "understand", () =>
    understand(ctx, paths.src, profile),
  );

  // Carry the digest into the production phase: it is the expensive input and
  // it does not change between the two.
  await ctx.storage.put(`runs/${ctx.runId}/digest.json`, JSON.stringify(digest));

  await setRunStatus(ctx.db, ctx.runId, "awaiting_selection");
  await recordLlmCost(ctx);
  return { profile, useCases, gitSha };
}

/* ---------------------------- phase: production -------------------------- */

export interface ProduceOptions {
  useCaseId?: string;
  /** Reuse the project's existing flow instead of generating one. */
  reuseFlow?: boolean;
  watermark?: boolean;
}

export interface ProduceResult {
  captureDir: string;
  manifest: CaptureManifest;
  videoArtifacts: string[];
  demoArtifact: string;
  brokenSteps: number[];
}

export async function produce(ctx: StageContext, opts: ProduceOptions): Promise<ProduceResult> {
  const paths = stagePaths(ctx.workDir);
  const project = await getProject(ctx.db, ctx.projectId);
  if (!project?.repo_profile) throw new SdvError("SDV-E010", "no build profile for this project");
  const profile = project.repo_profile;

  await setRunStatus(ctx.db, ctx.runId, "running");

  // Resolve the flow first: it decides the entry route the seed check uses.
  let flow: Flow;
  let useCase: UseCase | null = null;

  if (opts.reuseFlow) {
    const row = await latestFlowForProject(ctx.db, ctx.projectId);
    if (!row) throw new SdvError("SDV-E050", "no existing flow to regenerate from");
    flow = Flow.parse(row.flow_json);
    ctx.log.info("reusing the stored flow", { flowId: row.id, version: row.version });
  } else {
    if (!opts.useCaseId) throw new SdvError("SDV-E900", "no use case chosen");
    const row = await getUseCase(ctx.db, opts.useCaseId);
    if (!row) throw new SdvError("SDV-E900", `unknown use case ${opts.useCaseId}`);
    await selectUseCase(ctx.db, opts.useCaseId);
    useCase = {
      id: row.id,
      title: row.title as UseCase["title"],
      hypothesis: row.hypothesis as UseCase["hypothesis"],
      entryRoute: row.entry_route,
      outline: row.outline as string[],
      signals: row.signals as UseCase["signals"],
      origin: row.origin,
    };
    const digest = await loadDigest(ctx);
    ({ flow } = await timed(ctx, "flowgen", () => flowgen(ctx, digest, useCase!)));
  }

  const entryRoute = firstRoute(flow);

  // Build, seed, film, and take the app back down in one uninterrupted span.
  const app = await timed(ctx, "build", () => build(ctx, profile));
  let outcome: CaptureOutcome;
  let seeded: SeedResult;
  try {
    seeded = await timed(ctx, "seed", () => seed(ctx, profile, app.baseUrl, entryRoute));

    outcome = await timed(ctx, "capture", () =>
      capture(ctx, {
        baseUrl: app.baseUrl,
        flow,
        useCaseId: useCase?.id ?? flow.useCaseId,
        storageState: seeded.storageState,
        outDir: paths.capture,
      }),
    );
  } finally {
    await app.stop();
  }

  const captureRow = await insertCapture(ctx.db, {
    runId: ctx.runId,
    flowId: flow.useCaseId,
    bundlePath: paths.capture,
    viewport: outcome.manifest.viewport.name,
    bytes: 0,
  });

  const outDir = join(paths.out, "video");
  const composed = await timed(ctx, "compose", () =>
    compose(ctx, {
      bundleDir: outcome.dir,
      manifest: outcome.manifest,
      templateDir: LAUNCH_TEMPLATE,
      outDir,
      workDir: ctx.workDir,
      watermark: opts.watermark ?? true,
    }),
  );

  const videoArtifacts: string[] = [];
  for (const video of composed.videos) {
    const artifact = await insertArtifact(ctx.db, {
      runId: ctx.runId,
      captureId: captureRow.id,
      kind: video.name,
      templateVersion: composed.templateVersion,
      files: {
        [`${video.name}.mp4`]: video.path,
        ...(video.name === "video_169"
          ? {
              "poster.png": composed.poster,
              "captions.en.srt": composed.subtitles.en,
              "captions.ja.srt": composed.subtitles.ja,
            }
          : {}),
      },
      script: { durationSec: video.durationSec, width: video.width, height: video.height },
    });
    videoArtifacts.push(artifact.id);
  }

  const demoDir = join(paths.out, "demo");
  const emitted = await timed(ctx, "emit", () =>
    emit(ctx, {
      bundleDir: outcome.dir,
      manifest: outcome.manifest,
      outDir: demoDir,
      seededData: seeded.strategy !== "none",
      cta: project.cta_url ? { label: "Try it yourself", url: project.cta_url } : null,
    }),
  );

  const demoArtifact = await insertArtifact(ctx.db, {
    runId: ctx.runId,
    captureId: captureRow.id,
    kind: "demo",
    templateVersion: composed.templateVersion,
    files: { demoDir: emitted.dir },
    script: { steps: emitted.stepCount },
  });

  // Regeneration ends with a comparison against the last published run.
  const run = await getRun(ctx.db, ctx.runId);
  if (run?.kind === "regen") {
    await timed(ctx, "diff", async () => {
      const base = await previousSucceededRun(ctx);
      if (!base) {
        ctx.log.info("no earlier run to compare against");
        return;
      }
      const baseDir = ctx.storage.localPath(`runs/${base.id}/capture`);
      if (!baseDir || !(await ctx.storage.exists(`runs/${base.id}/capture/manifest.json`))) {
        ctx.log.warn("the earlier run kept no capture to compare against");
        return;
      }
      const baseManifest = CaptureManifest.parse(
        JSON.parse((await ctx.storage.get(`runs/${base.id}/capture/manifest.json`)).toString()),
      );
      await diff(ctx, {
        baseRunId: base.id,
        baseDir,
        baseManifest,
        newDir: outcome.dir,
        newManifest: outcome.manifest,
      });
    });
  }

  // Keep this run's capture so the next regeneration has something to diff.
  await ctx.storage.putDir(`runs/${ctx.runId}/capture`, outcome.dir);

  await recordLlmCost(ctx);
  await setRunStatus(ctx.db, ctx.runId, "succeeded");

  return {
    captureDir: outcome.dir,
    manifest: outcome.manifest,
    videoArtifacts,
    demoArtifact: demoArtifact.id,
    brokenSteps: outcome.brokenSteps,
  };
}

/* -------------------------------- helpers -------------------------------- */

async function loadDigest(ctx: StageContext): Promise<RepoDigest> {
  const raw = await ctx.storage.get(`runs/${ctx.runId}/digest.json`);
  return JSON.parse(raw.toString()) as RepoDigest;
}

function firstRoute(flow: Flow): string {
  const first = flow.steps[0];
  return first && first.do === "goto" ? first.path : "/";
}

async function previousSucceededRun(ctx: StageContext) {
  const runs = await listRuns(ctx.db, ctx.projectId);
  return runs.find((r) => r.id !== ctx.runId && r.status === "succeeded") ?? null;
}

/** Run one stage, recording its duration and normalising any failure. */
async function timed<T>(ctx: StageContext, stage: Stage, fn: () => Promise<T>): Promise<T> {
  const stageId = await startStage(ctx.db, ctx.runId, stage);
  const started = Date.now();
  ctx.progress({ stage, status: "running", message: `${stage} started` });
  try {
    const result = await fn();
    const seconds = Number(((Date.now() - started) / 1000).toFixed(3));
    await finishStage(ctx.db, stageId, "succeeded");
    await mergeRunCost(ctx.db, ctx.runId, { stageSeconds: { [stage]: seconds } });
    ctx.progress({ stage, status: "succeeded", message: `${stage} done in ${seconds}s` });
    return result;
  } catch (err) {
    const seconds = Number(((Date.now() - started) / 1000).toFixed(3));
    const sdv = toSdvError(err);
    await finishStage(ctx.db, stageId, "failed", {
      errorCode: sdv.code,
      errorDetail: sdv.detail ?? sdv.message,
      logPath: join(stagePaths(ctx.workDir).logs),
    });
    await mergeRunCost(ctx.db, ctx.runId, { stageSeconds: { [stage]: seconds } });
    await setRunStatus(ctx.db, ctx.runId, "failed", {
      errorCode: sdv.code,
      errorDetail: sdv.detail ?? sdv.message,
    });
    ctx.progress({ stage, status: "failed", message: `${sdv.code}: ${sdv.title}` });
    throw sdv;
  }
}

async function recordLlmCost(ctx: StageContext): Promise<void> {
  const usage = ctx.llm.usage();
  if (usage.length === 0) return;
  const llmUsd = usage.reduce((a, u) => a + u.usd, 0);
  await mergeRunCost(ctx.db, ctx.runId, { llm: usage, llmUsd });
}

/** Remove a run's scratch space once its outputs are safely in storage. */
export async function cleanupWorkDir(workDir: string): Promise<void> {
  await rm(join(workDir, "frames"), { recursive: true, force: true });
  await rm(join(workDir, "src"), { recursive: true, force: true });
}
