import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  getToken,
  subscribe,
  type Artifact,
  type DiffReport,
  type Run,
  type RunEvent,
  type StageRow,
  type UseCase,
} from "../api.ts";
import { Link } from "../router.tsx";
import { StatusPill } from "../components.tsx";

interface Detail {
  run: Run;
  stages: StageRow[];
  artifacts: Artifact[];
  diff: DiffReport | null;
}

const STAGES = [
  "ingest",
  "detect",
  "build",
  "seed",
  "understand",
  "flowgen",
  "capture",
  "compose",
  "emit",
  "diff",
  "publish",
];

export function RunPage({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      api
        .get<Detail>(`/v1/runs/${id}`)
        .then(setData)
        .catch((e) => setError(String(e.message))),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The stream drives the log; every event also re-reads the run, because the
  // authoritative state is in the database and the stream is only a nudge.
  useEffect(() => {
    return subscribe(id, (e) => {
      setEvents((prev) => [...prev, e]);
      void load();
    });
  }, [id, load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  if (error) return <main><div className="card error">{error}</div></main>;
  if (!data) return <main><p className="muted">Loading…</p></main>;

  const { run, stages, artifacts, diff } = data;
  const done = stages.filter((s) => s.status === "succeeded").map((s) => s.stage);
  const current = stages.find((s) => s.status === "running")?.stage;
  const failed = stages.find((s) => s.status === "failed");

  return (
    <main>
      <div className="row">
        <h1 style={{ flex: 1 }}>
          <Link to={`/projects/${run.project_id}`}>← project</Link>{" "}
          <span className="mono" style={{ fontSize: 18 }}>{run.id}</span>
        </h1>
        <StatusPill status={run.status} />
      </div>
      <p className="sub">
        {run.kind} run{run.git_sha ? ` at ${run.git_sha.slice(0, 8)}` : ""}
        {run.cost?.totalSeconds ? ` · ${Math.round(run.cost.totalSeconds)}s` : ""}
        {run.cost?.llmUsd ? ` · $${run.cost.llmUsd.toFixed(4)} of model time` : ""}
      </p>

      {run.status === "failed" && (
        <div className="card error">
          <strong>{run.error_code}</strong>
          <div className="small" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
            {run.error_detail}
          </div>
          {failed?.log_path && (
            <div className="small muted mono" style={{ marginTop: 8 }}>
              logs: {failed.log_path}
            </div>
          )}
        </div>
      )}

      <h2>Stages</h2>
      <div className="card">
        {STAGES.filter((s) => done.includes(s) || s === current || relevant(s, stages)).map((s) => (
          <div key={s} className="row" style={{ padding: "3px 0" }}>
            <span className="mono" style={{ width: 110 }}>{s}</span>
            <StatusPill status={stages.find((x) => x.stage === s)?.status ?? "queued"} />
            <span className="muted small" style={{ flex: 1, textAlign: "right" }}>
              {run.cost?.stageSeconds?.[s] !== undefined
                ? `${run.cost.stageSeconds[s]!.toFixed(1)}s`
                : ""}
            </span>
          </div>
        ))}
      </div>

      {run.status === "awaiting_selection" && <Candidates runId={run.id} onChosen={load} />}

      {events.length > 0 && (
        <>
          <h2>Progress</h2>
          <div className="log" ref={logRef}>
            {events.map((e, i) => (
              <div key={i}>
                <span className="t">{e.at?.slice(11, 19)}</span>
                <span className="t">{e.stage}</span>
                {e.message}
              </div>
            ))}
          </div>
        </>
      )}

      {diff && <DiffTable diff={diff} />}

      {run.status === "succeeded" && <Output runId={run.id} artifacts={artifacts} />}
    </main>
  );
}

function relevant(stage: string, stages: StageRow[]): boolean {
  return stages.some((s) => s.stage === stage);
}

/**
 * The one decision a person makes.
 *
 * Everything before this is inference and everything after is machinery; this
 * screen is where someone says which story is worth telling. It shows the
 * evidence behind each candidate — a use case derived from an existing E2E
 * spec is a much stronger bet than one inferred from route names, and hiding
 * that would make the choice arbitrary.
 */
function Candidates({ runId, onChosen }: { runId: string; onChosen: () => void }) {
  const [cases, setCases] = useState<UseCase[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void api
      .get<{ useCases: UseCase[] }>(`/v1/runs/${runId}/use-cases`)
      .then((d) => setCases(d.useCases));
  }, [runId]);

  async function choose(useCaseId: string) {
    setBusy(useCaseId);
    try {
      await api.post(`/v1/use-cases/${useCaseId}/select`);
      onChosen();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2>Choose the demo to film</h2>
      {cases === null && <p className="muted">Loading candidates…</p>}
      {cases?.map((c) => (
        <div key={c.id} className="card">
          <div className="row">
            <strong style={{ flex: 1 }}>{c.title.en}</strong>
            <span className="pill">{c.entry_route}</span>
          </div>
          <p className="small muted" style={{ margin: "6px 0" }}>{c.hypothesis.en}</p>
          <ol className="small muted" style={{ margin: "0 0 10px", paddingLeft: 20 }}>
            {c.outline.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <div className="row">
            <span className="small muted" style={{ flex: 1 }}>
              {c.origin ? `from ${c.origin}` : "inferred from the routes"}
            </span>
            <button disabled={busy !== null} onClick={() => choose(c.id)}>
              {busy === c.id ? "Starting…" : "Film this"}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function DiffTable({ diff }: { diff: DiffReport }) {
  return (
    <>
      <h2>What changed since the published demo</h2>
      <div className={`card ${diff.brokenCount > 0 ? "error" : ""}`}>
        <p style={{ margin: "0 0 10px" }}>{diff.summary}</p>
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Caption</th>
              <th>Status</th>
              <th>Changed</th>
            </tr>
          </thead>
          <tbody>
            {diff.steps.map((s) => (
              <tr key={s.index}>
                <td className="mono">{s.index}</td>
                <td>{s.caption?.en ?? "—"}</td>
                <td>
                  <span className={`pill ${s.status === "broken" ? "bad" : s.changed ? "wait" : "ok"}`}>
                    {s.status}
                  </span>
                </td>
                <td className="mono">{(s.diffRatio * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Output({ runId, artifacts }: { runId: string; artifacts: Artifact[] }) {
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = getToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const fileUrl = (artifactId: string, name: string) =>
    `/v1/artifacts/${artifactId}/files/${name}${q}`;

  const landscape = artifacts.find((a) => a.kind === "video_169");
  const portrait = artifacts.find((a) => a.kind === "video_916");
  const square = artifacts.find((a) => a.kind === "video_11");
  const demo = artifacts.find((a) => a.kind === "demo");

  async function publish() {
    setPublishing(true);
    setError(null);
    try {
      await api.post("/v1/publications", { runId });
      setPublished(true);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <>
      <h2>Result</h2>

      {landscape && (
        <div className="card">
          <video controls poster={fileUrl(landscape.id, "poster.png")}>
            <source src={fileUrl(landscape.id, "video_169.mp4")} type="video/mp4" />
            <track
              kind="captions"
              srcLang="en"
              label="English"
              src={fileUrl(landscape.id, "captions.en.srt")}
            />
          </video>
          <div className="row small muted" style={{ marginTop: 8 }}>
            <a href={fileUrl(landscape.id, "video_169.mp4")} download>
              16:9 mp4
            </a>
            {portrait && (
              <a href={fileUrl(portrait.id, "video_916.mp4")} download>
                9:16 mp4
              </a>
            )}
            {square && (
              <a href={fileUrl(square.id, "video_11.mp4")} download>
                1:1 mp4
              </a>
            )}
            <a href={fileUrl(landscape.id, "captions.en.srt")} download>
              captions (en)
            </a>
            <a href={fileUrl(landscape.id, "captions.ja.srt")} download>
              captions (ja)
            </a>
          </div>
        </div>
      )}

      {demo && (
        <div className="card">
          <iframe className="demo" src={fileUrl(demo.id, "index.html")} title="interactive demo" />
        </div>
      )}

      {error && <div className="card error">{error}</div>}

      <div className="row">
        <button disabled={publishing || published} onClick={publish}>
          {published ? "Publishing…" : publishing ? "Queuing…" : "Publish this run"}
        </button>
        <span className="small muted">
          The public URL never changes — publishing swaps what it serves.
        </span>
      </div>
    </>
  );
}
