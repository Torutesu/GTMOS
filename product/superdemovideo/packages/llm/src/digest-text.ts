import type { RepoDigest } from "./types.ts";

/**
 * Render the digest as the text block the model reads.
 *
 * Order matters for caching: this must be byte-identical across every call in
 * a run, so nothing here may include a timestamp, a run id, or anything else
 * that varies per request.
 */
export function renderDigest(d: RepoDigest): string {
  const lines: string[] = [];

  lines.push(`# Repository: ${d.projectName}`);
  if (d.description) lines.push(d.description);
  lines.push(`Framework: ${d.framework}`);
  lines.push("");

  if (d.routes.length) {
    lines.push("## Routes");
    for (const r of d.routes) {
      lines.push(`- ${r.path}${r.label ? ` — ${r.label}` : ""}  (${r.file})`);
    }
    lines.push("");
  }

  if (d.specs.length) {
    lines.push("## End-to-end tests");
    lines.push(
      "Each test is a journey the team already decided was worth protecting, " +
        "with selectors that are known to work.",
    );
    for (const s of d.specs) {
      lines.push(`\n### ${s.title}${s.isSetup ? " (setup)" : ""}  — ${s.file}`);
      for (const a of s.actions) {
        const bits = [a.kind, a.locator, a.role, a.name, a.value].filter(Boolean);
        lines.push(`  - ${bits.join(" · ")}`);
      }
    }
    lines.push("");
  }

  if (d.analyticsEvents.length) {
    lines.push("## Analytics events");
    lines.push(d.analyticsEvents.map((e) => `- ${e}`).join("\n"));
    lines.push("");
  }

  if (Object.keys(d.packageScripts).length) {
    lines.push("## Scripts");
    for (const [k, v] of Object.entries(d.packageScripts)) lines.push(`- ${k}: ${v}`);
    lines.push("");
  }

  if (d.changelog) {
    lines.push("## Recent changes");
    lines.push(d.changelog);
    lines.push("");
  }

  if (d.readme) {
    lines.push("## README");
    lines.push(d.readme);
  }

  return lines.join("\n");
}
