import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Flow, Step, type LlmUsage, type UseCase } from "@sdv/core";
import {
  NativeScreens,
  ScriptDraft,
  UseCaseList,
  type LlmClient,
  type RepoDigest,
  type NativeScreen,
  type UseCaseDraft,
} from "./types.ts";
import {
  FLOW_SCHEMA,
  NATIVE_SCREENS_SCHEMA,
  SCRIPT_SCHEMA,
  STEP_SCHEMA,
  USE_CASE_LIST_SCHEMA,
} from "./json-schema.ts";
import { renderDigest } from "./digest-text.ts";

const MODEL = "claude-opus-5";

/** Anthropic list price for the model above, per million tokens. */
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

export interface LiveOptions {
  apiKey: string;
  templatesDir: string;
}

/**
 * The real model path.
 *
 * The repository digest is the expensive part of every prompt and it does not
 * change within a run, so it is sent as one cached block: extraction pays to
 * write it, and flow generation and script writing read it back at a tenth of
 * the price. Every response is constrained to a JSON schema and then parsed
 * again with zod, because a schema the API enforces and a shape this codebase
 * relies on are two different promises.
 */
export function createLiveLlm(opts: LiveOptions): LlmClient {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const usage: LlmUsage[] = [];

  async function prompt(name: string): Promise<string> {
    return readFile(join(opts.templatesDir, "prompts", `${name}.md`), "utf8");
  }

  async function call<T>(args: {
    purpose: string;
    system: string;
    digest: RepoDigest;
    task: string;
    schema: Record<string, unknown>;
    effort?: "low" | "medium" | "high";
  }): Promise<T> {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: {
        effort: args.effort ?? "high",
        format: { type: "json_schema", schema: args.schema as never },
      },
      system: [
        { type: "text", text: args.system },
        {
          type: "text",
          text: renderDigest(args.digest),
          // The digest is identical across this run's calls: cache it once and
          // let the later stages read it back.
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: args.task }],
    });

    record(usage, args.purpose, res.usage);

    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new Error(`${args.purpose}: model returned no text block`);
    }
    return JSON.parse(text.text) as T;
  }

  return {
    mode: "live",
    usage: () => usage,

    async extractUseCases(digest): Promise<UseCaseDraft[]> {
      const system = await prompt("understand");
      const raw = await call<unknown>({
        purpose: "understand",
        system,
        digest,
        task:
          "Propose the demo-worthy user journeys for this repository. " +
          "Prefer journeys an end-to-end test already describes — those are the ones the team " +
          "decided were worth protecting. Return between three and seven.",
        schema: USE_CASE_LIST_SCHEMA,
      });
      return UseCaseList.parse(raw).useCases;
    },

    async generateFlow(digest, useCase): Promise<Flow> {
      const system = await prompt("flowgen");
      const raw = await call<Record<string, unknown>>({
        purpose: "flowgen",
        system,
        digest,
        task:
          `Write the flow for this use case:\n\n${JSON.stringify(useCase, null, 2)}\n\n` +
          "Start at its entry route. Prefer role, label and test-id targets over CSS. " +
          "Keep it under twelve steps.",
        schema: FLOW_SCHEMA,
      });
      return Flow.parse({ ...raw, schemaVersion: 1, useCaseId: useCase.id });
    },

    async writeScript(digest, useCase, flow): Promise<ScriptDraft> {
      const system = await prompt("script");
      const raw = await call<unknown>({
        purpose: "script",
        system,
        digest,
        task:
          `Write the on-screen captions for this flow.\n\n` +
          `Use case: ${JSON.stringify(useCase.title)}\n` +
          `Steps: ${JSON.stringify(flow.steps.map((s) => s.do))}\n\n` +
          `Return exactly ${flow.steps.length} captions, one per step.`,
        schema: SCRIPT_SCHEMA,
        effort: "medium",
      });
      return ScriptDraft.parse(raw);
    },

    /**
     * Render a native app's screens as HTML.
     *
     * The one call that does not take the repository digest: a screen is
     * rendered from the file that declares it, and the rest of the repository
     * would only be noise. Effort is high because layout judgement is the
     * whole value here — anyone can list the labels, and the deterministic
     * path already does.
     */
    async renderScreens({ platform, files }): Promise<NativeScreen[]> {
      const system = await prompt("render-native");
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: NATIVE_SCREENS_SCHEMA as never },
        },
        system: [{ type: "text", text: system }],
        messages: [
          {
            role: "user",
            content:
              `Platform: ${platform}\n\n` +
              files
                .map((f) => `--- ${f.path} ---\n${f.text}`)
                .join("\n\n") +
              "\n\nRender the screens these files declare. At most eight, most " +
              "important first, and the first one takes the path \"/\".",
          },
        ],
      });
      record(usage, "render-native", res.usage);
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("render-native: no text block");
      return NativeScreens.parse(JSON.parse(text.text)).screens;
    },

    async repairStep({ digest, flow, stepIndex, domExcerpt }) {
      const system = await prompt("repair");
      const broken = flow.steps[stepIndex];
      if (!broken) return null;
      try {
        const raw = await call<Record<string, unknown>>({
          purpose: "repair",
          system,
          digest,
          task:
            `This step no longer finds its target after a UI change:\n${JSON.stringify(broken, null, 2)}\n\n` +
            `Here is the relevant part of the page now:\n${domExcerpt.slice(0, 12_000)}\n\n` +
            "Return the same step with a target that resolves, or the step unchanged if you cannot tell.",
          schema: STEP_SCHEMA,
          effort: "medium",
        });
        return Step.parse(raw);
      } catch {
        return null;
      }
    },
  };
}

export type ApiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/**
 * Turn one API response's token counts into a costed line.
 *
 * Cached input is charged at a tenth of fresh input, which is the entire
 * reason the digest is sent as one cached block — so this arithmetic is what
 * proves the caching is actually paying for itself, not a guess about it.
 */
export function priceUsage(purpose: string, u: ApiUsage): LlmUsage {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const usd =
    (input * PRICE.input +
      output * PRICE.output +
      cacheWrite * PRICE.cacheWrite +
      cacheRead * PRICE.cacheRead) /
    1_000_000;

  return {
    model: MODEL,
    purpose,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    usd: Number(usd.toFixed(6)),
  };
}

function record(sink: LlmUsage[], purpose: string, u: ApiUsage): void {
  sink.push(priceUsage(purpose, u));
}
