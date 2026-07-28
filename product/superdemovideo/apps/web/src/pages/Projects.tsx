import { useEffect, useState } from "react";
import { api, type Project } from "../api.ts";
import { Link, navigate } from "../router.tsx";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<{ projects: Project[] }>("/v1/projects")
      .then((d) => setProjects(d.projects))
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const isUrl = /^(https?|git)[:@]/.test(source);
      const { project } = await api.post<{ project: Project }>("/v1/projects", {
        name: name || source.split("/").filter(Boolean).pop(),
        source: isUrl ? { kind: "git", url: source } : { kind: "local", path: source },
      });
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Projects</h1>
      <p className="sub">A project is a repository we keep a demo in sync with.</p>

      {error && <div className="card error">{error}</div>}

      <form className="card grid" onSubmit={create}>
        <div>
          <label htmlFor="src">Repository path or git URL</label>
          <input
            id="src"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="/absolute/path/to/repo"
            required
          />
        </div>
        <div>
          <label htmlFor="name">Name (optional)</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row">
          <button disabled={busy || !source}>{busy ? "Creating…" : "Add project"}</button>
        </div>
      </form>

      <h2>All projects</h2>
      {projects === null && <p className="muted">Loading…</p>}
      {projects?.length === 0 && <p className="muted">Nothing yet.</p>}
      {projects?.map((p) => (
        <Link key={p.id} to={`/projects/${p.id}`}>
          <div className="card click">
            <div className="row">
              <strong>{p.name}</strong>
              <span className="spacer" style={{ flex: 1 }} />
              <span className="pill">{p.source_kind}</span>
            </div>
            <div className="mono muted small">{p.source_url}</div>
          </div>
        </Link>
      ))}
    </main>
  );
}
