import { useCallback, useEffect, useState } from "react";
import { api, type Project, type Publication, type RepoProfile, type Run } from "../api.ts";
import { Link, navigate } from "../router.tsx";
import { StatusPill } from "../components.tsx";

interface Detail {
  project: Project;
  runs: Run[];
  publication: Publication | null;
}

export function ProjectPage({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<Detail>(`/v1/projects/${id}`)
        .then(setData)
        .catch((e) => setError(String(e.message))),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function startRun(kind: "initial" | "regen") {
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.post<{ run: Run }>(`/v1/projects/${id}/runs`, { kind });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <main><div className="card error">{error}</div></main>;
  if (!data) return <main><p className="muted">Loading…</p></main>;

  const { project, runs, publication } = data;
  const hasSucceeded = runs.some((r) => r.status === "succeeded");

  return (
    <main>
      <h1>{project.name}</h1>
      <p className="sub mono">{project.source_url}</p>

      <div className="row" style={{ marginBottom: 18 }}>
        <button disabled={busy} onClick={() => startRun("initial")}>
          New demo
        </button>
        <button
          className="ghost"
          disabled={busy || !hasSucceeded}
          title={hasSucceeded ? "" : "Nothing to regenerate yet"}
          onClick={() => startRun("regen")}
        >
          Regenerate
        </button>
      </div>

      {publication && <PublicationCard publication={publication} />}

      <h2>Build profile</h2>
      <ProfileForm project={project} onSaved={load} />

      <h2>Runs</h2>
      {runs.length === 0 && <p className="muted">No runs yet.</p>}
      {runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Commit</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`}>
                    <span className="mono">{r.id}</span>
                  </Link>
                </td>
                <td>{r.kind}</td>
                <td>
                  <StatusPill status={r.status} />
                </td>
                <td className="mono muted">{r.git_sha?.slice(0, 8) ?? "—"}</td>
                <td className="muted">
                  {r.cost?.totalSeconds ? `${Math.round(r.cost.totalSeconds)}s` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function PublicationCard({ publication }: { publication: Publication }) {
  const demoUrl = `${window.location.origin}/d/${publication.alias_slug}`;
  const badgeUrl = `${window.location.origin}/badge/${publication.alias_slug}.svg`;
  const markdown = `[![demo](${badgeUrl})](${demoUrl})`;

  return (
    <div className="card">
      <div className="row">
        <img src={badgeUrl} alt="freshness badge" height={20} />
        <span style={{ flex: 1 }} />
        <a href={demoUrl} target="_blank" rel="noreferrer">
          Open the live demo →
        </a>
      </div>
      <label style={{ marginTop: 12 }}>Paste this into your README</label>
      <input readOnly value={markdown} onFocus={(e) => e.currentTarget.select()} className="mono" />
    </div>
  );
}

/**
 * The profile override.
 *
 * Detection is deterministic and usually right, but "usually" is not a product
 * — every repository we guess wrong about needs a way through without waiting
 * for us to ship a new heuristic.
 */
function ProfileForm({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [profile, setProfile] = useState<RepoProfile | null>(project.repo_profile);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setProfile(project.repo_profile), [project.repo_profile]);

  if (!profile) {
    return <p className="muted">Not detected yet — it appears after the first run's detect stage.</p>;
  }

  const setBuild = (patch: Partial<RepoProfile["build"]>) =>
    setProfile({ ...profile, build: { ...profile.build, ...patch } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.patch(`/v1/projects/${project.id}`, { repoProfile: profile });
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  return (
    <form className="card grid" onSubmit={save}>
      <div className="row">
        <span className="pill">{profile.framework}</span>
        <span className="pill">{profile.packageManager}</span>
        <span className={`pill ${profile.confidence >= 0.5 ? "ok" : "wait"}`}>
          confidence {Math.round(profile.confidence * 100)}%
        </span>
        {profile.e2e && <span className="pill">{profile.e2e.specPaths.length} e2e specs</span>}
      </div>

      <div>
        <label htmlFor="install">Install</label>
        <input
          id="install"
          className="mono"
          value={profile.build.install}
          onChange={(e) => setBuild({ install: e.target.value })}
        />
      </div>
      <div>
        <label htmlFor="build">Build (blank for none)</label>
        <input
          id="build"
          className="mono"
          value={profile.build.build ?? ""}
          onChange={(e) => setBuild({ build: e.target.value || null })}
        />
      </div>
      <div>
        <label htmlFor="start">Start</label>
        <input
          id="start"
          className="mono"
          value={profile.build.start}
          onChange={(e) => setBuild({ start: e.target.value })}
        />
      </div>
      <div>
        <label htmlFor="port">Port</label>
        <input
          id="port"
          type="number"
          value={profile.build.port}
          onChange={(e) => setBuild({ port: Number(e.target.value) })}
        />
      </div>

      {profile.env.length > 0 && (
        <p className="small muted">
          Environment keys filled with placeholders: {profile.env.map((v) => v.key).join(", ")}.
          Real secrets are never accepted.
        </p>
      )}

      {error && <div className="small" style={{ color: "var(--bad)" }}>{error}</div>}
      <div className="row">
        <button>Save profile</button>
        {saved && <span className="small" style={{ color: "var(--ok)" }}>Saved</span>}
      </div>
    </form>
  );
}
