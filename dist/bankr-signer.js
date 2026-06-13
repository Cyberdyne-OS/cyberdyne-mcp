/**
 * BETA — Bankr-wallet-native funding for CYBERDYNE (no private-key export).
 *
 * Lets an agent fund a quest entirely from its Bankr-managed (Privy) custodial wallet:
 *   - the deploy fee  → POST /wallet/transfer (a plain ERC-20 send)
 *   - the auth-capture authorization → signed via POST /wallet/sign (eth_signTypedData_v4)
 *
 * The auth-capture TYPED DATA is built by the SAME audited @x402/evm AuthCaptureEvmScheme
 * the local path uses (src/evm-signer.ts) — we only swap the SIGNER: a viem custom account
 * whose signTypedData/signMessage forward to Bankr's custodial signer. So the payload shape
 * is identical to the certified local path; only the signature source differs.
 *
 * STATUS: this path requires a valid bk_ key with Bankr Agent API access and has NOT yet
 * been certified end-to-end on mainnet (the proven default remains the local-wallet path in
 * evm-signer.ts). It is opt-in only (`post --bankr-wallet` / CYBERDYNE_SIGNER=bankr).
 *
 * Permit2-method tokens (BNKR/GITLAWB/non-EIP-3009) need a one-time ERC-20→Permit2 approval
 * sent from the wallet before the budget can freeze. Sending that approval from a custodial
 * Bankr wallet is not automated here, so we READ the allowance first and fail with a clear,
 * actionable error if it's missing — rather than producing a signature that would revert at
 * authorize. EIP-3009 tokens (USDC) need no approval and work directly.
 */
import { createPublicClient, getAddress, http, isAddress } from "viem";
import { toAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { AuthCaptureEvmScheme, toClientEvmSigner } from "@x402/evm";
import { bankrSignTypedData, bankrSignMessage, bankrTransfer, bankrWalletAddress, resolveBankrKey, MissingBankrKeyError } from "./bankr.js";
function chain() {
    return Number(process.env.CYBERDYNE_CHAIN_ID ?? 8453) === 8453 ? base : baseSepolia;
}
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ERC20_ALLOWANCE_ABI = [
    { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
];
/** True when a bk_ key is discoverable (so callers can offer the Bankr-wallet path). */
export function hasBankrSigner() {
    return !!resolveBankrKey();
}
/**
 * A viem custom account backed by the Bankr custodial wallet. Its address is the
 * canonical Bankr EVM wallet; its signTypedData/signMessage call POST /wallet/sign.
 * signTransaction is unsupported (the custodial wallet broadcasts via /wallet/transfer
 * | /wallet/submit, not via a locally-serialized signed tx).
 */
export async function bankrAccount(key) {
    const bk = key ?? resolveBankrKey();
    if (!bk)
        throw new MissingBankrKeyError();
    const address = getAddress(await bankrWalletAddress(bk));
    return toAccount({
        address,
        // viem passes the full EIP-712 definition { domain, types, primaryType, message };
        // we forward it verbatim to Bankr's eth_signTypedData_v4 signer (correct shape).
        async signTypedData(typedData) {
            return bankrSignTypedData(typedData, bk);
        },
        async signMessage({ message }) {
            const text = typeof message === "string"
                ? message
                : typeof message?.raw === "string"
                    ? (message.raw)
                    : JSON.stringify(message);
            return bankrSignMessage(text, bk);
        },
        async signTransaction() {
            throw new Error("the Bankr custodial wallet does not export raw signed transactions — use /wallet/transfer (fees) or /wallet/submit");
        },
    });
}
/** The agent's Bankr wallet address (the on-chain payer the platform will verify). */
export async function bankrSignerAddress(key) {
    return bankrWalletAddress(key);
}
/**
 * Guard Permit2-method tokens: the on-chain freeze needs an ERC-20→Permit2 allowance
 * the signature alone can't set. Read it; if insufficient, fail with a clear next step
 * instead of producing a payload that would revert at authorize.
 */
async function assertPermit2Ready(requirements, owner) {
    const r = (requirements ?? {});
    if (r.extra?.assetTransferMethod !== "permit2")
        return; // USDC/EIP-3009: nothing to approve
    const token = r.asset;
    if (!token || !isAddress(token))
        return;
    const need = (() => { try {
        return BigInt(r.amount ?? 0);
    }
    catch {
        return 0n;
    } })();
    const pub = createPublicClient({ chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    if (need === 0n)
        return; // nothing to freeze → no approval needed
    const allowance = (await pub.readContract({
        address: getAddress(token), abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [getAddress(owner), PERMIT2_ADDRESS],
    }));
    if (allowance >= need)
        return;
    throw new Error(`Bankr-wallet funding for this Permit2 token (${token}) needs a one-time ERC-20→Permit2 approval ` +
        `from your Bankr wallet (${owner}) that isn't in place yet. Approve Permit2 (spender ` +
        `${PERMIT2_ADDRESS}) from the Bankr wallet first, or fund this token from a local wallet. ` +
        "USDC (EIP-3009) needs no approval and works directly.");
}
/**
 * Sign the auth-capture requirements with the Bankr custodial wallet → base64 payload
 * the platform's /authorize route consumes as `signedPayment`. Same scheme + payload
 * shape as the local path; only the signer is Bankr.
 */
export async function bankrSignAuthCapture(requirements, key) {
    const bk = key ?? resolveBankrKey();
    if (!bk)
        throw new MissingBankrKeyError();
    const account = await bankrAccount(bk);
    await assertPermit2Ready(requirements, account.address);
    const pub = createPublicClient({ chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    const scheme = new AuthCaptureEvmScheme(toClientEvmSigner(account, pub));
    const result = await scheme.createPaymentPayload(2, requirements);
    return Buffer.from(JSON.stringify(result)).toString("base64");
}
/**
 * Pay the SEPARATE deploy fee from the Bankr custodial wallet via /wallet/transfer.
 * `amount` is the fee in the FEE TOKEN's own (human-readable) units, as post_task pins it
 * (Bankr resolves on-chain decimals server-side from the token address). Returns the tx
 * hash to pass to authorize as `fee_tx_hash`.
 *
 * Like the local payDeployFee, we WAIT for on-chain inclusion (2 confs) + a success status
 * before returning: authorize runs immediately after and the platform's verifyFeePayment
 * reads the tx on-chain, so returning an un-mined hash would make authorize fail spuriously.
 */
export async function bankrPayDeployFee(fee, key) {
    if (!isAddress(fee.token) || !isAddress(fee.recipient)) {
        throw new Error("deploy_fee.token/recipient is not a valid address — pass the full deployFee object from post_task");
    }
    const hash = await bankrTransfer({ tokenAddress: getAddress(fee.token), recipientAddress: getAddress(fee.recipient), amount: fee.amount, isNativeToken: false, chain: "base" }, key);
    const pub = createPublicClient({ chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    const receipt = await pub.waitForTransactionReceipt({ hash: hash, confirmations: 2 });
    if (receipt.status !== "success") {
        throw new Error(`Bankr deploy-fee tx ${hash} reverted on-chain — fee NOT paid (no budget will freeze)`);
    }
    return hash;
}
