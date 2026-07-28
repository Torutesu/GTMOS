import type { SdvConfig } from "@sdv/core";
import { createMockLlm } from "./mock.ts";
import { createLiveLlm } from "./live.ts";
import type { LlmClient } from "./types.ts";

export * from "./types.ts";
export { createMockLlm } from "./mock.ts";
export { createLiveLlm, priceUsage } from "./live.ts";
export { renderDigest } from "./digest-text.ts";

export function createLlm(cfg: SdvConfig, templatesDir: string): LlmClient {
  if (cfg.llmMode === "live") {
    if (!cfg.anthropicApiKey) {
      throw new Error("SDV_LLM_MODE=live requires ANTHROPIC_API_KEY");
    }
    return createLiveLlm({ apiKey: cfg.anthropicApiKey, templatesDir });
  }
  return createMockLlm();
}
