/**
 * Typed HTTP client for the LIVE CYBERDYNE platform API.
 *
 * One rail, keyed by the agent token (a `cyb_…` API key):
 *  - REST: `Authorization: Bearer ${token}` on /api/tasks, /api/submissions, … —
 *          the headless-agent rail (post/authorize/get/review/close).
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

export interface CyberdyneConfig {
  apiUrl: string;
  token: string | undefined;
}

/** Path to the persisted login (mode 600). */
export function configPath(): string {
  return join(homedir(), ".cyberdyne", "config.json");
}

/** Shape of the on-disk config. Both fields are optional for back-compat. */
interface SavedConfig {
  identity_token?: unknown;
  walletKey?: unknown;
}

/** Read + parse the whole config file (or {} if missing / unreadable). */
function readSavedConfig(): SavedConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as SavedConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Only the key is persisted (plus the generated wallet key). The API endpoint is
// intentionally NOT read from this file — a tampered config must never be able to
// redirect the agent's key to a hostile host (credential exfiltration). The
// endpoint overrides via env only.
function readSavedToken(): string | undefined {
  const v = readSavedConfig().identity_token;
  return typeof v === "string" ? v.trim() : undefined;
}

/** The generated/saved wallet private key (0x…), if any. Used as the EVM signer fallback. */
export function readSavedWalletKey(): string | undefined {
  const v = readSavedConfig().walletKey;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Atomically write the config file at ~/.cyberdyne/config.json, mode 0600.
 * Owner-only dir + atomic 0600 create (no world-readable window / TOCTOU), and
 * O_NOFOLLOW so a planted symlink at the path can't redirect the write.
 */
function writeConfigFile(data: SavedConfig): string {
  mkdirSync(join(homedir(), ".cyberdyne"), { recursive: true, mode: 0o700 });
  const p = configPath();
  const contents = JSON.stringify(data, null, 2);
  let flags = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC;
  if (typeof FS.O_NOFOLLOW === "number") flags |= FS.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(p, flags, 0o600);
  } catch {
    // Platforms without O_NOFOLLOW semantics — fall back without it.
    fd = openSync(p, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o600);
  }
  try {
    fchmodSync(fd, 0o600); // tighten perms on the open fd (covers a pre-existing file), race-free
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return p;
}

/** Persist the agent key to ~/.cyberdyne/config.json (preserving any saved walletKey). Returns the path. */
export function saveToken(token: string): string {
  const existing = readSavedConfig();
  const next: SavedConfig = { identity_token: token.trim() };
  if (typeof existing.walletKey === "string" && existing.walletKey.trim()) next.walletKey = existing.walletKey.trim();
  return writeConfigFile(next);
}

/** Persist the generated wallet private key (preserving any saved token). Returns the path. */
export function saveWallet(walletKey: string): string {
  const existing = readSavedConfig();
  const next: SavedConfig = { walletKey: walletKey.trim() };
  if (typeof existing.identity_token === "string" && existing.identity_token.trim())
    next.identity_token = existing.identity_token.trim();
  return writeConfigFile(next);
}

/** Persist BOTH the agent key and the wallet key in a single 0600 write. Returns the path. */
export function saveTokenAndWallet(token: string, walletKey: string): string {
  return writeConfigFile({ identity_token: token.trim(), walletKey: walletKey.trim() });
}

/**
 * Drop a CONFIRMED-DEAD saved identity_token from ~/.cyberdyne/config.json, preserving
 * the walletKey. Used when an authed probe proves the key is revoked server-side (401/
 * any non-2xx) — discarding it immediately means a later failed re-mint can never leave
 * the dead key behind to wedge the agent. Returns the config path.
 */
export function discardSavedToken(): string {
  const existing = readSavedConfig();
  const next: SavedConfig = {};
  if (typeof existing.walletKey === "string" && existing.walletKey.trim()) next.walletKey = existing.walletKey.trim();
  return writeConfigFile(next);
}

/**
 * Last resort (config save failed): write the live minted key to a FRESH 0600 recovery
 * file — never to stderr/logs and never into a thrown error (which would reach the LLM
 * via the MCP tool-result channel). Returns the path, or "" if even this fails.
 */
export function saveKeyRecovery(token: string): string {
  try {
    mkdirSync(join(homedir(), ".cyberdyne"), { recursive: true, mode: 0o700 });
    const p = join(homedir(), ".cyberdyne", `key-recovery-${Date.now()}.txt`);
    let flags = FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL;
    if (typeof FS.O_NOFOLLOW === "number") flags |= FS.O_NOFOLLOW;
    const fd = openSync(p, flags, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, token.trim() + "\n");
    } finally {
      closeSync(fd);
    }
    return p;
  } catch {
    return "";
  }
}

/** Resolve config: token from env first, then the saved login. URL from env only. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): CyberdyneConfig {
  const apiUrl = (env.CYBERDYNE_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const token = env.CYBERDYNE_IDENTITY_TOKEN?.trim() || readSavedToken() || undefined;
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
    // Re-read the token FRESH each call (env override → saved config file) so a key
    // minted/rotated mid-session (e.g. by the `onboard` tool, or a manual `login`) takes
    // effect WITHOUT restarting the MCP process. Falls back to the token captured at
    // construction if the live re-read is empty.
    const token = readConfig().token ?? this.config.token;
    if (!token) throw new MissingTokenError();
    return token;
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

}
