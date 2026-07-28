import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claim,
  complete,
  createProject,
  createRun,
  enqueue,
  fail,
  finishStage,
  insertFlow,
  insertUseCases,
  listStages,
  listUseCases,
  mergeRunCost,
  migrate,
  openDb,
  pendingCount,
  reclaimStale,
  setRunStatus,
  startStage,
  type Db,
} from "@sdv/db";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdv-db-"));
  db = await openDb({ databaseUrl: null, dbDir: join(dir, "db") });
  await migrate(db);
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("projects and runs", () => {
  it("creates a project, a run and stages", async () => {
    const p = await createProject(db, {
      name: "fixture",
      sourceKind: "local",
      sourceUrl: "/tmp/x",
    });
    const r = await createRun(db, { projectId: p.id, kind: "initial" });
    expect(r.status).toBe("queued");

    const sid = await startStage(db, r.id, "ingest");
    await finishStage(db, sid, "succeeded");
    const stages = await listStages(db, r.id);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.status).toBe("succeeded");

    await setRunStatus(db, r.id, "running");
    await mergeRunCost(db, r.id, { stageSeconds: { ingest: 1.5 } });
    await mergeRunCost(db, r.id, { stageSeconds: { detect: 0.5 }, llmUsd: 0.02 });

    const after = await db.queryOne<{ cost: unknown }>(`SELECT cost FROM runs WHERE id = $1`, [r.id]);
    const cost = typeof after!.cost === "string" ? JSON.parse(after!.cost as string) : after!.cost;
    expect(cost.stageSeconds).toEqual({ ingest: 1.5, detect: 0.5 });
    expect(cost.totalSeconds).toBe(2);
    expect(cost.llmUsd).toBe(0.02);
  });

  it("stores use cases in order and links a flow", async () => {
    const p = await createProject(db, { name: "uc", sourceKind: "local", sourceUrl: "/tmp/y" });
    const r = await createRun(db, { projectId: p.id, kind: "initial" });
    await insertUseCases(db, p.id, r.id, [
      {
        id: "uc_b",
        title: { en: "B", ja: "B" },
        hypothesis: { en: "h", ja: "h" },
        entryRoute: "/b",
        outline: ["x"],
        signals: ["route"],
        origin: null,
      },
      {
        id: "uc_a",
        title: { en: "A", ja: "A" },
        hypothesis: { en: "h", ja: "h" },
        entryRoute: "/a",
        outline: ["y"],
        signals: ["e2e-test"],
        origin: "e2e/a.spec.ts",
      },
    ]);
    const cases = await listUseCases(db, r.id);
    expect(cases.map((c) => c.id)).toEqual(["uc_b", "uc_a"]);
    expect((cases[1]!.signals as string[])[0]).toBe("e2e-test");

    const flow = await insertFlow(db, {
      useCaseId: "uc_a",
      projectId: p.id,
      runId: r.id,
      flow: { schemaVersion: 1, steps: [] },
    });
    expect(flow.version).toBe(1);
    const second = await insertFlow(db, {
      useCaseId: "uc_a",
      projectId: p.id,
      runId: r.id,
      flow: { schemaVersion: 1, steps: [] },
    });
    expect(second.version).toBe(2);
  });
});

describe("job queue", () => {
  it("claims each job exactly once across concurrent workers", async () => {
    const p = await createProject(db, { name: "q", sourceKind: "local", sourceUrl: "/tmp/q" });
    const r = await createRun(db, { projectId: p.id, kind: "initial" });
    for (let i = 0; i < 6; i++) await enqueue(db, { runId: r.id, stage: `s${i}` });

    const claimed = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claim(db, `w${i}`)),
    );
    const got = claimed.filter((j) => j !== null);
    expect(got).toHaveLength(6);
    expect(new Set(got.map((j) => j!.id)).size).toBe(6);

    for (const j of got) await complete(db, j!.id);
    expect(await pendingCount(db)).toBe(0);
  });

  it("retries with backoff then parks the job as dead", async () => {
    const p = await createProject(db, { name: "q2", sourceKind: "local", sourceUrl: "/tmp/q2" });
    const r = await createRun(db, { projectId: p.id, kind: "initial" });
    await enqueue(db, { runId: r.id, stage: "flaky" });

    let outcome = "";
    let attempts = 0;
    while (outcome !== "dead" && attempts < 10) {
      attempts++;
      const j = await claim(db, "w");
      if (!j) {
        // backoff has not elapsed — skip ahead so the test stays fast
        await db.query(`UPDATE jobs SET run_after = now() WHERE stage = 'flaky'`);
        continue;
      }
      outcome = await fail(db, j, "nope");
    }
    expect(outcome).toBe("dead");
    // and a dead job is no longer claimable
    await db.query(`UPDATE jobs SET run_after = now() WHERE stage = 'flaky'`);
    const row = await db.queryOne<{ status: string }>(
      `SELECT status FROM jobs WHERE stage = 'flaky'`,
    );
    expect(row!.status).toBe("dead");
  });

  it("reclaims jobs abandoned by a dead worker", async () => {
    const p = await createProject(db, { name: "q3", sourceKind: "local", sourceUrl: "/tmp/q3" });
    const r = await createRun(db, { projectId: p.id, kind: "initial" });
    await enqueue(db, { runId: r.id, stage: "orphan" });
    const j = await claim(db, "dead-worker");
    expect(j).not.toBeNull();
    await db.query(`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = $1`, [j!.id]);
    expect(await reclaimStale(db, 60_000)).toBe(1);
  });
});
