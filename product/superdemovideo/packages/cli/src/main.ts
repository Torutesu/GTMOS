#!/usr/bin/env tsx
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { apiClient, ApiError } from "./client.ts";

const USAGE = `sdv — Superdemovideo

  sdv doctor                       check this machine has everything a run needs
  sdv init <path|url> [--name N]   register a project and start its first run
  sdv status <runId> [--follow]    stage progress; --follow streams it live
  sdv select <runId> <index>       pick a candidate demo (1-based) and start filming
  sdv regen <projectId>            re-film the existing demo against today's code
  sdv export <runId> [--out F]     write the demo as one self-contained HTML file
  sdv publish <runId>              make a finished run the live demo
  sdv open <slug>                  print the public URLs for a published demo
  sdv projects                     list projects

Environment: SDV_API_URL (default http://127.0.0.1:3000), SDV_TOKEN.
`;

type Json = Record<string, any>;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "doctor":
      return doctor();
    case "init":
      return init(rest);
    case "status":
      return status(rest);
    case "select":
      return select(rest);
    case "regen":
      return regen(rest);
    case "export":
      return exportDemo(rest);
    case "publish":
      return publish(rest);
    case "open":
      return open(rest);
    case "projects":
      return projects();
    default:
      console.error(`Unknown command: ${command}\n`);
      process.stdout.write(USAGE);
      return 2;
  }
}

/* -------------------------------- commands ------------------------------- */

async function doctor(): Promise<number> {
  const { runDoctor, reportDoctor } = await import("../../../scripts/doctor.ts");
  return reportDoctor(await runDoctor()) ? 0 : 1;
}

async function init(args: string[]): Promise<number> {
  const source = args.find((a) => !a.startsWith("--"));
  if (!source) {
    console.error("Usage: sdv init <path|url> [--name NAME]");
    return 2;
  }
  const nameFlag = flag(args, "--name");
  const isUrl = /^(https?|git)[:@]/.test(source);
  const api = apiClient();

  const created = (await api.post("/v1/projects", {
    name: nameFlag ?? basename(resolve(source)),
    source: isUrl ? { kind: "git", url: source } : { kind: "local", path: resolve(source) },
    appRoot: flag(args, "--app-root"),
    ctaUrl: flag(args, "--cta"),
  })) as Json;

  const project = created["project"];
  const run = ((await api.post(`/v1/projects/${project.id}/runs`, { kind: "initial" })) as Json)[
    "run"
  ];

  console.log(`project  ${project.id}  ${project.name}`);
  console.log(`run      ${run.id}  (${run.status})`);
  console.log(`\nWatch it: sdv status ${run.id} --follow`);
  return 0;
}

