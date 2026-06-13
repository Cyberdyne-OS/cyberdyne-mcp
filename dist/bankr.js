/**
 * Thin, typed client for the LIVE Bankr Agent API (https://api.bankr.bot).
 *
 * This is how CYBERDYNE consumes the Bankr stack so an agent can act through its
 * Bankr-managed (Privy) custodial wallet WITHOUT exporting a private key:
 *   - GET  /wallet/me                  → the agent's canonical Bankr wallet address
 *   - POST /wallet/transfer            → send an ERC-20 (e.g. the deploy fee) → txHash
 *   - POST /wallet/sign                → custodial EIP-712 / personal_sign → signature
 *   - GET  /_health                    → API-key liveness
 *   - GET  /tokens/search?query=       → resolve a symbol ↔ address (public)
 *
 * Endpoint shapes verified against the published `@bankr/cli` (0.3.1) source. Auth is
 * the `bk_…` Agent API key in the `X-API-Key` header (Bankr Club / Agent API access
 * required — a key without it returns 401 on /wallet/*). NOTHING here is x402-specific:
 * CYBERDYNE's own auth-capture signing stays in src/evm-signer.ts (@x402/evm) — this
 * module only forwards a typed-data struct to Bankr's signer and returns the signature.
 *
 * The bk_ key is read fresh from the env / ~/.bankr each call and is NEVER persisted by
 * CYBERDYNE and NEVER logged.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const BANKR_API_URL = "https://api.bankr.bot";
/**
 * Resolve the agent's Bankr `bk_` key, most-explicit first:
 *   CYBERDYNE_BANKR_KEY → BANKR_API_KEY (Bankr's own standard env var) →
 *   any bk_-prefixed value in ~/.bankr/config.json (the file Bankr's CLI/SDK use).
 * Returns undefined when Bankr isn't configured (callers then skip Bankr cleanly).
 */
export function resolveBankrKey(env = process.env) {
    const fromEnv = env.CYBERDYNE_BANKR_KEY?.trim() || env.BANKR_API_KEY?.trim();
    if (fromEnv?.startsWith("bk_"))
        return fromEnv;
    try {
        const cfg = JSON.parse(readFileSync(join(homedir(), ".bankr", "config.json"), "utf8"));
        for (const v of Object.values(cfg)) {
            if (typeof v === "string" && v.startsWith("bk_"))
                return v.trim();
        }
    }
    catch {
        /* no ~/.bankr/config.json — Bankr just isn't configured here */
    }
    return undefined;
}
/** Thrown when a Bankr call is attempted without a discoverable bk_ key. */
export class MissingBankrKeyError extends Error {
    constructor() {
        super("no Bankr key — set CYBERDYNE_BANKR_KEY or BANKR_API_KEY (a bk_… Agent API key from " +
            "https://bankr.bot, Agent API access enabled), or put it in ~/.bankr/config.json.");
        this.name = "MissingBankrKeyError";
    }
}
/** A Bankr API error carrying the HTTP status + the API's message. */
export class BankrApiError extends Error {
    status;
    path;
    constructor(status, path, message) {
        super(`Bankr ${path} → ${status}: ${message}`);
        this.status = status;
        this.path = path;
        this.name = "BankrApiError";
    }
}
function authHeaders(key) {
    const h = { "X-API-Key": key, accept: "application/json", "user-agent": "cyberdyne-mcp" };
    const partner = process.env.CYBERDYNE_BANKR_PARTNER_KEY?.trim();
    if (partner)
        h["X-Partner-Key"] = partner;
    return h;
}
async function call(method, path, opts = {}) {
    const key = opts.key ?? resolveBankrKey();
    if (!key)
        throw new MissingBankrKeyError();
    const res = await fetch(`${BANKR_API_URL}${path}`, {
        method,
        headers: {
            ...authHeaders(key),
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({})));
    if (!res.ok) {
        const msg = String(json?.message ?? json?.error ?? `http_${res.status}`);
        throw new BankrApiError(res.status, path, msg);
    }
    return json;
}
/** GET /wallet/me — the agent's Bankr identity, incl. its managed wallet address. */
export async function bankrWalletMe(key) {
    return call("GET", "/wallet/me", { key });
}
/** Resolve the canonical Bankr EVM wallet address (walletAddress | evmAddress | address). */
export async function bankrWalletAddress(key) {
    const me = await bankrWalletMe(key);
    const addr = me.walletAddress || me.evmAddress || me.address;
    if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        throw new BankrApiError(200, "/wallet/me", "no EVM wallet address in response");
    }
    return addr;
}
/**
 * POST /wallet/transfer — send an ERC-20 (or native) from the Bankr-managed wallet.
 * `amount` is the HUMAN-readable token amount (the API resolves decimals), matching
 * the `bankr transfer --amount` CLI. Returns the broadcast tx hash.
 */
export async function bankrTransfer(params, key) {
    const r = await call("POST", "/wallet/transfer", {
        key,
        body: {
            tokenAddress: params.tokenAddress,
            recipientAddress: params.recipientAddress,
            amount: String(params.amount),
            isNativeToken: params.isNativeToken ?? false,
            chain: params.chain ?? "base",
        },
    });
    if (!r.txHash)
        throw new BankrApiError(200, "/wallet/transfer", "no txHash in response");
    return r.txHash;
}
/**
 * POST /wallet/sign with signatureType "eth_signTypedData_v4" — custodial EIP-712.
 * `typedData` is the full { domain, types, primaryType, message } struct. Returns the
 * 0x signature. This is what lets the Bankr wallet sign CYBERDYNE's auth-capture
 * authorization without exporting a key (see src/bankr-signer.ts).
 */
export async function bankrSignTypedData(typedData, key) {
    const r = await call("POST", "/wallet/sign", {
        key,
        body: { signatureType: "eth_signTypedData_v4", typedData },
    });
    if (!r.signature?.startsWith("0x"))
        throw new BankrApiError(200, "/wallet/sign", "no signature in response");
    return r.signature;
}
/** POST /wallet/sign with signatureType "personal_sign". Returns the 0x signature. */
export async function bankrSignMessage(message, key) {
    const r = await call("POST", "/wallet/sign", {
        key,
        body: { signatureType: "personal_sign", message },
    });
    if (!r.signature?.startsWith("0x"))
        throw new BankrApiError(200, "/wallet/sign", "no signature in response");
    return r.signature;
}
// ── health / discovery ────────────────────────────────────────────────────────
/** GET /_health — cheap key/liveness probe. Returns true on a 2xx. */
export async function bankrHealth(key) {
    try {
        await call("GET", "/_health", { key });
        return true;
    }
    catch {
        return false;
    }
}
/** GET /tokens/search?query= — public symbol↔address resolver (the one /wallet/transfer uses). */
export async function bankrSearchTokens(query, chainId) {
    const params = new URLSearchParams({ query });
    if (chainId)
        params.set("chainId", String(chainId));
    const res = await fetch(`${BANKR_API_URL}/tokens/search?${params}`, {
        headers: { accept: "application/json", "user-agent": "cyberdyne-mcp" },
        signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({})));
    if (!res.ok)
        throw new BankrApiError(res.status, "/tokens/search", "search failed");
    return Array.isArray(json) ? json : (json.tokens ?? []);
}
