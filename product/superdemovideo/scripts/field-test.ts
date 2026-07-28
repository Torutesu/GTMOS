#!/usr/bin/env tsx
/**
 * Point the pipeline at repositories nobody here wrote.
 *
 * The golden fixture is the best case by construction — we built it to be
 * detectable. This runs the risky half of the pipeline (ingest, detect,
 * understand, and optionally build and seed) against real projects and reports
 * what it got wrong, so the failures become changes to the heuristics rather
 * than a claim nobody checked.
 *
 *   pnpm tsx scripts/field-test.ts /path/to/repo https://github.com/o/r ...
 *   pnpm tsx scripts/field-test.ts --build ...     also try to start the app
 *
 * With no arguments it uses whatever is checked out under fixtures/field/.
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toSdvError, type RepoProfile } from "@sdv/core";
import { createProject, createRun, listUseCases } from "@sdv/db";
import { createRuntime, runContext, type Runtime } from "@sdv/api";
import { analyse, build, seed, stagePaths } from "@sdv/pipeline";

const FIELD_DIR = fileURLToPath(new URL("../fixtures/field", import.meta.url));

interface Report {
  name: string;
  source: string;
  ok: boolean;
  seconds: number;
  profile: RepoProfile | null;
  useCases: number;
  fromSpecs: number;
  appUp: boolean | null;
  notes: string[];
  error: string | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const withBuild = args.includes("--build");
  let sources = args.filter((a) => !a.startsWith("--"));

  if (sources.length === 0) {
    const entries = await readdir(FIELD_DIR, { withFileTypes: true }).catch(() => []);
    sources = entries.filter((e) => e.isDirectory()).map((e) => join(FIELD_DIR, e.name));
  }
  if (sources.length === 0) {
    console.error(`Nothing to test. Pass repository paths or URLs, or clone some into ${FIELD_DIR}.`);
    process.exit(2);
  }

  const varDir = await mkdtemp(join(tmpdir(), "sdv-field-"));
  const rt = await createRuntime({ varDir, llmMode: "mock", token: null, port: 0 });
  const reports: Report[] = [];

  try {
    for (const source of sources) {
      reports.push(await probe(rt, source, withBuild));
    }
  } finally {
    await rt.close();
    await rm(varDir, { recursive: true, force: true });
  }

  print(reports, withBuild);
  process.exit(reports.every((r) => r.ok) ? 0 : 1);
}

async function probe(rt: Runtime, source: string, withBuild: boolean): Promise<Report> {
  const isUrl = /^(https?|git)[:@]/.test(source);
  const name = isUrl ? (source.split("/").pop() ?? source) : basename(resolve(source));
  const report: Report = {
    name,
    source,
    ok: false,
    seconds: 0,
    profile: null,
    useCases: 0,
    fromSpecs: 0,
    appUp: withBuild ? false : null,
    notes: [],
    error: null,
  };

  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 56 - name.length))}`);
  const started = Date.now();

  const project = await createProject(rt.db, {
    name,
    sourceKind: isUrl ? "git" : "local",
    sourceUrl: isUrl ? source : resolve(source),
  });
  const run = await createRun(rt.db, { projectId: project.id, kind: "initial" });
  const ctx = runContext(rt, { runId: run.id, projectId: project.id });

  try {
    const { profile } = await analyse(ctx);
    report.profile = profile;

    const cases = await listUseCases(rt.db, run.id);
    report.useCases = cases.length;
    report.fromSpecs = cases.filter((c) => (c.origin ?? "").includes("spec")).length;

    console.log(`   framework   ${profile.framework}  (confidence ${profile.confidence.toFixed(2)})`);
    console.log(`   manager     ${profile.packageManager}${profile.appRoot ? `  root ${profile.appRoot}` : ""}`);
    console.log(`   install     ${profile.build.install}`);
    console.log(`   build       ${profile.build.build ?? "(none)"}`);
    console.log(`   start       ${profile.build.start}   :${profile.build.port}`);
    console.log(`   e2e         ${profile.e2e ? `${profile.e2e.kind}, ${profile.e2e.specPaths.length} specs` : "none found"}`);
    console.log(`   env         ${profile.env.length ? profile.env.map((e) => e.key).join(", ") : "none"}`);
    console.log(`   use cases   ${report.useCases}  (${report.fromSpecs} from specs)`);

    if (profile.framework === "unknown") report.notes.push("framework not recognised");
    if (profile.confidence < 0.5) report.notes.push("low confidence — a human would have to confirm");
    if (!profile.e2e) report.notes.push("no e2e specs, so candidates are inferred from routes alone");
    if (report.useCases === 0) report.notes.push("no candidates at all");

    if (withBuild) {
      report.appUp = await tryBuild(ctx, profile, report);
    }

    // "Got far enough to film" is not "produced a use case". A run that
    // reaches capture with one generic candidate inferred from nothing is a
    // failure dressed as a pass, and calling it green here would repeat
    // exactly the mistake this script exists to catch.
    report.ok =
      report.useCases >= 2 &&
      report.fromSpecs + (report.profile?.e2e?.specPaths.length ?? 0) > 0 &&
      profile.confidence >= 0.5 &&
      (!withBuild || report.appUp === true);
  } catch (err) {
    const sdv = toSdvError(err);
    report.error = `${sdv.code}: ${sdv.detail ?? sdv.message}`.slice(0, 400);
    console.log(`   FAILED      ${report.error}`);
  }

  report.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  console.log(`   took        ${report.seconds}s`);
  return report;
}

async function tryBuild(
  ctx: ReturnType<typeof runContext>,
  profile: RepoProfile,
  report: Report,
): Promise<boolean> {
  console.log(`   building…`);
  let app: Awaited<ReturnType<typeof build>> | null = null;
  try {
    app = await build(ctx, profile);
    console.log(`   app up      ${app.baseUrl}`);
    const seeded = await seed(ctx, profile, app.baseUrl, "/");
    console.log(`   seed        ${seeded.strategy}${seeded.storageState ? " (with a session)" : ""}`);
    return true;
  } catch (err) {
    const sdv = toSdvError(err);
    report.notes.push(`${sdv.code} on build/seed`);
    const log = join(stagePaths(ctx.workDir).logs, "build.log");
    console.log(`   BUILD FAIL  ${sdv.code} — ${(sdv.detail ?? sdv.message).slice(0, 200)}`);
    console.log(`               log: ${log}`);
    return false;
  } finally {
    await app?.stop().catch(() => {});
  }
}

function print(reports: Report[], withBuild: boolean): void {
  console.log(`\n${"═".repeat(64)}\nSummary\n`);
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(
    `${pad("repo", 18)} ${pad("framework", 12)} ${pad("conf", 5)} ${pad("specs", 6)} ${pad("cases", 6)} ${withBuild ? pad("app", 5) : ""}notes`,
  );
  for (const r of reports) {
    console.log(
      `${pad(r.name, 18)} ${pad(r.profile?.framework ?? "—", 12)} ` +
        `${pad(r.profile ? r.profile.confidence.toFixed(2) : "—", 5)} ` +
        `${pad(r.profile?.e2e?.specPaths.length ?? 0, 6)} ${pad(r.useCases, 6)} ` +
        `${withBuild ? pad(r.appUp ? "up" : "no", 5) : ""}` +
        `${r.error ?? r.notes.join("; ")}`,
    );
  }

  const good = reports.filter((r) => r.ok).length;
  console.log(
    `\n${good} of ${reports.length} repositories produced something worth filming` +
      `${withBuild ? "" : " (analysis only — pass --build to find out whether they actually run)"}.`,
  );
  if (process.env["SDV_LLM_MODE"] !== "live") {
    console.log(
      "\nNote: mock mode. Candidate counts here measure the deterministic signals\n" +
        "(specs, routes) reaching the model, not what the model would make of them.",
    );
  }
}

/** Guard against a source path that does not exist before spending a minute on it. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