async function status(args: string[]): Promise<number> {
  const runId = args.find((a) => !a.startsWith("--"));
  if (!runId) {
    console.error("Usage: sdv status <runId> [--follow]");
    return 2;
  }
  const api = apiClient();

  if (args.includes("--follow")) {
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    console.log(`following ${runId} — ctrl-c to stop\n`);
    try {
      await api.events(
        `/v1/runs/${runId}/events`,
        (e) => {
          const ev = e as { stage?: string; status?: string; message?: string };
          console.log(`${pad(ev.stage ?? "run", 12)} ${pad(ev.status ?? "", 10)} ${ev.message ?? ""}`);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    }
    return 0;
  }

  const data = (await api.get(`/v1/runs/${runId}`)) as Json;
  const run = data["run"];
  console.log(`run    ${run.id}  ${run.kind}  ${run.status}`);
  if (run.error_code) console.log(`error  ${run.error_code}  ${run.error_detail ?? ""}`);
  console.log(`sha    ${run.git_sha ?? "—"}`);

  for (const s of data["stages"] as Json[]) {
    const seconds = run.cost?.stageSeconds?.[s.stage];
    console.log(
      `  ${pad(s.stage, 12)} ${pad(s.status, 10)} ${seconds !== undefined ? `${seconds}s` : ""}` +
        (s.error_code ? `  ${s.error_code}` : ""),
    );
  }

  if (run.status === "awaiting_selection") {
    const cases = ((await api.get(`/v1/runs/${runId}/use-cases`)) as Json)["useCases"] as Json[];
    console.log("\nCandidates — choose one with `sdv select`:");
    cases.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.title?.en ?? c.id}`);
      console.log(`     ${c.hypothesis?.en ?? ""}`);
      console.log(`     entry ${c.entry_route}   from ${c.origin ?? "inference"}`);
    });
  }

  const total = run.cost?.totalSeconds;
  if (total) console.log(`\ntotal  ${total}s   llm $${(run.cost?.llmUsd ?? 0).toFixed(4)}`);

  const artifacts = data["artifacts"] as Json[];
  if (artifacts?.length) {
    console.log("\nArtifacts:");
    for (const a of artifacts) console.log(`  ${pad(a.kind, 12)} ${a.id}`);
  }

  const diff = data["diff"] as Json | null;
  if (diff) {
    console.log(`\nDiff vs ${diff.baseRunId}: ${diff.summary}`);
    for (const s of diff.steps as Json[]) {
      if (!s.changed) continue;
      console.log(`  step ${s.index}  ${pad(s.status, 8)} ${(s.diffRatio * 100).toFixed(1)}% changed`);
    }
  }
  return 0;
}

async function select(args: string[]): Promise<number> {
  const [runId, indexArg] = args;
  const index = Number(indexArg);
  if (!runId || !Number.isFinite(index) || index < 1) {
    console.error("Usage: sdv select <runId> <index>   (index is 1-based)");
    return 2;
  }
  const api = apiClient();
  const cases = ((await api.get(`/v1/runs/${runId}/use-cases`)) as Json)["useCases"] as Json[];
  const chosen = cases[index - 1];
  if (!chosen) {
    console.error(`There are ${cases.length} candidates; ${index} is out of range.`);
    return 2;
  }
  await api.post(`/v1/use-cases/${chosen.id}/select`);
  console.log(`filming "${chosen.title?.en ?? chosen.id}"`);
  console.log(`\nWatch it: sdv status ${runId} --follow`);
  return 0;
}

async function regen(args: string[]): Promise<number> {
  const [projectId] = args;
  if (!projectId) {
    console.error("Usage: sdv regen <projectId>");
    return 2;
  }
  const run = ((await apiClient().post(`/v1/projects/${projectId}/runs`, {
    kind: "regen",
  })) as Json)["run"];
  console.log(`run  ${run.id}  (${run.status})`);
  console.log(`\nWatch it: sdv status ${run.id} --follow`);
  return 0;
}

async function exportDemo(args: string[]): Promise<number> {
  const runId = args.find((a) => !a.startsWith("--"));
  if (!runId) {
    console.error("Usage: sdv export <runId> [--out demo.html]");
    return 2;
  }
  const api = apiClient();
  const res = await fetch(`${api.baseUrl}/v1/runs/${runId}/standalone.html`, {
    headers: process.env["SDV_TOKEN"]
      ? { authorization: `Bearer ${process.env["SDV_TOKEN"]}` }
      : {},
  });
  if (!res.ok) {
    console.error(`export failed: ${res.status} ${await res.text()}`);
    return 1;
  }
  const out = flag(args, "--out") ?? `demo-${runId}.html`;
  const html = await res.text();
  await writeFile(out, html);
  console.log(`${out}  ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)}MB`);
  console.log("Open it directly — it needs no server and makes no requests.");
  return 0;
}

async function publish(args: string[]): Promise<number> {
  const [runId] = args;
  if (!runId) {
    console.error("Usage: sdv publish <runId>");
    return 2;
  }
  await apiClient().post("/v1/publications", { runId });
  console.log("publishing queued — the demo URL stays the same, its contents change");
  return 0;
}

async function open(args: string[]): Promise<number> {
  const [slug] = args;
  if (!slug) {
    console.error("Usage: sdv open <slug>");
    return 2;
  }
  const api = apiClient();
  const data = (await api.get(`/v1/publications/${slug}`)) as Json;
  console.log(`demo   ${api.baseUrl}${data["demoUrl"]}`);
  console.log(`badge  ${api.baseUrl}${data["badgeUrl"]}`);
  console.log(`\nREADME badge:`);
  console.log(`[![demo](${api.baseUrl}${data["badgeUrl"]})](${api.baseUrl}${data["demoUrl"]})`);
  return 0;
}

async function projects(): Promise<number> {
  const list = ((await apiClient().get("/v1/projects")) as Json)["projects"] as Json[];
  if (list.length === 0) {
    console.log("No projects yet. Start one with `sdv init <path>`.");
    return 0;
  }
  for (const p of list) console.log(`${pad(p.id, 26)} ${pad(p.name, 24)} ${p.source_url}`);
  return 0;
}

/* -------------------------------- helpers -------------------------------- */

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function pad(s: string, n: number): string {
  return String(s).padEnd(n);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ApiError) console.error(err.message);
    else console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
