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
import { readFileSync, mkdirSync, openSync, writeSync, closeSync, fchmodSync, constants as FS } from "node:fs";
export const DEFAULT_API_URL = "https://app.cyberdyne-os.xyz";
/** Path to the persisted login (mode 600). */
export function configPath() {
    return join(homedir(), ".cyberdyne", "config.json");
}
// Only the key is persisted. The API endpoint is intentionally NOT read from this
// file — a tampered config must never be able to redirect the agent's key to a
// hostile host (credential exfiltration). The endpoint overrides via env only.
function readSavedToken() {
    try {
        const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
        return typeof parsed?.identity_token === "string" ? parsed.identity_token.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
/** Persist the agent key to ~/.cyberdyne/config.json. Returns the path. */
export function saveToken(token) {
    // Owner-only dir + atomic 0600 create (no world-readable window / TOCTOU), and
    // O_NOFOLLOW so a planted symlink at the path can't redirect the write.
    mkdirSync(join(homedir(), ".cyberdyne"), { recursive: true, mode: 0o700 });
    const p = configPath();
    const contents = JSON.stringify({ identity_token: token.trim() }, null, 2);
    let flags = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC;
    if (typeof FS.O_NOFOLLOW === "number")
        flags |= FS.O_NOFOLLOW;
    let fd;
    try {
        fd = openSync(p, flags, 0o600);
    }
    catch {
        // Platforms without O_NOFOLLOW semantics — fall back without it.
        fd = openSync(p, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o600);
    }
    try {
        fchmodSync(fd, 0o600); // tighten perms on the open fd (covers a pre-existing file), race-free
        writeSync(fd, contents);
    }
    finally {
        closeSync(fd);
    }
    return p;
}
/** Resolve config: token from env first, then the saved login. URL from env only. */
export function readConfig(env = process.env) {
    const apiUrl = (env.CYBERDYNE_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
    const token = env.CYBERDYNE_IDENTITY_TOKEN?.trim() || readSavedToken() || undefined;
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
