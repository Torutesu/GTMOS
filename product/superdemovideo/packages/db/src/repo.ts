import { id, nowIso, type RepoProfile, type RunCost, type Stage } from "@sdv/core";
import type { Db } from "./sql.ts";
import { parseJson } from "./queue.ts";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_selection"
  | "succeeded"
  | "failed";

export interface ProjectRow {
  id: string;
  name: string;
  source_kind: string;
  source_url: string;
  app_root: string;
  repo_profile: RepoProfile | null;
  cta_url: string | null;
  created_at: string;
}

export interface RunRow {
  id: string;
  project_id: string;
  kind: string;
  status: RunStatus;
  git_sha: string | null;
  error_code: string | null;
  error_detail: string | null;
  base_run_id: string | null;
  cost: RunCost | Record<string, never>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StageRow {
  id: string;
  run_id: string;
  stage: string;
  status: string;
  attempt: number;
  error_code: string | null;
  error_detail: string | null;
  log_path: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/* -------------------------------- projects ------------------------------- */

export async function createProject(
  db: Db,
  p: { name: string; sourceKind: "git" | "local"; sourceUrl: string; appRoot?: string; ctaUrl?: string },
): Promise<ProjectRow> {
  const pid = id("prj");
  await db.query(
    `INSERT INTO projects (id, name, source_kind, source_url, app_root, cta_url)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [pid, p.name, p.sourceKind, p.sourceUrl, p.appRoot ?? "", p.ctaUrl ?? null],
  );
  return (await getProject(db, pid))!;
}

export async function getProject(db: Db, pid: string): Promise<ProjectRow | null> {
  const row = await db.queryOne<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [pid]);
  if (!row) return null;
  return { ...row, repo_profile: hydrate(row.repo_profile) as RepoProfile | null };
}

export async function listProjects(db: Db): Promise<ProjectRow[]> {
  const rows = await db.query<ProjectRow>(`SELECT * FROM projects ORDER BY created_at DESC`);
  return rows.map((r) => ({ ...r, repo_profile: hydrate(r.repo_profile) as RepoProfile | null }));
}

export async function setRepoProfile(db: Db, pid: string, profile: RepoProfile): Promise<void> {
  await db.query(`UPDATE projects SET repo_profile = $2::jsonb WHERE id = $1`, [
    pid,
    JSON.stringify(profile),
  ]);
}

/* ---------------------------------- runs --------------------------------- */

export async function createRun(
  db: Db,
  r: { projectId: string; kind: "initial" | "regen"; baseRunId?: string | null },
): Promise<RunRow> {
  const rid = id("run");
  await db.query(
    `INSERT INTO runs (id, project_id, kind, status, base_run_id) VALUES ($1,$2,$3,'queued',$4)`,
    [rid, r.projectId, r.kind, r.baseRunId ?? null],
  );
  return (await getRun(db, rid))!;
}

export async function getRun(db: Db, rid: string): Promise<RunRow | null> {
  const row = await db.queryOne<RunRow>(`SELECT * FROM runs WHERE id = $1`, [rid]);
  if (!row) return null;
  return { ...row, cost: (hydrate(row.cost) as RunCost) ?? {} };
}

export async function listRuns(db: Db, projectId: string): Promise<RunRow[]> {
  const rows = await db.query<RunRow>(
    `SELECT * FROM runs WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  return rows.map((r) => ({ ...r, cost: (hydrate(r.cost) as RunCost) ?? {} }));
}

export async function setRunStatus(
  db: Db,
  rid: string,
  status: RunStatus,
  extra: { errorCode?: string | null; errorDetail?: string | null; gitSha?: string | null } = {},
): Promise<void> {
  const started = status === "running" ? `COALESCE(started_at, now())` : `started_at`;
  const finished =
    status === "succeeded" || status === "failed" ? `now()` : `finished_at`;
  await db.query(
    `UPDATE runs SET status = $2, error_code = COALESCE($3, error_code),
       error_detail = COALESCE($4, error_detail), git_sha = COALESCE($5, git_sha),
       started_at = ${started}, finished_at = ${finished}
     WHERE id = $1`,
    [rid, status, extra.errorCode ?? null, extra.errorDetail ?? null, extra.gitSha ?? null],
  );
}

export async function mergeRunCost(db: Db, rid: string, patch: Partial<RunCost>): Promise<void> {
  const run = await getRun(db, rid);
  const prev = (run?.cost ?? {}) as Partial<RunCost>;
  const next: RunCost = {
    llm: [...(prev.llm ?? []), ...(patch.llm ?? [])],
    llmUsd: Number(((prev.llmUsd ?? 0) + (patch.llmUsd ?? 0)).toFixed(6)),
    stageSeconds: { ...(prev.stageSeconds ?? {}), ...(patch.stageSeconds ?? {}) },
    totalSeconds: patch.totalSeconds ?? prev.totalSeconds ?? 0,
  };
  next.totalSeconds = Number(
    Object.values(next.stageSeconds).reduce((a, b) => a + b, 0).toFixed(3),
  );
  await db.query(`UPDATE runs SET cost = $2::jsonb WHERE id = $1`, [rid, JSON.stringify(next)]);
}

/* ------------------------------- run stages ------------------------------ */

export async function startStage(db: Db, rid: string, stage: Stage): Promise<string> {
  const sid = id("stg");
  await db.query(
    `INSERT INTO run_stages (id, run_id, stage, status, started_at) VALUES ($1,$2,$3,'running',now())`,
    [sid, rid, stage],
  );
  return sid;
}

export async function finishStage(
  db: Db,
  sid: string,
  status: "succeeded" | "failed" | "skipped",
  extra: { errorCode?: string; errorDetail?: string; logPath?: string } = {},
): Promise<void> {
  await db.query(
    `UPDATE run_stages SET status = $2, error_code = $3, error_detail = $4,
       log_path = COALESCE($5, log_path), finished_at = now() WHERE id = $1`,
    [sid, status, extra.errorCode ?? null, extra.errorDetail?.slice(0, 4000) ?? null, extra.logPath ?? null],
  );
}

export async function listStages(db: Db, rid: string): Promise<StageRow[]> {
  return db.query<StageRow>(
    `SELECT * FROM run_stages WHERE run_id = $1 ORDER BY started_at NULLS LAST`,
    [rid],
  );
}

/* -------------------------------- use cases ------------------------------ */

export interface UseCaseRow {
  id: string;
  project_id: string;
  run_id: string;
  title: unknown;
  hypothesis: unknown;
  entry_route: string;
  outline: unknown;
  signals: unknown;
  origin: string | null;
  status: string;
  position: number;
}

export async function insertUseCases(
  db: Db,
  projectId: string,
  runId: string,
  cases: Array<{
    id: string;
    title: unknown;
    hypothesis: unknown;
    entryRoute: string;
    outline: unknown;
    signals: unknown;
    origin: string | null;
  }>,
): Promise<void> {
  for (const [i, c] of cases.entries()) {
    await db.query(
      `INSERT INTO use_cases (id, project_id, run_id, title, hypothesis, entry_route, outline, signals, origin, position)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10)`,
      [
        c.id,
        projectId,
        runId,
        JSON.stringify(c.title),
        JSON.stringify(c.hypothesis),
        c.entryRoute,
        JSON.stringify(c.outline),
        JSON.stringify(c.signals),
        c.origin,
        i,
      ],
    );
  }
}

export async function listUseCases(db: Db, runId: string): Promise<UseCaseRow[]> {
  const rows = await db.query<UseCaseRow>(
    `SELECT * FROM use_cases WHERE run_id = $1 ORDER BY position`,
    [runId],
  );
  return rows.map((r) => ({
    ...r,
    title: hydrate(r.title),
    hypothesis: hydrate(r.hypothesis),
    outline: hydrate(r.outline),
    signals: hydrate(r.signals),
  }));
}

export async function getUseCase(db: Db, ucId: string): Promise<UseCaseRow | null> {
  const r = await db.queryOne<UseCaseRow>(`SELECT * FROM use_cases WHERE id = $1`, [ucId]);
  if (!r) return null;
  return {
    ...r,
    title: hydrate(r.title),
    hypothesis: hydrate(r.hypothesis),
    outline: hydrate(r.outline),
    signals: hydrate(r.signals),
  };
}

export async function selectUseCase(db: Db, ucId: string): Promise<void> {
  await db.query(`UPDATE use_cases SET status = 'selected' WHERE id = $1`, [ucId]);
}

/* ---------------------------------- flows -------------------------------- */

export interface FlowRow {
  id: string;
  use_case_id: string;
  project_id: string;
  version: number;
  flow_json: unknown;
  created_by_run: string;
}

export async function insertFlow(
  db: Db,
  f: { useCaseId: string; projectId: string; flow: unknown; runId: string },
): Promise<FlowRow> {
  const fid = id("flw");
  const prev = await db.queryOne<{ v: number }>(
    `SELECT COALESCE(max(version),0) AS v FROM flows WHERE use_case_id = $1`,
    [f.useCaseId],
  );
  await db.query(
    `INSERT INTO flows (id, use_case_id, project_id, version, flow_json, created_by_run)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [fid, f.useCaseId, f.projectId, Number(prev?.v ?? 0) + 1, JSON.stringify(f.flow), f.runId],
  );
  return (await getFlow(db, fid))!;
}

export async function getFlow(db: Db, fid: string): Promise<FlowRow | null> {
  const r = await db.queryOne<FlowRow>(`SELECT * FROM flows WHERE id = $1`, [fid]);
  return r ? { ...r, flow_json: hydrate(r.flow_json) } : null;
}

export async function latestFlowForProject(db: Db, projectId: string): Promise<FlowRow | null> {
  const r = await db.queryOne<FlowRow>(
    `SELECT * FROM flows WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  return r ? { ...r, flow_json: hydrate(r.flow_json) } : null;
}

export async function countFlows(db: Db, projectId: string): Promise<number> {
  const r = await db.queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM flows WHERE project_id = $1`,
    [projectId],
  );
  return Number(r?.n ?? 0);
}

/* -------------------------------- captures ------------------------------- */

export interface CaptureRow {
  id: string;
  run_id: string;
  flow_id: string;
  bundle_path: string;
  viewport: string;
  bytes: number;
}

export async function insertCapture(
  db: Db,
  c: { runId: string; flowId: string; bundlePath: string; viewport: string; bytes: number },
): Promise<CaptureRow> {
  const cid = id("cap");
  await db.query(
    `INSERT INTO captures (id, run_id, flow_id, bundle_path, viewport, bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [cid, c.runId, c.flowId, c.bundlePath, c.viewport, c.bytes],
  );
  return { id: cid, run_id: c.runId, flow_id: c.flowId, bundle_path: c.bundlePath, viewport: c.viewport, bytes: c.bytes };
}

export async function listCaptures(db: Db, runId: string): Promise<CaptureRow[]> {
  return db.query<CaptureRow>(`SELECT * FROM captures WHERE run_id = $1`, [runId]);
}

/* -------------------------------- artifacts ------------------------------ */

export interface ArtifactRow {
  id: string;
  run_id: string;
  capture_id: string;
  kind: string;
  template_version: string;
  files: unknown;
  script: unknown;
}

export async function insertArtifact(
  db: Db,
  a: {
    runId: string;
    captureId: string;
    kind: string;
    templateVersion: string;
    files: unknown;
    script?: unknown;
  },
): Promise<ArtifactRow> {
  const aid = id("art");
  await db.query(
    `INSERT INTO artifacts (id, run_id, capture_id, kind, template_version, files, script)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [aid, a.runId, a.captureId, a.kind, a.templateVersion, JSON.stringify(a.files), JSON.stringify(a.script ?? null)],
  );
  return (await getArtifact(db, aid))!;
}

export async function getArtifact(db: Db, aid: string): Promise<ArtifactRow | null> {
  const r = await db.queryOne<ArtifactRow>(`SELECT * FROM artifacts WHERE id = $1`, [aid]);
  return r ? { ...r, files: hydrate(r.files), script: hydrate(r.script) } : null;
}

export async function listArtifacts(db: Db, runId: string): Promise<ArtifactRow[]> {
  const rows = await db.query<ArtifactRow>(`SELECT * FROM artifacts WHERE run_id = $1`, [runId]);
  return rows.map((r) => ({ ...r, files: hydrate(r.files), script: hydrate(r.script) }));
}

/* ------------------------------ publications ----------------------------- */

export interface PublicationRow {
  id: string;
  project_id: string;
  alias_slug: string;
  run_id: string;
  artifact_ids: unknown;
  synced_sha: string | null;
  visibility: string;
  published_at: string;
}

export async function upsertPublication(
  db: Db,
  p: {
    projectId: string;
    slug: string;
    runId: string;
    artifactIds: string[];
    syncedSha: string | null;
  },
): Promise<PublicationRow> {
  const existing = await db.queryOne<PublicationRow>(
    `SELECT * FROM publications WHERE project_id = $1`,
    [p.projectId],
  );
  if (existing) {
    await db.query(
      `UPDATE publications SET run_id = $2, artifact_ids = $3::jsonb, synced_sha = $4, published_at = now()
       WHERE id = $1`,
      [existing.id, p.runId, JSON.stringify(p.artifactIds), p.syncedSha],
    );
    return (await getPublicationBySlug(db, existing.alias_slug))!;
  }
  const pubId = id("pub");
  await db.query(
    `INSERT INTO publications (id, project_id, alias_slug, run_id, artifact_ids, synced_sha)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [pubId, p.projectId, p.slug, p.runId, JSON.stringify(p.artifactIds), p.syncedSha],
  );
  return (await getPublicationBySlug(db, p.slug))!;
}

export async function getPublicationBySlug(db: Db, slug: string): Promise<PublicationRow | null> {
  const r = await db.queryOne<PublicationRow>(
    `SELECT * FROM publications WHERE alias_slug = $1`,
    [slug],
  );
  return r ? { ...r, artifact_ids: hydrate(r.artifact_ids) } : null;
}

export async function getPublicationByProject(db: Db, pid: string): Promise<PublicationRow | null> {
  const r = await db.queryOne<PublicationRow>(
    `SELECT * FROM publications WHERE project_id = $1`,
    [pid],
  );
  return r ? { ...r, artifact_ids: hydrate(r.artifact_ids) } : null;
}

/* ---------------------------------- diffs -------------------------------- */

export async function insertDiff(
  db: Db,
  d: { runId: string; baseRunId: string; report: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO diffs (id, run_id, base_run_id, report) VALUES ($1,$2,$3,$4::jsonb)`,
    [id("dif"), d.runId, d.baseRunId, JSON.stringify(d.report)],
  );
}

export async function getDiff(db: Db, runId: string): Promise<unknown | null> {
  const r = await db.queryOne<{ report: unknown }>(
    `SELECT report FROM diffs WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );
  return r ? hydrate(r.report) : null;
}

/* --------------------------------- helpers ------------------------------- */

/** PGlite returns jsonb as parsed values; node-postgres sometimes as text. */
function hydrate(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export { parseJson, nowIso };
