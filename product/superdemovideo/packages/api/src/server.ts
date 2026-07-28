import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { RepoProfile, errorSpec, type ErrorCode } from "@sdv/core";
import {
  createProject,
  createRun,
  enqueue,
  getArtifact,
  getDiff,
  getProject,
  getPublicationByProject,
  getPublicationBySlug,
  getRun,
  getUseCase,
  listArtifacts,
  listProjects,
  listRuns,
  listStages,
  listUseCases,
  setRepoProfile,
  setRunStatus,
} from "@sdv/db";
import { badgeSvg } from "@sdv/pipeline";
import { EventBus } from "./events.ts";
import { isFile, safeJoin, sendFile } from "./http.ts";
import { startWorker, type Worker } from "./worker.ts";
import type { Runtime } from "./runtime.ts";

const WEB_DIST = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

export interface ServerHandle {
  app: FastifyInstance;
  bus: EventBus;
  worker: Worker | null;
  url: string;
  close(): Promise<void>;
}

export interface ServerOptions {
  worker?: boolean;
  host?: string;
  port?: number;
}

/**
 * The HTTP surface.
 *
 * Two audiences share one process: the operator, who is authenticated and can
 * start runs, and the public, who can only read a published demo. The split is
 * enforced at the prefix level rather than per route, because a new operator
 * route must never accidentally default to public.
 */
