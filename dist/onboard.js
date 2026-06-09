/**
 * FULLY AUTONOMOUS, zero-browser agent onboarding for CYBERDYNE.
 *
 * Goal: an agent goes from "nothing" to "has a wallet + cyb_ API key + can
 * post/pay" using ONLY the CLI/MCP — never the web dashboard. This mirrors the
 * Bankr CLI UX (`bankr login` generates a wallet + API key in one shot).
 *
 * The chain (all on the live platform API, no browser):
 *   1. resolve a wallet  — CYBERDYNE_EVM_PRIVATE_KEY → saved walletKey → generate fresh
 *   2. GET  /api/auth/siwe/nonce            → { nonce } (+ sets a siwe-nonce cookie)
 *   3. build the EXACT SIWE message and sign it with the wallet (EIP-191)
 *   4. POST /api/auth/siwe/verify { message, signature, role:"agent" } → session cookie
 *   5. POST /api/agent/key (session cookie) {} → { apiKey: "cyb_…" }
 *   6. persist BOTH the cyb_ key and the wallet key to ~/.cyberdyne/config.json (0600)
 *
 * Nothing here moves funds or pays gas — onboarding is just a SIWE signature and
 * a DB row. The wallet private key is persisted but NEVER logged to stdout.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { bytesToHex } from "viem";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readConfig, readSavedWalletKey, saveTokenAndWallet } from "./client.js";
/** Normalise a private key to the 0x-prefixed form viem expects. */
function normalizeKey(pk) {
    return (pk.startsWith("0x") ? pk : `0x${pk}`);
}
/** A 0x-prefixed (or bare) 32-byte hex private key. */
function isHexPrivateKey(s) {
    return /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
}
/** Word-count-shaped (12/15/18/21/24 alpha words) — full BIP-39 checksum is validated on use. */
function looksLikeMnemonic(s) {
    const words = s.trim().split(/\s+/);
    return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-zA-Z]+$/.test(w));
}
/**
 * Resolve a user-provided wallet secret (hex private key OR BIP-39 mnemonic) into
 * the raw 0x private key. For a mnemonic we VALIDATE the BIP-39 checksum (scure) and
 * derive account index 0 (m/44'/60'/0'/0/0). Throws a clear error if the secret is
 * neither a valid key nor a checksum-valid mnemonic.
 */
export function privateKeyFromSecret(secret) {
    const s = secret.trim();
    if (isHexPrivateKey(s))
        return normalizeKey(s);
    if (looksLikeMnemonic(s)) {
        const phrase = s.split(/\s+/).join(" ").toLowerCase();
        if (!validateMnemonic(phrase, wordlist)) {
            throw new Error("invalid BIP-39 mnemonic — the words or checksum don't validate. Check the phrase and try again.");
        }
        const pk = mnemonicToAccount(phrase, { addressIndex: 0 }).getHdKey().privateKey;
        if (!pk)
            throw new Error("could not derive a private key from that mnemonic");
        return bytesToHex(pk);
    }
    throw new Error("malformed wallet secret — expected a 0x-prefixed 64-hex-char private key, or a valid BIP-39 mnemonic (12–24 words).");
}
/**
 * Resolve the onboarding wallet, most-explicit first:
 *   0. an explicitly IMPORTED secret (key/mnemonic) from the CLI/env/stdin/prompt
 *   1. CYBERDYNE_EVM_PRIVATE_KEY (env)   — operator-supplied
 *   2. saved walletKey in config         — generated on a prior onboard
 *   3. CREATE a fresh key                — first run, zero config
 * Always returns a usable account + the private key. Persisting a freshly
 * generated/imported key is the caller's job (onboard() does it atomically with the token).
 *
 * `opts.importSecret` (hex key or mnemonic) forces import; `opts.forceCreate` forces a
 * brand-new wallet even if env/config already has one (used by `onboard --create`).
 */
