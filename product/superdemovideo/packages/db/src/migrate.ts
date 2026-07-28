import type { Db } from "./sql.ts";

/**
 * Schema (architecture doc §5, M1 subset).
 *
 * Two separations carry real weight here:
 *   captures  ↔ artifacts    — a template change re-renders artifacts from an
 *                              existing capture instead of rebuilding the repo.
 *   artifacts ↔ publications — publishing is a pointer move, so republishing
 *                              and rolling back are the same cheap operation.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  source_kind   TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  app_root      TEXT NOT NULL DEFAULT '',
  repo_profile  JSONB,
  cta_url       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  git_sha       TEXT,
  error_code    TEXT,
  error_detail  TEXT,
  base_run_id   TEXT,
  cost          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_stages (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  error_code    TEXT,
  error_detail  TEXT,
  log_path      TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS run_stages_run_idx ON run_stages(run_id);

CREATE TABLE IF NOT EXISTS use_cases (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  title         JSONB NOT NULL,
  hypothesis    JSONB NOT NULL,
  entry_route   TEXT NOT NULL,
  outline       JSONB NOT NULL,
  signals       JSONB NOT NULL,
  origin        TEXT,
  status        TEXT NOT NULL DEFAULT 'candidate',
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS use_cases_run_idx ON use_cases(run_id, position);

CREATE TABLE IF NOT EXISTS flows (
  id            TEXT PRIMARY KEY,
  use_case_id   TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1,
  flow_json     JSONB NOT NULL,
  created_by_run TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flows_project_idx ON flows(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS captures (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  flow_id       TEXT NOT NULL,
  bundle_path   TEXT NOT NULL,
  viewport      TEXT NOT NULL,
  bytes         BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS captures_run_idx ON captures(run_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  capture_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  template_version TEXT NOT NULL,
  files            JSONB NOT NULL,
  script           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS publications (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias_slug    TEXT NOT NULL UNIQUE,
  run_id        TEXT NOT NULL,
  artifact_ids  JSONB NOT NULL,
  synced_sha    TEXT,
  visibility    TEXT NOT NULL DEFAULT 'unlisted',
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publications_project_idx ON publications(project_id);

CREATE TABLE IF NOT EXISTS diffs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  base_run_id   TEXT NOT NULL,
  report        JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  stage         TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'queued',
  attempts      INTEGER NOT NULL DEFAULT 0,
  locked_at     TIMESTAMPTZ,
  locked_by     TEXT,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(status, run_after);
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}
