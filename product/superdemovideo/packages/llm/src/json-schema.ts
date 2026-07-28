/**
 * JSON Schemas handed to the API's structured-output mode.
 *
 * These are written by hand rather than derived from the zod types: the API
 * accepts a narrow schema dialect, and a generated one drifts into features it
 * rejects. The zod types remain the authority — every response is parsed
 * against them after the call returns.
 */

const LOCALIZED = {
  type: "object",
  properties: { en: { type: "string" }, ja: { type: "string" } },
  required: ["en", "ja"],
  additionalProperties: false,
} as const;

const TARGET = {
  type: "object",
  description: "How to find the element. Prefer role, then label, then testId. Use css last.",
  properties: {
    role: {
      type: "object",
      properties: { role: { type: "string" }, name: { type: "string" } },
      required: ["role", "name"],
      additionalProperties: false,
    },
    label: { type: "string" },
    text: { type: "string" },
    testId: { type: "string" },
    css: { type: "string" },
  },
  additionalProperties: false,
} as const;

export const STEP_SCHEMA = {
  type: "object",
  properties: {
    do: {
      type: "string",
      enum: ["goto", "click", "fill", "select", "press", "hover", "expect", "wait"],
    },
    path: { type: "string", description: "Relative path starting with /. Only for goto." },
    target: TARGET,
    value: { type: "string" },
    key: { type: "string" },
    ms: { type: "integer" },
    caption: LOCALIZED,
  },
  required: ["do"],
  additionalProperties: false,
} as const;

export const FLOW_SCHEMA = {
  type: "object",
  properties: {
    title: LOCALIZED,
    steps: { type: "array", items: STEP_SCHEMA, minItems: 2, maxItems: 30 },
  },
  required: ["title", "steps"],
  additionalProperties: false,
} as const;

export const USE_CASE_LIST_SCHEMA = {
  type: "object",
  properties: {
    useCases: {
      type: "array",
      minItems: 3,
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          title: LOCALIZED,
          hypothesis: {
            ...LOCALIZED,
            description: "One sentence on why a visitor would care about this journey.",
          },
          entryRoute: { type: "string" },
          outline: { type: "array", items: { type: "string" }, minItems: 1 },
          signals: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: [
                "e2e-test",
                "route",
                "analytics-event",
                "readme",
                "changelog",
                "feature-flag",
                "screen",
              ],
            },
          },
          origin: { type: ["string", "null"] },
        },
        required: ["title", "hypothesis", "entryRoute", "outline", "signals", "origin"],
        additionalProperties: false,
      },
    },
  },
  required: ["useCases"],
  additionalProperties: false,
} as const;

export const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    title: LOCALIZED,
    intro: LOCALIZED,
    outro: LOCALIZED,
    captions: { type: "array", items: LOCALIZED },
  },
  required: ["title", "intro", "outro", "captions"],
  additionalProperties: false,
} as const;

/**
 * A native app's screens, rendered as HTML.
 *
 * `html` is a whole document rather than a fragment: the capture opens it as
 * a page, and a fragment would have no styling, no title and no viewport.
 */
export const NATIVE_SCREENS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["screens"],
  properties: {
    screens: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "title", "source", "html"],
        properties: {
          path: { type: "string", description: 'Route, starting with "/". The first screen is "/".' },
          title: { type: "string" },
          source: { type: "string", description: "The file this screen was declared in." },
          html: { type: "string", description: "A complete HTML document for this screen." },
        },
      },
    },
  },
} as const;
