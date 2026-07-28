import { id, type RepoProfile, type UseCase } from "@sdv/core";
import { insertUseCases } from "@sdv/db";
import type { RepoDigest } from "@sdv/llm";
import type { StageContext } from "../context.ts";
import { buildDigest } from "../digest.ts";

export interface UnderstandResult {
  digest: RepoDigest;
  useCases: UseCase[];
}

/**
 * Work out what this app is for, and offer the ways to show it.
 *
 * This stage only reads source, so it runs while the build is still going.
 * That parallelism is most of the difference between a fifteen-minute wait
 * and a twenty-five-minute one — and the user spends the remainder choosing a
 * candidate, which is time they were going to spend anyway.
 */
export async function understand(
  ctx: StageContext,
  srcDir: string,
  profile: RepoProfile,
): Promise<UnderstandResult> {
  ctx.progress({ stage: "understand", status: "running", message: "Reading the repository" });
  const digest = await buildDigest(srcDir, profile);

  ctx.log.info("digest built", {
    routes: digest.routes.length,
    specs: digest.specs.length,
    approxTokens: digest.approxTokens,
  });

  ctx.progress({
    stage: "understand",
    status: "running",
    message: `Proposing demos from ${digest.specs.length} tests and ${digest.routes.length} routes`,
  });

  const drafts = await ctx.llm.extractUseCases(digest);
  const useCases: UseCase[] = drafts.map((d) => ({ ...d, id: id("uc") }));

  await insertUseCases(
    ctx.db,
    ctx.projectId,
    ctx.runId,
    useCases.map((u) => ({
      id: u.id,
      title: u.title,
      hypothesis: u.hypothesis,
      entryRoute: u.entryRoute,
      outline: u.outline,
      signals: u.signals,
      origin: u.origin,
    })),
  );

  return { digest, useCases };
}
