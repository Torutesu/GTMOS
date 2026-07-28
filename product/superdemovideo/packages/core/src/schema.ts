import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Localised text
 * ------------------------------------------------------------------ */

export const LocalizedText = z.object({ en: z.string(), ja: z.string() });
export type LocalizedText = z.infer<typeof LocalizedText>;

/* ------------------------------------------------------------------ *
 * RepoProfile — the output of Detect, editable by the user
 * ------------------------------------------------------------------ */

/**
 * What kind of thing the repository builds.
 *
 * Every demo is filmed as HTML in a browser, whatever the app is. The
 * platform decides only how that HTML is obtained: a web app serves its own,
 * an Electron app already has one behind a bridge we have to stand in for,
 * and a native app has none, so it has to be rendered from its UI source.
 */
export const Platform = z.enum(["web", "electron", "macos", "ios", "android"]);
export type Platform = z.infer<typeof Platform>;

export const Framework = z.enum([
  "nextjs",
  "vite",
  "astro",
  "cra",
  "sveltekit",
  "nuxt",
  "static",
  /** A desktop app. Recognised so we can say so, not because we can film it. */
  "electron",
  "unknown",
]);
export type Framework = z.infer<typeof Framework>;

export const PackageManager = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof PackageManager>;

export const EnvRequirement = z.object({
  key: z.string(),
  source: z.string(),
  /** How Build fills it in. We never accept real secrets. */
  strategy: z.enum(["placeholder", "skip"]).default("placeholder"),
});

export const RepoProfile = z.object({
  platform: Platform.default("web"),
  framework: Framework,
  packageManager: PackageManager,
  nodeVersion: z.string().nullable(),
  /** Sub-directory holding the app, relative to the repo root. "" = root. */
  appRoot: z.string(),
  build: z.object({
    install: z.string(),
    build: z.string().nullable(),
    start: z.string(),
    port: z.number().int().positive(),
  }),
  e2e: z
    .object({
      kind: z.enum(["playwright", "cypress"]),
      configPath: z.string(),
      testDir: z.string(),
      specPaths: z.array(z.string()),
      storageStatePath: z.string().nullable(),
    })
    .nullable(),
  env: z.array(EnvRequirement),
  /** 0..1. Below 0.5 the UI insists the user confirms before running. */
  confidence: z.number().min(0).max(1),
});
export type RepoProfile = z.infer<typeof RepoProfile>;

/* ------------------------------------------------------------------ *
 * Flow DSL — the only representation of a demo flow.
 *
 * Generated as JSON and interpreted by the capture executor. It is
 * deliberately not code: nothing here is ever eval'd.
 * ------------------------------------------------------------------ */

export const Target = z
  .object({
    role: z.object({ role: z.string(), name: z.string() }).optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    testId: z.string().optional(),
    /** Last resort. Brittle across UI changes; the generator avoids it. */
    css: z.string().optional(),
  })
  .refine((t) => Object.keys(t).length > 0, { message: "target needs at least one selector" });
export type Target = z.infer<typeof Target>;

export const Caption = LocalizedText;
export type Caption = LocalizedText;

const withCaption = { caption: Caption.optional() };

export const Step = z.discriminatedUnion("do", [
  z.object({ do: z.literal("goto"), path: z.string().startsWith("/"), ...withCaption }),
  z.object({ do: z.literal("click"), target: Target, ...withCaption }),
  z.object({ do: z.literal("fill"), target: Target, value: z.string(), ...withCaption }),
  z.object({ do: z.literal("select"), target: Target, value: z.string(), ...withCaption }),
  z.object({ do: z.literal("press"), key: z.string(), ...withCaption }),
  z.object({ do: z.literal("hover"), target: Target, ...withCaption }),
  z.object({ do: z.literal("expect"), target: Target, ...withCaption }),
  z.object({ do: z.literal("wait"), ms: z.number().int().min(50).max(5000), ...withCaption }),
]);
export type Step = z.infer<typeof Step>;

export const Flow = z
  .object({
    schemaVersion: z.literal(1),
    useCaseId: z.string(),
    title: LocalizedText,
    steps: z.array(Step).min(2).max(30),
  })
  .refine((f) => f.steps[0]?.do === "goto", { message: "a flow must start with a goto step" })
  .refine(
    (f) => !f.steps.some((s, i) => s.do === "wait" && f.steps[i + 1]?.do === "wait"),
    { message: "consecutive wait steps are not allowed" },
  );