export async function startServer(rt: Runtime, opts: ServerOptions = {}): Promise<ServerHandle> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const bus = new EventBus();

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    if (url.startsWith("/d/") || url.startsWith("/badge/") || url === "/healthz") return;
    if (!url.startsWith("/v1/")) return; // the SPA and its assets are not secrets
    if (!rt.cfg.token) return; // no token configured: development mode
    if (req.headers.authorization === `Bearer ${rt.cfg.token}`) return;
    // A browser cannot attach a header to an EventSource, a <video src> or an
    // <iframe>, so those two read-only routes also accept the token as a query
    // parameter. Nothing that changes state does — a token in a URL ends up in
    // history and logs, and this is as far as that risk is worth taking.
    const streamable = url.endsWith("/events") || url.startsWith("/v1/artifacts/");
    if (streamable && req.method === "GET") {
      const q = (req.query as Record<string, string> | undefined)?.["token"];
      if (q === rt.cfg.token) return;
    }
    await reply.code(401).send({ error: "unauthorised" });
  });

  app.setErrorHandler(async (err: unknown, _req, reply) => {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (typeof code === "string" && code.startsWith("SDV-E")) {
      const spec = errorSpec(code as ErrorCode);
      return reply.code(422).send({ error: spec.title, code, hint: spec.hint });
    }
    rt.log.error("request failed", { err: message });
    return reply.code(500).send({ error: message });
  });

  app.get("/healthz", async () => ({ ok: true, llmMode: rt.cfg.llmMode }));

  /* -------------------------------- projects ------------------------------ */

  app.get("/v1/projects", async () => ({ projects: await listProjects(rt.db) }));

  app.post("/v1/projects", async (req, reply) => {
    const body = req.body as {
      name?: string;
      source?: { kind?: string; url?: string; path?: string };
      appRoot?: string;
      ctaUrl?: string;
    };
    const source = body.source ?? {};
    const url = source.url ?? source.path;
    if (!body.name || !url) {
      return reply.code(400).send({ error: "name and source.url (or source.path) are required" });
    }
    const project = await createProject(rt.db, {
      name: body.name,
      sourceKind: source.kind === "git" ? "git" : "local",
      sourceUrl: url,
      appRoot: body.appRoot,
      ctaUrl: body.ctaUrl,
    });
    return reply.code(201).send({ project });
  });

  app.get("/v1/projects/:id", async (req, reply) => {
    const project = await getProject(rt.db, param(req, "id"));
    if (!project) return reply.code(404).send({ error: "no such project" });
    const publication = await getPublicationByProject(rt.db, project.id);
    return { project, runs: await listRuns(rt.db, project.id), publication };
  });

  // Overriding the detected profile is the escape hatch for every repo we
  // guessed wrong about, so it takes a full profile and validates it.
  app.patch("/v1/projects/:id", async (req, reply) => {
    const project = await getProject(rt.db, param(req, "id"));
    if (!project) return reply.code(404).send({ error: "no such project" });
    const parsed = RepoProfile.safeParse((req.body as { repoProfile?: unknown }).repoProfile);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid repoProfile", detail: parsed.error.issues });
    }
    await setRepoProfile(rt.db, project.id, parsed.data);
    return { project: await getProject(rt.db, project.id) };
  });

  /* ---------------------------------- runs -------------------------------- */

  app.post("/v1/projects/:id/runs", async (req, reply) => {
    const project = await getProject(rt.db, param(req, "id"));
    if (!project) return reply.code(404).send({ error: "no such project" });
    const kind = (req.body as { kind?: string })?.kind === "regen" ? "regen" : "initial";

    const previous = (await listRuns(rt.db, project.id)).find((r) => r.status === "succeeded");
    if (kind === "regen" && !previous) {
      return reply.code(409).send({ error: "nothing to regenerate: no run has succeeded yet" });
    }

    const run = await createRun(rt.db, {
      projectId: project.id,
      kind,
      baseRunId: kind === "regen" ? (previous?.id ?? null) : null,
    });
    await enqueue(rt.db, { runId: run.id, stage: kind === "regen" ? "regen" : "analyse" });
    bus.emit(run.id, { stage: "run", status: "queued", message: `${kind} run queued` });
    return reply.code(201).send({ run });
  });

  app.get("/v1/runs/:id", async (req, reply) => {
    const run = await getRun(rt.db, param(req, "id"));
    if (!run) return reply.code(404).send({ error: "no such run" });
    return {
      run,
      stages: await listStages(rt.db, run.id),
      artifacts: await listArtifacts(rt.db, run.id),
      diff: await getDiff(rt.db, run.id),
    };
  });

  app.get("/v1/runs/:id/use-cases", async (req, reply) => {
    const run = await getRun(rt.db, param(req, "id"));
    if (!run) return reply.code(404).send({ error: "no such run" });
    return { useCases: await listUseCases(rt.db, run.id) };
  });

  app.post("/v1/use-cases/:id/select", async (req, reply) => {
    const useCase = await getUseCase(rt.db, param(req, "id"));
    if (!useCase) return reply.code(404).send({ error: "no such use case" });
    const run = await getRun(rt.db, useCase.run_id);
    if (!run) return reply.code(404).send({ error: "no such run" });
    if (run.status !== "awaiting_selection") {
      return reply.code(409).send({ error: `run is ${run.status}, not awaiting a selection` });
    }
    await setRunStatus(rt.db, run.id, "queued");
    await enqueue(rt.db, {
      runId: run.id,
      stage: "produce",
      payload: { useCaseId: useCase.id },
    });
    bus.emit(run.id, { stage: "run", status: "queued", message: "Filming queued" });
    return reply.code(202).send({ run: await getRun(rt.db, run.id) });
  });

  /* --------------------------------- events ------------------------------- */

  app.get("/v1/runs/:id/events", async (req, reply) => {
    const runId = param(req, "id");
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const write = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const e of bus.replay(runId)) write(e);

    const run = await getRun(rt.db, runId);
    if (run && (run.status === "succeeded" || run.status === "failed")) {
      write({ stage: "run", status: run.status, message: "run finished", at: run.finished_at });
    }

    const unsubscribe = bus.subscribe(runId, write);
    // Comment frames keep proxies from closing an otherwise silent stream.
    const beat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(beat);
      unsubscribe();
    });
    return reply;
  });

  /* -------------------------------- artifacts ----------------------------- */

  app.get("/v1/artifacts/:id/files/*", async (req, reply) => {
    const artifact = await getArtifact(rt.db, param(req, "id"));
    if (!artifact) return reply.code(404).send({ error: "no such artifact" });
    const rel = (req.params as Record<string, string>)["*"] ?? "";
    const files = artifact.files as Record<string, string>;

    const direct = files[rel];
    if (direct) return sendFile(reply, direct);

    const dir = files["demoDir"];
    if (dir) {
      const path = safeJoin(dir, rel || "index.html");
      if (path) return sendFile(reply, path);
    }
    return reply.code(404).send({ error: "not found" });
  });

  /* ------------------------------- publishing ----------------------------- */

  app.post("/v1/publications", async (req, reply) => {
    const runId = (req.body as { runId?: string })?.runId;
    if (!runId) return reply.code(400).send({ error: "runId is required" });
    const run = await getRun(rt.db, runId);
    if (!run) return reply.code(404).send({ error: "no such run" });
    if (run.status !== "succeeded") {
      return reply.code(409).send({ error: `run is ${run.status}; only a succeeded run can go live` });
    }
    await enqueue(rt.db, { runId: run.id, stage: "publish" });
    return reply.code(202).send({ queued: true, runId: run.id });
  });

  /* ---------------------------- public: the demo -------------------------- */

  // Redirect to the trailing slash rather than serving here: the player asks
  // for "./demo.json", and without it that resolves to /d/demo.json.
  app.get("/d/:slug", async (req, reply) => reply.redirect(`/d/${param(req, "slug")}/`, 301));
  app.get("/d/:slug/", async (req, reply) => servePublished(req, reply, "index.html"));
  app.get("/d/:slug/*", async (req, reply) =>
    servePublished(req, reply, (req.params as Record<string, string>)["*"] ?? "index.html"),
  );

  async function servePublished(req: FastifyRequest, reply: FastifyReply, rel: string) {
    const pub = await getPublicationBySlug(rt.db, param(req, "slug"));
    if (!pub) return reply.code(404).send({ error: "no such demo" });
    const root = rt.storage.localPath(`published/${pub.alias_slug}`);
    if (!root) return reply.code(500).send({ error: "storage has no local path" });
    const path = safeJoin(root, rel);
    if (!path) return reply.code(404).send({ error: "not found" });
    return sendFile(reply, path);
  }

  /**
   * The freshness badge.
   *
   * It is deliberately never cached: the whole point is that it turns yellow
   * the moment the repository moves past what the demo shows, and a CDN
   * holding yesterday's green would defeat it.
   */
  app.get("/badge/:slug.svg", async (req, reply) => {
    const slug = param(req, "slug");
    const pub = await getPublicationBySlug(rt.db, slug);
    reply.header("content-type", "image/svg+xml").header("cache-control", "no-store, max-age=0");
    if (!pub) return reply.send(badgeSvg({ synced: false, label: "unknown" }));

    const runs = await listRuns(rt.db, pub.project_id);
    const newest = runs.find((r) => r.git_sha)?.git_sha ?? null;
    const synced = Boolean(pub.synced_sha) && pub.synced_sha === newest;
    return reply.send(badgeSvg({ synced, label: "synced" }));
  });

  app.get("/v1/publications/:slug", async (req, reply) => {
    const pub = await getPublicationBySlug(rt.db, param(req, "slug"));
    if (!pub) return reply.code(404).send({ error: "no such demo" });
    return { publication: pub, demoUrl: `/d/${pub.alias_slug}`, badgeUrl: `/badge/${pub.alias_slug}.svg` };
  });

  /* ------------------------------- the web UI ----------------------------- */

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/v1/")) {
      return reply.code(404).send({ error: "not found" });
    }
    const rel = req.url.split("?")[0] ?? "/";
    const asset = safeJoin(WEB_DIST, rel === "/" ? "index.html" : rel.slice(1));
    if (asset && (await isFile(asset))) return sendFile(reply, asset);
    // Unknown path inside a single-page app: hand back the shell and let the
    // client router decide — but only if the UI was actually built.
    const shell = join(WEB_DIST, "index.html");
    if (await isFile(shell)) return sendFile(reply, shell);
    return reply.code(404).send({ error: "not found" });
  });

  const worker = opts.worker === false ? null : startWorker(rt, bus);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? rt.cfg.port;
  const url = await app.listen({ host, port });
  rt.log.info("api listening", { url, worker: worker !== null, llmMode: rt.cfg.llmMode });

  return {
    app,
    bus,
    worker,
    url,
    async close() {
      await worker?.stop();
      await app.close();
    },
  };
}

function param(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string>)[name] ?? "";
}
