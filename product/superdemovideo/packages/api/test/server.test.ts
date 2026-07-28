import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, startServer, safeJoin, type Runtime } from "../src/index.ts";
import type { ServerHandle } from "../src/server.ts";

let rt: Runtime;
let server: ServerHandle;
let varDir: string;

beforeAll(async () => {
  varDir = await mkdtemp(join(tmpdir(), "sdv-api-"));
  rt = await createRuntime({ varDir, llmMode: "mock", token: "test-token", port: 0 });
  // No worker: these tests are about the HTTP contract, not the pipeline.
  server = await startServer(rt, { worker: false, port: 0 });
}, 60_000);

afterAll(async () => {
  await server?.close();
  await rt?.close();
  await rm(varDir, { recursive: true, force: true });
});

const auth = { authorization: "Bearer test-token" };

describe("authentication", () => {
  it("refuses an operator route without the token", async () => {
    const res = await server.app.inject({ method: "GET", url: "/v1/projects" });
    expect(res.statusCode).toBe(401);
  });

  it("leaves the published demo and badge open", async () => {
    const badge = await server.app.inject({ method: "GET", url: "/badge/nothing.svg" });
    expect(badge.statusCode).toBe(200);
    expect(badge.headers["content-type"]).toContain("image/svg+xml");
    // A badge in someone's README must always render something. An unknown
    // slug therefore gets an image, but never one claiming to be in sync.
    expect(badge.body).toContain("stale");
    expect(badge.body).not.toContain("synced");
    expect(badge.headers["cache-control"]).toContain("no-store");
  });
});

describe("projects and runs", () => {
  let projectId: string;

  it("creates a project", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth,
      payload: { name: "Taskloop", source: { kind: "local", path: "/nowhere" } },
    });
    expect(res.statusCode).toBe(201);
    projectId = res.json().project.id;
    expect(projectId).toMatch(/^prj_/);
  });

  it("rejects a project with no source", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth,
      payload: { name: "nameless" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("queues an initial run", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/runs`,
      headers: auth,
      payload: { kind: "initial" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().run.status).toBe("queued");
  });

  it("refuses to regenerate a project that has never succeeded", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/runs`,
      headers: auth,
      payload: { kind: "regen" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("validates a profile override instead of storing nonsense", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: auth,
      payload: { repoProfile: { framework: "vite", build: { port: "not a number" } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid profile override", async () => {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: auth,
      payload: {
        repoProfile: {
          framework: "vite",
          packageManager: "npm",
          nodeVersion: "22",
          appRoot: "",
          build: {
            install: "npm ci",
            build: "npm run build",
            start: "npm run preview",
            port: 4173,
          },
          e2e: null,
          env: [],
          confidence: 1,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.repo_profile.build.port).toBe(4173);
  });

  it("404s an unknown run", async () => {
    const res = await server.app.inject({ method: "GET", url: "/v1/runs/run_nope", headers: auth });
    expect(res.statusCode).toBe(404);
  });
});

describe("path safety", () => {
  it("refuses to walk out of the directory it was given", () => {
    expect(safeJoin("/srv/demo", "steps/000/screen.png")).toBe("/srv/demo/steps/000/screen.png");
    expect(safeJoin("/srv/demo", "../../etc/passwd")).toBeNull();
    expect(safeJoin("/srv/demo", "/etc/passwd")).toBeNull();
  });
});
