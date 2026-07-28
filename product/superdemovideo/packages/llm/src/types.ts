import { z } from "zod";
import { Flow, LocalizedText, SignalSource, Step, UseCase, type LlmUsage } from "@sdv/core";

/* ------------------------------------------------------------------ *
 * Repository digest — the deterministic input every model call shares.
 *
 * It is built once per run and reused, which is why it is worth caching
 * server-side: extraction writes it, flow generation and script writing
 * read it back at a tenth of the price.
 * ------------------------------------------------------------------ */

export interface RouteInfo {
  path: string;
  file: string;
  /** Human-readable label lifted from the nav or the page heading, if any. */
  label: string | null;
}

export interface SpecAction {
  kind: "goto" | "click" | "fill" | "select" | "press" | "expect" | "hover";
  /** Playwright locator call the action came from, e.g. getByRole. */
  locator: string | null;
  role: string | null;
  name: string | null;
  value: string | null;
  raw: string;
}

export interface SpecInfo {
  file: string;
  title: string;
  isSetup: boolean;
  actions: SpecAction[];
}

export interface RepoDigest {
  projectName: string;
  description: string | null;
  framework: string;
  readme: string;
  routes: RouteInfo[];
  specs: SpecInfo[];
  analyticsEvents: string[];
  changelog: string | null;
  packageScripts: Record<string, string>;
  /**
   * Screens already rendered as HTML, for a native app.
   *
   * Empty for anything with a web front end of its own. When it is not empty
   * it is the strongest thing in the digest: these are the exact pages the
   * capture will drive, so a candidate built from them cannot reference a
   * control that will not be there.
   */
  screens: NativeScreen[];
  /** Rough token size, used to decide what to trim. */
  approxTokens: number;
}

/* ------------------------------------------------------------------ *
 * Model outputs
 * ------------------------------------------------------------------ */

export const UseCaseDraft = UseCase.omit({ id: true }).extend({
  signals: z.array(SignalSource).min(1),
});
export type UseCaseDraft = z.infer<typeof UseCaseDraft>;

export const UseCaseList = z.object({
  useCases: z.array(UseCaseDraft).min(1).max(7),
});
export type UseCaseList = z.infer<typeof UseCaseList>;

export const ScriptDraft = z.object({
  title: LocalizedText,
  intro: LocalizedText,
  outro: LocalizedText,
  captions: z.array(LocalizedText),
});
export type ScriptDraft = z.infer<typeof ScriptDraft>;

/**
 * A native screen rendered as HTML.
 *
 * SwiftUI, Jetpack Compose and Android XML declare a hierarchy of labelled
 * controls rather than drawing pixels, which is the same shape as a document.
 * Rendering that to HTML is what lets a macOS, iOS or Android app reach the
 * same capture the web path uses — it is a rendition of what the source says,
 * not a screenshot of a running build.
 */
export const NativeScreen = z.object({
  /** Route the flow navigates to. The first screen should claim "/". */
  path: z.string().regex(/^\//, "a screen path starts with /"),
  title: z.string().min(1),
  /** Source file it came from, so a person can check the rendition. */
  source: z.string(),
  html: z.string().min(40),
});
export type NativeScreen = z.infer<typeof NativeScreen>;

export const NativeScreens = z.object({
  screens: z.array(NativeScreen).min(1).max(8),
});
export type NativeScreens = z.infer<typeof NativeScreens>;

export interface RenderScreensInput {
  platform: "macos" | "ios" | "android";
  files: Array<{ path: string; text: string }>;
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

export interface LlmClient {
  readonly mode: "mock" | "live";
  /** Usage accumulated since the client was created. */
  usage(): LlmUsage[];
  extractUseCases(digest: RepoDigest): Promise<UseCaseDraft[]>;
  generateFlow(digest: RepoDigest, useCase: UseCase): Promise<Flow>;
  writeScript(digest: RepoDigest, useCase: UseCase, flow: Flow): Promise<ScriptDraft>;
  /** Render a native app's declared screens as HTML the capture can drive. */
  renderScreens(input: RenderScreensInput): Promise<NativeScreen[]>;
  repairStep(input: {
    digest: RepoDigest;
    flow: Flow;
    stepIndex: number;
    domExcerpt: string;
  }): Promise<Step | null>;
}
