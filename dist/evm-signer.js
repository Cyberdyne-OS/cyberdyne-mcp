/**
 * Agent-side EVM signing for the CYBERDYNE non-custodial escrow (x402 auth-capture).
 *
 * When a task is funded, the agent signs ONE auth-capture authorization for the
 * whole budget (EIP-3009). CYBERDYNE (operator) then `authorize`s it on-chain,
 * freezing the funds in the AUDITED escrow — the agent's funds, never ours.
 *
 * Two ways the agent can sign (the platform's `authorize` route accepts either):
 *  (a) MCP-held wallet — set CYBERDYNE_EVM_PRIVATE_KEY; this module signs via the
 *      x402 SDK (AuthCaptureEvmScheme, the exact path certified on Base mainnet).
 *  (b) external/Bankr signer — produce the base64 payload elsewhere and pass it in.
 *
 * Nothing here moves funds or pays gas; it only produces a signature.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, maxUint256, nonceManager, parseUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import { AuthCaptureEvmScheme, toClientEvmSigner } from "@x402/evm";
import { readSavedWalletKey } from "./client.js";
/**
 * Resolve the signing private key: CYBERDYNE_EVM_PRIVATE_KEY first, else the
 * walletKey generated at `onboard` and saved in ~/.cyberdyne/config.json. This is
 * what makes onboard → post pool task → authorize all work with the SAME wallet
 * and zero env vars.
 */
