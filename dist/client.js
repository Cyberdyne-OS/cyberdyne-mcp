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
 * Config is read from the environment (stdio MCP servers take creds from env):
 *   CYBERDYNE_API_URL        default "https://app.cyberdyne-os.xyz"
 *   CYBERDYNE_IDENTITY_TOKEN the agent's `cyb_…` key (required for any network call)
 *
 * No secrets are hardcoded; nothing is logged that could leak the key.
 */
export const DEFAULT_API_URL = "https://app.cyberdyne-os.xyz";
/** Read config from the environment. `token` may be undefined (tools then error). */
export function readConfig(env = process.env) {
    const apiUrl = (env.CYBERDYNE_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
    const token = env.CYBERDYNE_IDENTITY_TOKEN?.trim() || undefined;
    return { apiUrl, token };
}
/** An API error surfaced to the caller — carries the HTTP status + the API's error code. */
export class ApiError extends Error {
    status;
    code;
    path;
    constructor(status, code, path) {
        super(`${path} → ${status} ${code}`);
        this.status = status;
        this.code = code;
        this.path = path;
        this.name = "ApiError";
    }
}
/** Thrown when a tool is invoked without CYBERDYNE_IDENTITY_TOKEN set. */
export class MissingTokenError extends Error {
    constructor() {
        super("CYBERDYNE_IDENTITY_TOKEN is not set. Export your agent key (cyb_…) in the " +
            "environment before calling this tool.");
        this.name = "MissingTokenError";
    }
}
export class CyberdyneClient {
    config;
    constructor(config) {
        this.config = config;
    }
    requireToken() {
        if (!this.config.token)
            throw new MissingTokenError();
        return this.config.token;
    }
    /** REST call with `Authorization: Bearer`. Returns parsed JSON; throws ApiError on !ok. */
    async rest(method, path, opts = {}) {
        const token = this.requireToken();
        const url = new URL(this.config.apiUrl + path);
        if (opts.query) {
            for (const [k, v] of Object.entries(opts.query)) {
                if (v !== undefined && v !== null && v !== "")
                    url.searchParams.set(k, String(v));
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
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const code = (json && typeof json === "object" && "error" in json && String(json.error)) ||
                `http_${res.status}`;
            throw new ApiError(res.status, code, `${method} ${path}`);
        }
        return json;
    }
    /**
     * a2a JSON-RPC call. The agent key travels in the params as `identity_token`.
     * Returns the JSON-RPC `result`; throws ApiError on a JSON-RPC error or non-2xx.
     */
    async a2a(method, params = {}) {
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
        const json = (await res.json().catch(() => ({})));
        if (!res.ok || json.error) {
            const code = json.error ? `${json.error.code}:${json.error.message}` : `http_${res.status}`;
            throw new ApiError(res.status, code, `a2a ${method}`);
        }
        return json.result;
    }
}
