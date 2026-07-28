import { id, nowIso } from "@sdv/core";
import type { Db } from "./sql.ts";

export interface Job {
  id: string;
  run_id: string;
  stage: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

export async function enqueue(
  db: Db,
  job: { runId: string; stage: string; payload?: Record<string, unknown>; delayMs?: number },
): Promise<string> {
  const jobId = id("job");
  await db.query(
    `INSERT INTO jobs (id, run_id, stage, payload, run_after)
     VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' milliseconds')::interval)`,
    [jobId, job.runId, job.stage, JSON.stringify(job.payload ?? {}), String(job.delayMs ?? 0)],
  );
  return jobId;
}

/**
 * Claim one ready job.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe against the same
 * table: a row another worker already holds is passed over rather than waited
 * on. PGlite is single-connection, so the clause is a no-op there — but keeping
 * it means the query is identical on a real cluster.
 */
export async function claim(db: Db, workerId: string): Promise<Job | null> {
  const rows = await db.query<Job & { payload: unknown }>(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, run_id, stage, payload, attempts`,
    [workerId],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, payload: parseJson(row.payload) };
}

export async function complete(db: Db, jobId: string): Promise<void> {
  await db.query(`UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = $1`, [jobId]);
}

/** Fail a job; retry with backoff until MAX_ATTEMPTS, then park it as dead. */
export async function fail(db: Db, job: Job, error: string): Promise<"retry" | "dead"> {
  if (job.attempts >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE jobs SET status = 'dead', locked_at = NULL, last_error = $2 WHERE id = $1`,
      [job.id, error.slice(0, 4000)],
    );
    return "dead";
  }
  const backoffMs = 1000 * 2 ** job.attempts;
  await db.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = $2,
       run_after = now() + ($3 || ' milliseconds')::interval
     WHERE id = $1`,
    [job.id, error.slice(0, 4000), String(backoffMs)],
  );
  return "retry";
}

/** Release jobs whose worker died mid-flight. */
export async function reclaimStale(db: Db, olderThanMs: number): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE jobs SET status = 'queued', locked_at = NULL
     WHERE status = 'running' AND locked_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id`,
    [String(olderThanMs)],
  );
  return rows.length;
}

export async function pendingCount(db: Db): Promise<number> {
  const row = await db.queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM jobs WHERE status IN ('queued','running')`,
  );
  return Number(row?.n ?? 0);
}

export function parseJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value as Record<string, unknown>;
}

export const queueClock = { nowIso };
