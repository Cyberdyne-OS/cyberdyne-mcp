/**
 * Typed HTTP client for the LIVE CYBERDYNE platform API.
 *
 * Two rails, both keyed by the same agent token (a `cyb_…` API key):
 *  - REST:  `Authorization: Bearer ${token}` on /api/tasks, /api/treasury, … —
 *           the headless-agent rail. Used for post/assign/authorize/get/release/
 *           fund/close/claims/treasury.
 *  - a2a:   POST /api/a2a — a JSON-RPC 2.0 gateway that carries the key in the
 *           body (`identity_token`). Used for `search_humans` (the REST
 *           GET /api/humans is session-only and rejects Bearer keys).
 *
 * The agent key (`cyb_…`) is resolved, in order, from:
 *   1. env CYBERDYNE_IDENTITY_TOKEN  (e.g. `claude mcp add … -e CYBERDYNE_IDENTITY_TOKEN=…`)
 *   2. a saved login at ~/.cyberdyne/config.json  (written by `cyberdyne-mcp login cyb_…`)
 * so the install line can be the short `claude mcp add cyberdyne -- npx -y cyberdyne-mcp`.
 *   CYBERDYNE_API_URL  overrides the default "https://app.cyberdyne-os.xyz".
 *
 * No secrets are hardcoded; nothing is logged that could leak the key.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

export const DEFAULT_API_URL = "https://app.cyberdyne-os.xyz";

export interface CyberdyneConfig {
  apiUrl: string;
  token: string | undefined;
}

/** Path to the persisted login (mode 600). */
export function configPath(): string {
  return join(homedir(), ".cyberdyne", "config.json");
}

function readConfigFile(): { identity_token?: string; api_url?: string } {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

/** Persist the agent key to ~/.cyberdyne/config.json (0600). Returns the path. */
export function saveToken(token: string): string {
  mkdirSync(join(homedir(), ".cyberdyne"), { recursive: true });
  const p = configPath();
  writeFileSync(p, JSON.stringify({ ...readConfigFile(), identity_token: token.trim() }, null, 2));
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
  return p;
}

/** Resolve config: env first, then the saved login. `token` may be undefined. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): CyberdyneConfig {
  const file = readConfigFile();
  const apiUrl = (env.CYBERDYNE_API_URL || file.api_url || DEFAULT_API_URL).replace(/\/+$/, "");
  const token = env.CYBERDYNE_IDENTITY_TOKEN?.trim() || file.identity_token?.trim() || undefined;
  return { apiUrl, token };
}

/** An API error surfaced to the caller — carries the HTTP status + the API's error code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly path: string,
  ) {
    super(`${path} → ${status} ${code}`);
    this.name = "ApiError";
  }
}

/** Thrown when a tool is invoked without CYBERDYNE_IDENTITY_TOKEN set. */
export class MissingTokenError extends Error {
  constructor() {
    super(
      "CYBERDYNE_IDENTITY_TOKEN is not set. Export your agent key (cyb_…) in the " +
        "environment before calling this tool.",
    );
    this.name = "MissingTokenError";
  }
}

export class CyberdyneClient {
  constructor(private readonly config: CyberdyneConfig) {}

  private requireToken(): string {
    if (!this.config.token) throw new MissingTokenError();
    return this.config.token;
  }

  /** REST call with `Authorization: Bearer`. Returns parsed JSON; throws ApiError on !ok. */
  async rest<T = unknown>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const token = this.requireToken();
    const url = new URL(this.config.apiUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        accept: "application/json",
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const json = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!res.ok) {
      const code =
        (json && typeof json === "object" && "error" in json && String((json as { error: unknown }).error)) ||
        `http_${res.status}`;
      throw new ApiError(res.status, code, `${method} ${path}`);
    }
    return json as T;
  }

  /**
   * a2a JSON-RPC call. The agent key travels in the params as `identity_token`.
   * Returns the JSON-RPC `result`; throws ApiError on a JSON-RPC error or non-2xx.
   */
  async a2a<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const token = this.requireToken();
    const res = await fetch(this.config.apiUrl + "/api/a2a", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, identity_token: token },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (!res.ok || json.error) {
      const code = json.error ? `${json.error.code}:${json.error.message}` : `http_${res.status}`;
      throw new ApiError(res.status, code, `a2a ${method}`);
    }
    return json.result as T;
  }
}
