/**
 * Point a recorded browser session at wherever the app is actually listening.
 *
 * Storage state is keyed by origin, and the origin it was recorded against is
 * almost never the one this run started on — a preview server picks a free
 * port, a regeneration lands on a different one. Without this the session is
 * silently ignored, the app redirects to its login page, and the demo films
 * an empty shell. Applied at the point of use rather than at the point of
 * capture, so every caller gets it.
 */
export function retargetSession(state: unknown, baseUrl: string): unknown {
  if (!state || typeof state !== "object") return state;
  const url = new URL(baseUrl);
  const clone = JSON.parse(JSON.stringify(state)) as {
    origins?: Array<{ origin: string }>;
    cookies?: Array<Record<string, unknown>>;
  };

  if (Array.isArray(clone.origins)) {
    for (const o of clone.origins) o.origin = url.origin;
  }
  if (Array.isArray(clone.cookies)) {
    for (const c of clone.cookies) {
      if (typeof c["domain"] === "string") c["domain"] = url.hostname;
      // A cookie marked Secure is dropped on a plain-http preview server.
      if (url.protocol === "http:" && c["secure"] === true) c["secure"] = false;
    }
  }
  return clone;
}
