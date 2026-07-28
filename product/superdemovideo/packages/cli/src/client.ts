import { loadConfig } from "@sdv/core";

export interface ApiClient {
  baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  events(path: string, onEvent: (e: unknown) => void, signal?: AbortSignal): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The CLI is a client of the API, not a second implementation of it.
 *
 * Anything `sdv` can do, the web UI can do, because both go through the same
 * endpoints. The alternative — a CLI that opens the database directly — grows
 * a second set of rules about run state within a week.
 */
export function apiClient(overrides: { baseUrl?: string; token?: string } = {}): ApiClient {
  const cfg = loadConfig();
  const baseUrl = (
    overrides.baseUrl ??
    process.env["SDV_API_URL"] ??
    `http://127.0.0.1:${cfg.port}`
  ).replace(/\/$/, "");
  const token = overrides.token ?? cfg.token;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Could not reach the API at ${baseUrl}. Start it with \`pnpm api\`. (${String(err)})`,
      );
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const detail =
        (parsed as { error?: string } | null)?.error ?? text.slice(0, 200) ?? res.statusText;
      throw new ApiError(res.status, parsed, `${method} ${path} → ${res.status}: ${detail}`);
    }
    return parsed as T;
  }

  return {
    baseUrl,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    patch: (path, body) => request("PATCH", path, body ?? {}),

    async events(path, onEvent, signal) {
      const res = await fetch(`${baseUrl}${path}`, { headers: headers(), signal });
      if (!res.ok || !res.body) throw new Error(`could not open the event stream: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; anything after the last
        // one is a partial frame and waits for the next chunk.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          onEvent(safeJson(line.slice(5).trim()));
        }
      }
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