export type Flow = z.infer<typeof Flow>;

/* ------------------------------------------------------------------ *
 * Use cases — the output of Understand
 * ------------------------------------------------------------------ */

export const SignalSource = z.enum([
  "e2e-test",
  "route",
  "analytics-event",
  "readme",
  "changelog",
  "feature-flag",
  /** A screen declared by a native app's interface source. */
  "screen",
]);
export type SignalSource = z.infer<typeof SignalSource>;

export const UseCase = z.object({
  id: z.string(),
  title: LocalizedText,
  hypothesis: LocalizedText,
  entryRoute: z.string(),
  outline: z.array(z.string()).min(1),
  signals: z.array(SignalSource).min(1),
  /** Free-form provenance, e.g. the spec file a candidate came from. */
  origin: z.string().nullable(),
});
export type UseCase = z.infer<typeof UseCase>;

/* ------------------------------------------------------------------ *
 * Capture bundle
 * ------------------------------------------------------------------ */

export const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Box = z.infer<typeof Box>;

export const Point = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

export const Viewport = z.object({
  name: z.enum(["desktop", "mobile"]),
  width: z.number().int(),
  height: z.number().int(),
  dpr: z.number(),
});
export type Viewport = z.infer<typeof Viewport>;

export const CaptureStep = z.object({
  index: z.number().int().nonnegative(),
  do: z.string(),
  caption: Caption.nullable(),
  beforePng: z.string(),
  afterPng: z.string(),
  domJson: z.string().nullable(),
  targetBox: Box.nullable(),
  clickPoint: Point.nullable(),
  durationMs: z.number().nonnegative(),
  ok: z.boolean(),
  errorCode: z.string().nullable(),
});
export type CaptureStep = z.infer<typeof CaptureStep>;

export const CaptureManifest = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  flowId: z.string(),
  useCaseId: z.string(),
  title: LocalizedText,
  /** L2 = real build, real render, seeded data. See requirements §7. */
  fidelity: z.literal("L2"),
  viewport: Viewport,
  baseUrl: z.string(),
  steps: z.array(CaptureStep),
  assetsManifest: z.string().nullable(),
  createdAt: z.string(),
});
export type CaptureManifest = z.infer<typeof CaptureManifest>;

/* ------------------------------------------------------------------ *
 * Demo player payload
 * ------------------------------------------------------------------ */

export const DemoStep = z.object({
  index: z.number().int(),
  caption: Caption.nullable(),
  hotspot: Box.nullable(),
  screenshot: z.string(),
  dom: z.string().nullable(),
});

export const DemoManifest = z.object({
  schemaVersion: z.literal(1),
  title: LocalizedText,
  fidelity: z.literal("L2"),
  seededData: z.boolean(),
  cta: z.object({ label: z.string(), url: z.string() }).nullable(),
  steps: z.array(DemoStep),
});
export type DemoManifest = z.infer<typeof DemoManifest>;

/* ------------------------------------------------------------------ *
 * Cost accounting — every run records what it consumed (COST-1)
 * ------------------------------------------------------------------ */

export const LlmUsage = z.object({
  model: z.string(),
  purpose: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

export const RunCost = z.object({
  llm: z.array(LlmUsage),
  llmUsd: z.number().nonnegative(),
  stageSeconds: z.record(z.string(), z.number()),
  totalSeconds: z.number().nonnegative(),
});
export type RunCost = z.infer<typeof RunCost>;

/* ------------------------------------------------------------------ *
 * Diff report — regeneration output
 * ------------------------------------------------------------------ */

export const DiffStep = z.object({
  index: z.number().int(),
  caption: Caption.nullable(),
  diffRatio: z.number(),
  changed: z.boolean(),
  status: z.enum(["ok", "broken", "added", "removed"]),
});

export const DiffReport = z.object({
  schemaVersion: z.literal(1),
  baseRunId: z.string(),
  runId: z.string(),
  steps: z.array(DiffStep),
  changedCount: z.number().int(),
  brokenCount: z.number().int(),
  summary: z.string(),
});
export type DiffReport = z.infer<typeof DiffReport>;

/* ------------------------------------------------------------------ *
 * Stage identifiers
 * ------------------------------------------------------------------ */

export const STAGES = [
  "ingest",
  "detect",
  "build",
  "seed",
  "understand",
  "flowgen",
  "capture",
  "compose",
  "emit",
  "diff",
] as const;
export type Stage = (typeof STAGES)[number];
