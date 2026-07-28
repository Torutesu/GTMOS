/**
 * SDV error taxonomy (architecture doc §7).
 *
 * Every stage failure is normalised into one of these before it reaches the
 * database or the UI. `userMessage` is what a human sees; `hint` is the
 * suggested next action. Raw logs always live separately.
 */

export const ERROR_CODES = [
  "SDV-E001", // repo too large / unfetchable
  "SDV-E010", // framework not detected
  "SDV-E011", // no end-to-end tests to derive a demo from
  "SDV-E020", // dependency install failed
  "SDV-E021", // build failed
  "SDV-E022", // start failed / port never opened
  "SDV-E030", // required env missing
  "SDV-E040", // seed failed / empty screen
  "SDV-E050", // selector resolution failed (capture)
  "SDV-E051", // selector resolution failed (regen)
  "SDV-E060", // render failed
  "SDV-E070", // secret detected in capture
  "SDV-E900", // unexpected internal error
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorSpec {
  title: string;
  hint: string;
}

const SPECS: Record<ErrorCode, ErrorSpec> = {
  "SDV-E001": {
    title: "Could not read the repository",
    hint: "Check the URL or path, and that the repository is under the 2GB limit.",
  },
  "SDV-E010": {
    title: "Could not work out how to build this project",
    hint: "Set the build command, start command and port manually.",
  },
  "SDV-E011": {
    title: "This repository has no end-to-end tests",
    hint: "Superdemovideo builds demos from Playwright or Cypress specs. Add one spec for the journey you want shown, then run again.",
  },
  "SDV-E020": {
    title: "Installing dependencies failed",
    hint: "Check the package manager and Node version in the detected profile.",
  },
  "SDV-E021": { title: "The build failed", hint: "See the build log for the first error." },
  "SDV-E022": {
    title: "The app did not start",
    hint: "Check the start command and the port it listens on.",
  },
  "SDV-E030": {
    title: "Required environment variables are missing",
    hint: "Add placeholder values for the listed keys. Never provide real secrets.",
  },
  "SDV-E040": {
    title: "The app rendered an empty screen",
    hint: "Pick a different seeding strategy so the demo has realistic data.",
  },
  "SDV-E050": {
    title: "A step could not find its target on the page",
    hint: "Edit that step to point at a stable element (a role, label or test id).",
  },
  "SDV-E051": {
    title: "A step broke after the UI changed",
    hint: "Review the diff and repair or drop the step.",
  },
  "SDV-E060": { title: "Rendering failed", hint: "This is on us — the run can be retried." },
  "SDV-E070": {
    title: "Possible secret found in the capture",
    hint: "Mask the affected element, then publish again.",
  },
  "SDV-E900": { title: "Something went wrong", hint: "Retry the stage; the log has details." },
};

export class SdvError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly cause?: unknown;

  constructor(code: ErrorCode, detail?: string, cause?: unknown) {
    super(`${code}: ${SPECS[code].title}${detail ? ` — ${detail}` : ""}`);
    this.name = "SdvError";
    this.code = code;
    this.detail = detail;
    this.cause = cause;
  }

  get title(): string {
    return SPECS[this.code].title;
  }

  get hint(): string {
    return SPECS[this.code].hint;
  }

  toJSON() {
    return { code: this.code, title: this.title, hint: this.hint, detail: this.detail ?? null };
  }
}

/** Normalise anything thrown into an SdvError, preserving an existing code. */
export function toSdvError(err: unknown, fallback: ErrorCode = "SDV-E900"): SdvError {
  if (err instanceof SdvError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new SdvError(fallback, detail, err);
}

export function errorSpec(code: ErrorCode): ErrorSpec {
  return SPECS[code];
}

/**
 * Codes worth trying again.
 *
 * A build that failed on a syntax error will fail identically on the second
 * attempt, and burning three attempts on it only delays the message the user
 * needs. Retries are reserved for failures that are plausibly about timing or
 * machine state — a port that was slow to open, a render that ran out of
 * memory — not about the repository being what it is.
 */
const RETRYABLE = new Set<ErrorCode>(["SDV-E001", "SDV-E022", "SDV-E060", "SDV-E900"]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}
