import { join } from "node:path";
import { isRetryable, toSdvError, type Stage } from "@sdv/core";
import {
  claim,
  complete,
  fail,
  getRun,
  listArtifacts,
  reclaimStale,
  setRunStatus,
  type Job,
} from "@sdv/db";
import { analyse, produce, publish, regenerate } from "@sdv/pipeline";
import type { EventBus } from "./events.ts";
import { runContext, type Runtime } from "./runtime.ts";

const POLL_MS = 250;
const STALE_MS = 30 * 60 * 1000;

export interface Worker {
  stop(): Promise<void>;
  /** Resolves once the queue has nothing left to do. Used by tests. */
  drained(): Promise<void>;
}

/**
 * The job loop.
 *
 * It runs in the API process by default because M1 is a single machine and a
 * second process would only add a way for the two halves to disagree about
 * which var directory they are using. The queue is a real queue regardless, so
 * moving this out later is a deployment change, not a rewrite.
 */
export function startWorker(rt: Runtime, bus: EventBus, opts: { id?: string } = {}): Worker {
  const workerId = opts.id ?? `worker-${process.pid}`;
  let running = true;
  let idle = true;
  let lastReclaim = 0;

  const loop = (async () => {
    while (running) {
      if (Date.now() - lastReclaim > STALE_MS / 2) {
        lastReclaim = Date.now();
        const freed = await reclaimStale(rt.db, STALE_MS).catch(() => 0);
        if (freed > 0) rt.log.warn("released jobs from a dead worker", { freed });
      }

      let job: Job | null = null;
      try {
        job = await claim(rt.db, workerId);
      } catch (err) {
        rt.log.error("could not read the job queue", { err: String(err) });
      }

      if (!job) {
        idle = true;
        await sleep(POLL_MS);
        continue;
      }

      idle = false;
      await handle(rt, bus, job);
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
    },
    async drained() {
      // Two consecutive idle polls: one job can enqueue the next, and a single
      // empty read would call that finished a moment too early.
      let quiet = 0;
      while (quiet < 2) {
        await sleep(POLL_MS * 2);
        quiet = idle ? quiet + 1 : 0;
      }
    },
  };
}

async function handle(rt: Runtime, bus: EventBus, job: Job): Promise<void> {
  const run = await getRun(rt.db, job.run_id);
  if (!run) {
    await complete(rt.db, job.id);
    return;
  }

  const ctx = runContext(rt, {
    runId: run.id,
    projectId: run.project_id,
    progress: (e) => bus.emit(run.id, e),
  });

  bus.emit(run.id, { stage: "run", status: "running", message: `${job.stage} started` });

  try {
    switch (job.stage) {
      case "analyse": {
        const { useCases } = await analyse(ctx);
        bus.emit(run.id, {
          stage: "run",
          status: "awaiting_selection",
          message: `${useCases.length} candidate demos found — choose one`,
        });
        break;
      }
      case "produce": {
        const useCaseId = job.payload["useCaseId"];
        const result = await produce(ctx, {
          useCaseId: typeof useCaseId === "string" ? useCaseId : undefined,
        });
        bus.emit(run.id, {
          stage: "run",
          status: "succeeded",
          message: result.brokenSteps.length
            ? `Done, but ${result.brokenSteps.length} step(s) never resolved`
            : "Done",
        });
        break;
      }
      case "regen": {
        const result = await regenerate(ctx);
        bus.emit(run.id, {
          stage: "run",
          status: "succeeded",
          message: `Regenerated${result.brokenSteps.length ? ` with ${result.brokenSteps.length} broken step(s)` : ""}`,
        });
        break;
      }
      case "publish": {
        const artifacts = await listArtifacts(rt.db, run.id);
        if (artifacts.length === 0) throw new Error("this run produced nothing to publish");
        const out = await publish(ctx, {
          runId: run.id,
          gitSha: run.git_sha,
          stagingDir: join(rt.cfg.workDir, run.id),
        });
        bus.emit(run.id, { stage: "run", status: "published", message: `Live at ${out.demoUrl}` });
        break;
      }
      default:
        rt.log.warn("ignoring an unknown job stage", { stage: job.stage });
    }
    await complete(rt.db, job.id);
  } catch (err) {
    const sdv = toSdvError(err);
    const verdict = await fail(rt.db, job, sdv.message, { retryable: isRetryable(sdv.code) });
    if (verdict === "dead") {
      await setRunStatus(rt.db, run.id, "failed", {
        errorCode: sdv.code,
        errorDetail: sdv.detail ?? sdv.message,
      });
      bus.emit(run.id, {
        stage: (job.stage as Stage) ?? "run",
        status: "failed",
        message: `${sdv.code}: ${sdv.title}`,
      });
    } else {
      bus.emit(run.id, {
        stage: "run",
        status: "retrying",
        message: `${sdv.code} — retrying (attempt ${job.attempts + 1})`,
      });
    }
    rt.log.error("job failed", { job: job.id, stage: job.stage, code: sdv.code, verdict });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