function resolvePrivateKey() {
    return process.env.CYBERDYNE_EVM_PRIVATE_KEY?.trim() || readSavedWalletKey();
}
function account() {
    const pk = resolvePrivateKey();
    if (!pk)
        throw new Error("no signing key (set CYBERDYNE_EVM_PRIVATE_KEY or run `cyberdyne-mcp onboard`)");
    // Attach viem's nonceManager so CONCURRENT on-chain sends (e.g. two authorize_task in
    // flight, each paying a deploy fee) get sequential nonces instead of both reading the
    // same `pending` nonce and silently dropping/replacing one another.
    return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`), { nonceManager });
}
function chain() {
    return Number(process.env.CYBERDYNE_CHAIN_ID ?? 8453) === 8453 ? base : baseSepolia;
}
const ERC20_TRANSFER_ABI = [
    {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
    },
];
/**
 * Pay the SEPARATE deploy fee (2.5%/5%, pure revenue) from the MCP-held wallet:
 * a plain ERC-20 transfer to the fee recipient. Returns the tx hash to pass to
 * authorize_task as `fee_tx_hash`. Only used on the POOL rail; the agent pays
 * this gas (CYBERDYNE absorbs none). USDC is 6-dp (v1 pool settles in USDC).
 */
export async function payDeployFee(params) {
    // Coerce + validate: over the MCP bridge numeric fields can arrive as STRINGS, and a
    // missing/undefined decimals would silently scale the fee to 0 (parseUnits(x, undefined))
    // → underpaid → permanent fee_unverified. A bad address would surface as an opaque viem
    // InvalidAddressError. Fail loudly with an actionable message instead.
    const amt = Number(params.amount);
    const dec = Number(params.decimals);
    if (!Number.isFinite(amt) || amt <= 0)
        throw new Error(`deploy_fee.amount invalid (${params.amount}) — pass the full deployFee object from post_task`);
    if (!Number.isInteger(dec) || dec < 0 || dec > 36)
        throw new Error(`deploy_fee.decimals invalid (${params.decimals}) — pass the full deployFee object from post_task`);
    if (!isAddress(params.token) || !isAddress(params.recipient))
        throw new Error("deploy_fee.token/recipient is not a valid address — pass the full deployFee object from post_task");
    const wallet = createWalletClient({ account: account(), chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    // Scale by the TOKEN's own decimals (a hardcoded 6 underpaid 18-decimal tokens 10^12×).
    const value = parseUnits(amt.toFixed(dec), dec);
    const hash = await wallet.writeContract({
        address: getAddress(params.token),
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [getAddress(params.recipient), value],
        chain: chain(),
    });
    // Wait ≥2 confirmations so the platform's verifyFeePayment accepts it on the authorize
    // call that immediately follows — AND verify the tx actually SUCCEEDED. A reverted
    // transfer (insufficient balance, paused/blocklisted token, hooks) still produces a
    // receipt; without the status check we'd return it as 'paid' and the budget never freezes.
    const pub = createPublicClient({ chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2 });
    if (receipt.status !== "success")
        throw new Error(`deploy fee tx ${hash} reverted on-chain — fee NOT paid (no budget frozen)`);
    return hash;
}
export function hasEvmKey() {
    return !!resolvePrivateKey();
}
function scheme() {
    const pk = resolvePrivateKey();
    if (!pk)
        throw new Error("no signing key (set CYBERDYNE_EVM_PRIVATE_KEY or run `cyberdyne-mcp onboard`) — cannot sign the escrow authorization");
    const chainId = Number(process.env.CYBERDYNE_CHAIN_ID ?? 8453);
    const chain = chainId === 8453 ? base : baseSepolia;
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`));
    const pub = createPublicClient({ chain, transport: http(process.env.CYBERDYNE_RPC_URL) });
    // toClientEvmSigner(account, PUBLIC client) — account first, public client second.
    return new AuthCaptureEvmScheme(toClientEvmSigner(account, pub));
}
/** The agent's signing wallet address (so the platform can verify payer == this). */
export function evmAddress() {
    const pk = resolvePrivateKey();
    if (!pk)
        throw new Error("no signing key (set CYBERDYNE_EVM_PRIVATE_KEY or run `cyberdyne-mcp onboard`)");
    return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`)).address;
}
/** Canonical Uniswap Permit2 (same address on every chain). */
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ERC20_PERMIT2_ABI = [
    { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
/**
 * Permit2-method tokens (BNKR / any non-EIP-3009 ERC-20) require a ONE-TIME
 * ERC-20 approval to the canonical Permit2 contract before the operator's on-chain
 * `authorize` can pull the frozen budget. The agent signs the Permit2 transfer
 * authorization, but the underlying ERC-20→Permit2 allowance is a SEPARATE on-chain tx
 * the agent's wallet must send once per token. Without it the budget freeze REVERTS —
 * while the deploy fee (a plain transfer) still succeeds, masking the cause. EIP-3009
 * tokens (USDC) need no approval. Idempotent: a no-op once the allowance covers the budget.
 */
async function ensurePermit2Approval(requirements) {
    const r = (requirements ?? {});
    if (r.extra?.assetTransferMethod !== "permit2")
        return; // EIP-3009 / USDC: nothing to approve
    const token = r.asset;
    if (!token || !isAddress(token))
        return;
    const owner = getAddress(evmAddress());
    const need = (() => { try {
        return BigInt(r.amount ?? 0);
    }
    catch {
        return 0n;
    } })();
    const pub = createPublicClient({ chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    const allowance = (await pub.readContract({
        address: getAddress(token), abi: ERC20_PERMIT2_ABI, functionName: "allowance", args: [owner, PERMIT2_ADDRESS],
    }));
    if (allowance >= need && allowance > 0n)
        return; // already approved enough
    // Approve max once so future budgets on this token never re-approve. The agent pays this gas.
    // SURFACE this on-chain action (stderr, never the MCP stdio channel): an unlimited
    // Permit2 allowance is the standard pattern, but it must never be a SILENT transaction.
    console.error(`[cyberdyne-mcp] sending one-time Permit2 approval for token ${token} (allowance: unlimited, spender: ${PERMIT2_ADDRESS}) — required once per token for pool budget freezes; the agent wallet pays this gas.`);
    const wallet = createWalletClient({ account: account(), chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    const hash = await wallet.writeContract({
        address: getAddress(token), abi: ERC20_PERMIT2_ABI, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint256], chain: chain(),
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success")
        throw new Error(`Permit2 approval tx ${hash} reverted — budget cannot be frozen for ${token}`);
}
/**
 * Sign the auth-capture requirements (the `authIntent.requirements` the platform
 * returns) → base64 payload the platform's authorize route consumes as `signedPayment`.
 * For Permit2-method tokens this first ensures the agent wallet has approved Permit2
 * (a prerequisite the on-chain freeze needs but the signature alone doesn't set).
 */
export async function signAuthCapture(requirements) {
    await ensurePermit2Approval(requirements);
    const result = await scheme().createPaymentPayload(2, requirements);
    return Buffer.from(JSON.stringify(result)).toString("base64");
}
// ── Trustless self-recovery: reclaim ────────────────────────────────────────
// The deepest non-custodial guarantee. The AGENT (payer) calls the AUDITED
// AuthCaptureEscrow `reclaim(paymentInfo)` DIRECTLY — no CYBERDYNE operator. The
// contract requires `msg.sender == paymentInfo.payer` and `block.timestamp >=
// authorizationExpiry`, then returns the uncaptured remainder to the payer. This
// is the same PaymentInfo tuple shape used by authorize/capture/void.
/** The canonical audited base/commerce-payments AuthCaptureEscrow on Base. */
export const AUTH_CAPTURE_ESCROW_ADDRESS = "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff";
/** PaymentInfo tuple components — EXACTLY the order the escrow hashes/expects. */
const PAYMENT_INFO_COMPONENTS = [
    { name: "operator", type: "address" },
    { name: "payer", type: "address" },
    { name: "receiver", type: "address" },
    { name: "token", type: "address" },
    { name: "maxAmount", type: "uint120" },
    { name: "preApprovalExpiry", type: "uint48" },
    { name: "authorizationExpiry", type: "uint48" },
    { name: "refundExpiry", type: "uint48" },
    { name: "minFeeBps", type: "uint16" },
    { name: "maxFeeBps", type: "uint16" },
    { name: "feeReceiver", type: "address" },
    { name: "salt", type: "uint256" },
];
const paymentInfoArg = { name: "paymentInfo", type: "tuple", components: PAYMENT_INFO_COMPONENTS };
/** Minimal ABI: just `reclaim(PaymentInfo)` — payer-callable after authorizationExpiry. */
export const reclaimAbi = [
    { type: "function", name: "reclaim", stateMutability: "nonpayable", inputs: [paymentInfoArg], outputs: [] },
];
/** Decode the base64 signed payment → { payer (authorization.from), validBefore, salt }. */
function decodeSignedPayment(signedPayment) {
    let payload;
    try {
        const decoded = JSON.parse(Buffer.from(signedPayment, "base64").toString("utf8"));
        payload = (decoded.payload ?? decoded);
    }
    catch {
        throw new Error("malformed_signed_payment");
    }
    const auth = payload.authorization;
    const permit = payload.permit2Authorization;
    const from = auth?.from ?? permit?.from;
    const validBefore = auth?.validBefore ?? permit?.deadline;
    const salt = payload.salt;
    if (!from || !validBefore || !salt)
        throw new Error("incomplete_signed_payment (need authorization.from + validBefore + salt)");
    return { payer: from, preApprovalExpiry: Number(validBefore), salt, value: auth?.value };
}
/**
 * Reconstruct the on-chain PaymentInfo struct EXACTLY like the platform's
 * `structFor` (lib/payments/escrow-pool.ts) — the contract recomputes the hash, so
 * every field must match the one signed at deploy or `reclaim` reverts.
 */
function structFor(info, payer, preApprovalExpiry, salt, value) {
    const x = info.extra;
    return {
        operator: getAddress(x.captureAuthorizer),
        payer: getAddress(payer),
        receiver: getAddress(info.payTo),
        token: getAddress(info.asset),
        // M2: the platform's authoritative structFor ALWAYS uses info.amount (the frozen budget),
        // never the EIP-3009 authorization `value`. Mirror it exactly or the contract's recomputed
        // hash won't match and reclaim reverts — silently breaking the trustless backstop.
        maxAmount: BigInt(info.amount),
        preApprovalExpiry,
        authorizationExpiry: x.captureDeadline,
        refundExpiry: x.refundDeadline,
        minFeeBps: x.minFeeBps ?? 0,
        maxFeeBps: x.maxFeeBps ?? 0,
        feeReceiver: getAddress(x.feeRecipient),
        salt: BigInt(salt),
    };
}
/**
 * TRUSTLESS SELF-RECOVERY. The agent (payer) calls `reclaim(paymentInfo)` on the
 * audited escrow directly to recover its OWN unfilled budget — no operator. Asserts
 * the MCP wallet == payer (reclaim is payer-only on-chain) and that the authorization
 * deadline has passed, then signs+sends from the agent wallet and waits for the receipt.
 * Returns { ok, tx_hash, reclaimed } (reclaimed = the human-readable atomic maxAmount).
 */
export async function reclaimBudget(info) {
    const signed = info.signedPayment;
    if (!signed)
        throw new Error("no signedPayment on this task — it was never frozen on the escrow (nothing to reclaim)");
    const { payer, preApprovalExpiry, salt, value } = decodeSignedPayment(signed);
    // reclaim is payer-only on-chain — assert this wallet IS the payer before sending.
    const me = evmAddress();
    if (me.toLowerCase() !== payer.toLowerCase()) {
        throw new Error(`wallet ${me} is not the payer (${payer}) of this budget — reclaim is payer-only on-chain. ` +
            "Use the same wallet that authorized/froze the budget.");
    }
    const paymentInfo = structFor(info, payer, preApprovalExpiry, salt, value);
    // reclaim requires block.timestamp >= authorizationExpiry — check first for a clear error.
    const now = Math.floor(Date.now() / 1000);
    if (now < paymentInfo.authorizationExpiry) {
        const when = new Date(paymentInfo.authorizationExpiry * 1000).toISOString();
        throw new Error(`too_early: the authorization deadline has not passed yet (reclaim opens at ${when}, ` +
            `in ~${Math.ceil((paymentInfo.authorizationExpiry - now) / 60)} min). ` +
            "Until then, close_task asks CYBERDYNE's operator to void the unfilled budget back to you.");
    }
    const wallet = createWalletClient({ account: account(), chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    const pub = createPublicClient({ chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    const hash = await wallet.writeContract({
        address: AUTH_CAPTURE_ESCROW_ADDRESS,
        abi: reclaimAbi,
        functionName: "reclaim",
        args: [paymentInfo],
        chain: chain(),
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
        throw new Error("reclaim reverted on-chain — the budget may already be fully captured/settled, already reclaimed, " +
            "or the deadline window is wrong. Nothing was recovered.");
    }
    // reclaim recovers only the UNCAPTURED remainder, NOT the full maxAmount ceiling. Decode
    // the ACTUAL refund from the receipt — the ERC-20 Transfer(s) whose recipient is the payer
    // — so we never overstate. Fall back to maxAmount only if no Transfer is decodable.
    let reclaimed = String(paymentInfo.maxAmount);
    try {
        const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        const payerLc = payer.toLowerCase();
        let sum = 0n;
        for (const l of receipt.logs) {
            if (l.topics[0] !== TRANSFER || !l.topics[2])
                continue;
            const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
            if (to === payerLc)
                sum += BigInt(l.data);
        }
        if (sum > 0n)
            reclaimed = String(sum);
    }
    catch {
        /* keep the maxAmount fallback */
    }
    return { ok: true, tx_hash: hash, reclaimed };
}
