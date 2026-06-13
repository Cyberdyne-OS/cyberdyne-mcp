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
import { readSavedWalletKey } from "./client.js";

export const BANKR_API_URL = "https://api.bankr.bot";

/**
 * Resolve the agent's Bankr `bk_` key, most-explicit first:
 *   CYBERDYNE_BANKR_KEY → BANKR_API_KEY (Bankr's own standard env var) →
 *   any bk_-prefixed value in ~/.bankr/config.json (the file Bankr's CLI/SDK use).
 * Returns undefined when Bankr isn't configured (callers then skip Bankr cleanly).
 */
export function resolveBankrKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.CYBERDYNE_BANKR_KEY?.trim() || env.BANKR_API_KEY?.trim();
  if (fromEnv?.startsWith("bk_")) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".bankr", "config.json"), "utf8")) as Record<string, unknown>;
    for (const v of Object.values(cfg)) {
      if (typeof v === "string" && v.startsWith("bk_")) return v.trim();
    }
  } catch {
    /* no ~/.bankr/config.json — Bankr just isn't configured here */
  }
  return undefined;
}

/** Thrown when a Bankr call is attempted without a discoverable bk_ key. */
export class MissingBankrKeyError extends Error {
  constructor() {
    super(
      "no Bankr key — set CYBERDYNE_BANKR_KEY or BANKR_API_KEY (a bk_… Agent API key from " +
        "https://bankr.bot, Agent API access enabled), or put it in ~/.bankr/config.json.",
    );
    this.name = "MissingBankrKeyError";
  }
}

/** A Bankr API error carrying the HTTP status + the API's message. */
export class BankrApiError extends Error {
  constructor(public readonly status: number, public readonly path: string, message: string) {
    super(`Bankr ${path} → ${status}: ${message}`);
    this.name = "BankrApiError";
  }
}

function authHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { "X-API-Key": key, accept: "application/json", "user-agent": "cyberdyne-mcp" };
  const partner = process.env.CYBERDYNE_BANKR_PARTNER_KEY?.trim();
  if (partner) h["X-Partner-Key"] = partner;
  return h;
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<T> {
  const key = opts.key ?? resolveBankrKey();
  if (!key) throw new MissingBankrKeyError();
  const res = await fetch(`${BANKR_API_URL}${path}`, {
    method,
    headers: {
      ...authHeaders(key),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(json?.message ?? json?.error ?? `http_${res.status}`);
    throw new BankrApiError(res.status, path, msg);
  }
  return json as T;
}

// ── wallet ──────────────────────────────────────────────────────────────────

export interface BankrWalletMe {
  /** The agent's canonical Bankr-managed (Privy) wallet address on EVM chains. */
  walletAddress?: string;
  evmAddress?: string;
  address?: string;
  [k: string]: unknown;
}

/** GET /wallet/me — the agent's Bankr identity, incl. its managed wallet address. */
export async function bankrWalletMe(key?: string): Promise<BankrWalletMe> {
  return call<BankrWalletMe>("GET", "/wallet/me", { key });
}

/** Resolve the canonical Bankr EVM wallet address (walletAddress | evmAddress | address). */
export async function bankrWalletAddress(key?: string): Promise<string> {
  const me = await bankrWalletMe(key);
  const addr = me.walletAddress || me.evmAddress || me.address;
  if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new BankrApiError(200, "/wallet/me", "no EVM wallet address in response");
  }
  return addr;
}

export interface BankrTransferResult {
  success?: boolean;
  txHash?: string;
  [k: string]: unknown;
}

/**
 * POST /wallet/transfer — send an ERC-20 (or native) from the Bankr-managed wallet.
 * `amount` is the HUMAN-readable token amount (the API resolves decimals), matching
 * the `bankr transfer --amount` CLI. Returns the broadcast tx hash.
 */
export async function bankrTransfer(
  params: { tokenAddress: string; recipientAddress: string; amount: string | number; isNativeToken?: boolean; chain?: string },
  key?: string,
): Promise<string> {
  const r = await call<BankrTransferResult>("POST", "/wallet/transfer", {
    key,
    body: {
      tokenAddress: params.tokenAddress,
      recipientAddress: params.recipientAddress,
      amount: String(params.amount),
      isNativeToken: params.isNativeToken ?? false,
      chain: params.chain ?? "base",
    },
  });
  if (!r.txHash) throw new BankrApiError(200, "/wallet/transfer", "no txHash in response");
  return r.txHash;
}

export interface BankrSignResult {
  signature?: string;
  signer?: string;
  signatureType?: string;
  [k: string]: unknown;
}

/**
 * POST /wallet/sign with signatureType "eth_signTypedData_v4" — custodial EIP-712.
 * `typedData` is the full { domain, types, primaryType, message } struct. Returns the
 * 0x signature. This is what lets the Bankr wallet sign CYBERDYNE's auth-capture
 * authorization without exporting a key (see src/bankr-signer.ts).
 */
export async function bankrSignTypedData(typedData: unknown, key?: string): Promise<`0x${string}`> {
  const r = await call<BankrSignResult>("POST", "/wallet/sign", {
    key,
    body: { signatureType: "eth_signTypedData_v4", typedData },
  });
  if (!r.signature?.startsWith("0x")) throw new BankrApiError(200, "/wallet/sign", "no signature in response");
  return r.signature as `0x${string}`;
}

/** POST /wallet/sign with signatureType "personal_sign". Returns the 0x signature. */
export async function bankrSignMessage(message: string, key?: string): Promise<`0x${string}`> {
  const r = await call<BankrSignResult>("POST", "/wallet/sign", {
    key,
    body: { signatureType: "personal_sign", message },
  });
  if (!r.signature?.startsWith("0x")) throw new BankrApiError(200, "/wallet/sign", "no signature in response");
  return r.signature as `0x${string}`;
}

// ── health / discovery ────────────────────────────────────────────────────────

/** GET /_health — cheap key/liveness probe. Returns true on a 2xx. */
export async function bankrHealth(key?: string): Promise<boolean> {
  try {
    await call<unknown>("GET", "/_health", { key });
    return true;
  } catch {
    return false;
  }
}

export interface BankrTokenSearchResult {
  address?: string;
  symbol?: string;
  decimals?: number;
  chainId?: number;
  [k: string]: unknown;
}

/** GET /tokens/search?query= — public symbol↔address resolver (the one /wallet/transfer uses). */
export async function bankrSearchTokens(query: string, chainId?: number): Promise<BankrTokenSearchResult[]> {
  const params = new URLSearchParams({ query });
  if (chainId) params.set("chainId", String(chainId));
  const res = await fetch(`${BANKR_API_URL}/tokens/search?${params}`, {
    headers: { accept: "application/json", "user-agent": "cyberdyne-mcp" },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { tokens?: BankrTokenSearchResult[] } | BankrTokenSearchResult[];
  if (!res.ok) throw new BankrApiError(res.status, "/tokens/search", "search failed");
  return Array.isArray(json) ? json : (json.tokens ?? []);
}

/** GET /wallet/portfolio — multi-chain balances/holdings (cheap treasury/earnings view). */
export async function bankrPortfolio(
  opts: { chains?: string[]; showLowValueTokens?: boolean } = {},
  key?: string,
): Promise<unknown> {
  const q = new URLSearchParams();
  if (opts.chains?.length) q.set("chains", opts.chains.join(","));
  if (opts.showLowValueTokens) q.set("showLowValueTokens", "true");
  const qs = q.toString();
  return call("GET", `/wallet/portfolio${qs ? `?${qs}` : ""}`, { key });
}

/**
 * POST /wallet/x402-pay — pay any x402-priced URL custodially from the Bankr wallet,
 * Bankr handling the 402 handshake server-side, capped by `maxPaymentUsd`. Useful for an
 * agent to call a paid discovery/quote endpoint (e.g. CYBERDYNE's x402 Cloud front door)
 * with one authenticated POST instead of a client-side wallet signature.
 */
export async function bankrX402Pay(
  params: { url: string; method?: string; body?: unknown; maxPaymentUsd?: number },
  key?: string,
): Promise<unknown> {
  return call("POST", "/wallet/x402-pay", {
    key,
    body: { url: params.url, method: params.method ?? "GET", body: params.body, maxPaymentUsd: params.maxPaymentUsd },
  });
}

// ── headless key self-provision (SIWE) ────────────────────────────────────────

export interface BankrSiweResult {
  apiKey: string;
  walletAddress: string;
  readOnly?: boolean;
}

/**
 * Headless `bankr login --siwe`: mint a `bk_` key by signing a SIWE message with the
 * agent's own wallet — zero-browser, no email OTP. Flow (verified against @bankr/cli):
 *   GET /cli/siwe/nonce → build the SIWE message → personal_sign → POST /cli/siwe/verify.
 * Mints with Wallet API enabled (so /wallet/* works); Agent API + Token-Launch API stay
 * OFF (Agent API is separately gated at bankr.bot/api; we never launch tokens). The
 * private key never leaves this process and is never logged. Defaults the signer to the
 * onboarded wallet (CYBERDYNE_EVM_PRIVATE_KEY / ~/.cyberdyne config).
 */
export async function bankrSiweProvision(
  opts: { privateKey?: string; partnerKey?: string; keyName?: string; walletApiEnabled?: boolean; allowedRecipients?: string } = {},
): Promise<BankrSiweResult> {
  const pk = (opts.privateKey ?? process.env.CYBERDYNE_EVM_PRIVATE_KEY?.trim() ?? readSavedWalletKey() ?? "").trim();
  if (!pk) {
    throw new Error("no signing wallet — pass a private key, set CYBERDYNE_EVM_PRIVATE_KEY, or run `cyberdyne-mcp onboard` first");
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  const host = new URL(BANKR_API_URL).host;

  const nonceRes = await fetch(`${BANKR_API_URL}/cli/siwe/nonce`, {
    headers: { accept: "application/json", "user-agent": "cyberdyne-mcp" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!nonceRes.ok) throw new BankrApiError(nonceRes.status, "/cli/siwe/nonce", "nonce request failed");
  // The nonce endpoint sets AWS load-balancer stickiness cookies (AWSALB…); the nonce is
  // instance-local, so /cli/siwe/verify MUST carry them to reach the same backend — without
  // this it intermittently fails "Nonce expired or already used" depending on LB routing.
  const cookie = (typeof nonceRes.headers.getSetCookie === "function" ? nonceRes.headers.getSetCookie() : [])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  const { nonce } = (await nonceRes.json()) as { nonce?: string };
  if (!nonce) throw new BankrApiError(200, "/cli/siwe/nonce", "no nonce in response");

  const message = [
    `${host} wants you to sign in with your Ethereum account:`,
    account.address,
    "",
    "Sign in to Bankr",
    "",
    `URI: ${BANKR_API_URL}/cli/siwe/verify`,
    "Version: 1",
    // Bankr's SIWE verifier expects "Chain ID: 1" — this is the LOGIN signature, not a
    // transaction; CYBERDYNE settles on Base (8453). Matches @bankr/cli's siwe flow.
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const signature = await account.signMessage({ message });

  const verifyRes = await fetch(`${BANKR_API_URL}/cli/siwe/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "cyberdyne-mcp",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      message,
      signature,
      partnerApiKey: opts.partnerKey ?? process.env.CYBERDYNE_BANKR_PARTNER_KEY?.trim(),
      keyName: opts.keyName ?? `cyberdyne-${new Date().toISOString().slice(0, 10)}`,
      readOnly: false,
      walletApiEnabled: opts.walletApiEnabled ?? true,
      agentApiEnabled: false,
      tokenLaunchApiEnabled: false,
      allowedRecipients: opts.allowedRecipients,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await verifyRes.json().catch(() => ({}))) as {
    apiKey?: string;
    walletAddress?: string;
    readOnly?: boolean;
    message?: string;
    error?: string;
  };
  if (!verifyRes.ok || !j.apiKey) {
    throw new BankrApiError(verifyRes.status, "/cli/siwe/verify", String(j.message ?? j.error ?? "verify failed"));
  }
  return { apiKey: j.apiKey, walletAddress: j.walletAddress ?? account.address, readOnly: j.readOnly };
}
