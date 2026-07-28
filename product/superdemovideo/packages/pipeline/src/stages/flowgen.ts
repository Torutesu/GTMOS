import { Flow, SdvError, type UseCase } from "@sdv/core";
import { insertFlow } from "@sdv/db";
import type { RepoDigest } from "@sdv/llm";
import type { StageContext } from "../context.ts";

export interface FlowgenResult {
  flow: Flow;
  flowId: string;
}

/**
 * Turn the chosen journey into steps a browser can execute.
 *
 * The result is validated twice: once by the schema the model was given, and
 * again here. The second check is the one that matters — it is this codebase
 * deciding what it is willing to run, rather than trusting what came back.
 */
export async function flowgen(
  ctx: StageContext,
  digest: RepoDigest,
  useCase: UseCase,
): Promise<FlowgenResult> {
  ctx.progress({ stage: "flowgen", status: "running", message: "Writing the flow" });

  const draft = await ctx.llm.generateFlow(digest, useCase);

  let flow: Flow;
  try {
    flow = Flow.parse(draft);
  } catch (err) {
    throw new SdvError("SDV-E050", `generated flow is not valid: ${(err as Error).message}`);
  }

  const cssTargets = flow.steps.filter(
    (s) => "target" in s && s.target && "css" in s.target && s.target.css,
  ).length;
  if (cssTargets > 0) {
    ctx.log.warn("flow relies on css selectors, which break first on a UI change", { cssTargets });
  }

  const row = await insertFlow(ctx.db, {
    useCaseId: useCase.id,
    projectId: ctx.projectId,
    runId: ctx.runId,
    flow,
  });

  ctx.log.info("flow generated", { steps: flow.steps.length, version: row.version });
  return { flow, flowId: row.id };
}