export function resolveWallet(env = process.env, opts = {}) {
    if (opts.importSecret) {
        const privateKey = privateKeyFromSecret(opts.importSecret);
        return { account: privateKeyToAccount(privateKey), privateKey, generated: false, imported: true };
    }
    if (opts.forceCreate) {
        const privateKey = generatePrivateKey();
        return { account: privateKeyToAccount(privateKey), privateKey, generated: true, imported: false };
    }
    const fromEnv = env.CYBERDYNE_EVM_PRIVATE_KEY?.trim();
    if (fromEnv) {
        const privateKey = normalizeKey(fromEnv);
        return { account: privateKeyToAccount(privateKey), privateKey, generated: false, imported: false };
    }
    const saved = readSavedWalletKey();
    if (saved) {
        const privateKey = normalizeKey(saved);
        return { account: privateKeyToAccount(privateKey), privateKey, generated: false, imported: false };
    }
    const privateKey = generatePrivateKey();
    return { account: privateKeyToAccount(privateKey), privateKey, generated: true, imported: false };
}
/** Pull every Set-Cookie off a response into a `name=value; name=value` Cookie header. */
function collectCookies(res, jar) {
    // getSetCookie() returns each Set-Cookie line separately (undici/Node 18.18+).
    const lines = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    for (const line of lines) {
        const pair = line.split(";")[0]?.trim();
        if (!pair)
            continue;
        const eq = pair.indexOf("=");
        if (eq <= 0)
            continue;
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
}
function cookieHeader(jar) {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
/**
 * Auto-discover the agent's Bankr `bk_` key WITHOUT requiring a flag — so a plain
 * `npx cyberdyne-mcp onboard` links Bankr whenever the agent already has Bankr set up.
 * Order: CYBERDYNE_BANKR_KEY → BANKR_API_KEY (Bankr's own standard env var) →
 * ~/.bankr/config.json (any `bk_`-prefixed value — the same config file Bankr's CLI/SDK use).
 * Returns undefined if nothing is configured (then onboard just skips Bankr linking).
 */
function discoverBankrKey(env) {
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
        /* no ~/.bankr/config.json — fine, Bankr just isn't configured */
    }
    return undefined;
}
/**
 * Run the full SIWE → mint chain and persist the credentials. Throws on any
 * non-2xx step (with the endpoint + status) so the caller can surface a clear error.
 * Pass `opts.importSecret` to bring your own wallet, or `opts.forceCreate` for a fresh one.
 */
export async function onboard(env = process.env, opts = {}) {
    const { apiUrl } = readConfig(env);
    const HOST = new URL(apiUrl).host;
    const { account, privateKey, generated, imported } = resolveWallet(env, opts);
    const address = account.address;
    const jar = new Map();
    // 1. nonce
    const nonceRes = await fetch(`${apiUrl}/api/auth/siwe/nonce`, { headers: { accept: "application/json" } });
    if (!nonceRes.ok)
        throw new Error(`GET /api/auth/siwe/nonce → ${nonceRes.status}`);
    collectCookies(nonceRes, jar); // carry siwe-nonce to verify
    const { nonce } = (await nonceRes.json());
    if (!nonce)
        throw new Error("GET /api/auth/siwe/nonce → no nonce in response");
    // 2. build the EXACT SIWE message (newline-joined) and sign it
    const message = [
        `${HOST} wants you to sign in with your Ethereum account:`,
        address,
        "",
        "Sign in to CYBERDYNE — get paid by AI. This request will not trigger a blockchain transaction or cost any gas.",
        "",
        `URI: ${apiUrl}`,
        "Version: 1",
        "Chain ID: 8453",
        `Nonce: ${nonce}`,
        `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const signature = await account.signMessage({ message });
    // 3. verify → session cookie
    const verifyRes = await fetch(`${apiUrl}/api/auth/siwe/verify`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(jar.size ? { cookie: cookieHeader(jar) } : {}),
        },
        body: JSON.stringify({ message, signature, role: "agent" }),
    });
    if (!verifyRes.ok) {
        const detail = await verifyRes.text().catch(() => "");
        throw new Error(`POST /api/auth/siwe/verify → ${verifyRes.status} ${detail.slice(0, 200)}`);
    }
    collectCookies(verifyRes, jar); // capture the session cookie(s)
    // 4. mint the agent key with the session cookie
    const keyRes = await fetch(`${apiUrl}/api/agent/key`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json",
            cookie: cookieHeader(jar),
        },
        body: "{}",
    });
    if (!keyRes.ok) {
        const detail = await keyRes.text().catch(() => "");
        throw new Error(`POST /api/agent/key → ${keyRes.status} ${detail.slice(0, 200)}`);
    }
    const keyJson = (await keyRes.json());
    const apiKey = keyJson.apiKey?.trim();
    if (!apiKey || !apiKey.startsWith("cyb_")) {
        throw new Error("POST /api/agent/key → no cyb_ apiKey in response");
    }
    // 5. persist BOTH the token and the wallet key atomically (0600)
    const configPath = saveTokenAndWallet(apiKey, privateKey);
    // 6. (optional) auto-link Bankr — zero human interaction. If a bk_ key is supplied
    //    (opts or CYBERDYNE_BANKR_KEY), use it ONCE to connect the agent's Bankr project
    //    via the fresh cyb_ key. Best-effort: a failure never blocks onboarding, and the
    //    bk_ key is never stored (the backend uses it once and discards it).
    let bankr;
    const bankrKey = (opts.bankrKey?.trim() || discoverBankrKey(env) || "");
    if (bankrKey.startsWith("bk_")) {
        try {
            const res = await fetch(`${apiUrl}/api/bankr/connect`, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ bk_key: bankrKey }),
            });
            const j = (await res.json().catch(() => null));
            bankr = res.ok && j?.ok
                ? { connected: true, project: j.project?.projectName ?? null, hint: j.hint }
                : { connected: false, hint: j?.hint ?? `connect failed (${res.status})` };
        }
        catch (e) {
            bankr = { connected: false, hint: e instanceof Error ? e.message : "bankr connect error" };
        }
    }
    return { address, apiKey, generated, imported, configPath, bankr };
}
/** The multi-line "next steps" block shared by the CLI + the MCP tool. */
export function nextStepsText() {
    return [
        "Next steps (no dashboard needed):",
        "  1. Fund THIS wallet with USDC (or BNKR/GITLAWB) + a little ETH for gas on Base — the non-custodial pool freezes the budget directly from your wallet (there is no platform treasury).",
        "  2. post_task({ title, category, reward_usd, quantity }) → returns the budget authorization + the deploy fee.",
        "  3. authorize_task (sign budget + pay deploy fee + freeze) → humans submit FCFS → poll get_task.",
        "  4. review_submission per pending submission (approve pays a unit; reject reopens it) → close_task refunds the rest.",
        "The same wallet auto-signs pool budgets. Trustless backstop: `reclaim` recovers an unfilled budget yourself after the deadline.",
    ].join("\n");
}
// ── CLI front-end for `onboard` (import / create / prompt) ───────────────────
// Resolves the wallet secret to import (if any), most-private first, then runs
// onboard(). Non-interactive-safe: with no flag/env in a non-TTY (CI), defaults to
// create — exactly the prior behaviour.
//   --import <secret>          import an explicit key/mnemonic (lands in shell history)
//   --import  (no value)       read the secret from stdin (piped) or CYBERDYNE_IMPORT_KEY
//   --create                   force a fresh wallet
//   (none, interactive TTY)    prompt: paste a key/mnemonic, or press enter to create
/** Tiny flag reader for the onboard args (`--import`, `--import=x`, `--create`, `--bankr`). */
function parseOnboardFlags(argv) {
    let importFlag = false;
    let importValue;
    let create = false;
    let bankrValue;
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (tok === "--create")
            create = true;
        else if (tok === "--import") {
            importFlag = true;
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                importValue = next;
                i++;
            }
        }
        else if (tok.startsWith("--import=")) {
            importFlag = true;
            importValue = tok.slice("--import=".length);
        }
        else if (tok === "--bankr") {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                bankrValue = next;
                i++;
            }
        }
        else if (tok.startsWith("--bankr=")) {
            bankrValue = tok.slice("--bankr=".length);
        }
    }
    return { importFlag, importValue, create, bankrValue };
}
/** Read a single line from stdin (used for the interactive import/create prompt). */
function promptLine(question) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
export const ONBOARD_USAGE = [
    "Usage: cyberdyne-mcp onboard [--import <0xPRIVATEKEY | mnemonic words> | --create]",
    "",
    "  --import <secret>   bring your OWN wallet — a 0x 64-hex private key or a BIP-39 mnemonic.",
    "                      Most private: omit the value and pipe it, or set CYBERDYNE_IMPORT_KEY:",
    "                        echo 0x<key> | npx cyberdyne-mcp onboard --import",
    "                        CYBERDYNE_IMPORT_KEY=0x<key> npx cyberdyne-mcp onboard --import",
    "                      (passing it as an argument leaves the secret in your shell history.)",
    "  --create            generate a fresh wallet (default in a non-interactive / CI shell).",
    "  --bankr <bk_key>    link your Bankr project at onboard. USUALLY UNNEEDED: onboard",
    "                      auto-discovers your key from BANKR_API_KEY / ~/.bankr/config.json,",
    "                      so a plain `onboard` links Bankr if you already use it. Used once,",
    "                      server-side, and never stored.",
    "  (no flag, in a terminal)  you'll be prompted: paste a key/mnemonic, or press enter to create.",
    "",
    "Either way: SIWE sign-in → mint your cyb_ key → save wallet + key to ~/.cyberdyne/config.json (0600).",
].join("\n");
/**
 * Resolve the onboard mode from argv/env/stdin/prompt and run onboard().
 * Precedence for an IMPORT secret (most private first):
 *   piped stdin (with --import) → CYBERDYNE_IMPORT_KEY → --import <value> argv → TTY prompt.
 */
export async function onboardCli(argv, env = process.env) {
    const { importFlag, importValue, create, bankrValue } = parseOnboardFlags(argv);
    // Bankr auto-link key: --bankr <bk_…> (or env CYBERDYNE_BANKR_KEY, read inside onboard()).
    const bankrKey = bankrValue?.trim() || undefined;
    if (create)
        return onboard(env, { forceCreate: true, bankrKey });
    // Determine the import secret, if the user asked to import.
    let secret;
    let fromArgv = false;
    if (importFlag) {
        // 1. piped stdin (echo … | onboard --import) — most private
        if (!process.stdin.isTTY) {
            try {
                const piped = readFileSync(0, "utf8").trim();
                if (piped)
                    secret = piped;
            }
            catch {
                /* nothing piped */
            }
        }
        // 2. env  3. argv value
        secret = secret || env.CYBERDYNE_IMPORT_KEY?.trim() || importValue?.trim() || undefined;
        if (importValue && secret === importValue.trim()) {
            fromArgv = true;
        }
        if (!secret) {
            throw new Error("--import needs a key/mnemonic. Pipe it (echo 0x<key> | npx cyberdyne-mcp onboard --import), " +
                "set CYBERDYNE_IMPORT_KEY, or pass it after --import.");
        }
    }
    else if (env.CYBERDYNE_IMPORT_KEY?.trim()) {
        // Env-only import (no flag) — convenient + private.
        secret = env.CYBERDYNE_IMPORT_KEY.trim();
    }
    else if (process.stdin.isTTY) {
        // 3. Interactive: ask. Empty → create; else → import the pasted secret.
        const answer = (await promptLine("Import an existing wallet (paste private key / mnemonic) or press enter to create a new one: ")).trim();
        if (answer)
            secret = answer;
    }
    // else: non-TTY, no flag, no env → default to create (unchanged CI behaviour).
    if (fromArgv) {
        console.error("⚠  Heads-up: passing the wallet secret as an argument leaves it in your shell history.\n" +
            "   Next time, pipe it instead:  echo 0x<key> | npx cyberdyne-mcp onboard --import");
    }
    if (secret) {
        // Validate early with a clear error before any network call.
        privateKeyFromSecret(secret);
        return onboard(env, { importSecret: secret, bankrKey });
    }
    return onboard(env, { bankrKey }); // create / reuse-saved, as before
}
