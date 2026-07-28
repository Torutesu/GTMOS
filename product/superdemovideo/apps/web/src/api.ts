const TOKEN_KEY = "sdv.token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(value: string): void {
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
}

function headers(): Record<string, string> {
  const token = getToken();
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T,>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
};

/* --------------------------------- types --------------------------------- */

export interface Project {
  id: string;
  name: string;
  source_kind: string;
  source_url: string;
  app_root: string;
  repo_profile: RepoProfile | null;
  cta_url: string | null;
  created_at: string;
}

export interface RepoProfile {
  framework: string;
  packageManager: string;
  nodeVersion: string | null;
  appRoot: string;
  build: { install: string; build: string | null; start: string; port: number };
  e2e: {
    kind: string;
    configPath: string;
    testDir: string;
    specPaths: string[];
    storageStatePath: string | null;
  } | null;
  env: Array<{ key: string; source: string; strategy: string }>;
  confidence: number;
}

export interface Run {
  id: string;
  project_id: string;
  kind: string;
  status: "queued" | "running" | "awaiting_selection" | "succeeded" | "failed";
  git_sha: string | null;
  error_code: string | null;
  error_detail: string | null;
  cost: {
    stageSeconds?: Record<string, number>;
    totalSeconds?: number;
    llmUsd?: number;
  };
  created_at: string;
  finished_at: string | null;
}

export interface StageRow {
  id: string;
  stage: string;
  status: string;
  error_code: string | null;
  error_detail: string | null;
  log_path: string | null;
}

export interface Artifact {
  id: string;
  kind: string;
  files: Record<string, string>;
  script: Record<string, unknown>;
}

export interface UseCase {
  id: string;
  title: { en: string; ja: string };
  hypothesis: { en: string; ja: string };
  entry_route: string;
  outline: string[];
  origin: string | null;
}

export interface DiffReport {
  baseRunId: string;
  summary: string;
  changedCount: number;
  brokenCount: number;
  steps: Array<{
    index: number;
    caption: { en: string; ja: string } | null;
    diffRatio: number;
    changed: boolean;
    status: string;
  }>;
}

export interface Publication {
  alias_slug: string;
  run_id: string;
  synced_sha: string | null;
  published_at: string;
}

export interface RunEvent {
  stage: string;
  status: string;
  message: string;
  at: string;
}

/**
 * Subscribe to a run's progress.
 *
 * EventSource cannot send an Authorization header, so the token rides in the
 * query string for this one route. That is only acceptable because the server
 * treats it as a bearer token either way and the whole surface is a local
 * single-user tool in M1 — a hosted version needs a short-lived stream ticket
 * instead.
 */
export function subscribe(runId: string, onEvent: (e: RunEvent) => void): () => void {
  const token = getToken();
  const url = `/v1/runs/${runId}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const source = new EventSource(url);
  source.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as RunEvent);
    } catch {
      /* a heartbeat or a partial frame */
    }
  };
  return () => source.close();
}
