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
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import { AuthCaptureEvmScheme, toClientEvmSigner } from "@x402/evm";
function account() {
    const pk = process.env.CYBERDYNE_EVM_PRIVATE_KEY;
    if (!pk)
        throw new Error("CYBERDYNE_EVM_PRIVATE_KEY not set");
    return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`));
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
    const wallet = createWalletClient({ account: account(), chain: chain(), transport: http(process.env.CYBERDYNE_RPC_URL) });
    return wallet.writeContract({
        address: params.token,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [params.recipient, parseUnits(params.amountUsd.toFixed(6), 6)],
        chain: chain(),
    });
}
export function hasEvmKey() {
    return !!process.env.CYBERDYNE_EVM_PRIVATE_KEY;
}
function scheme() {
    const pk = process.env.CYBERDYNE_EVM_PRIVATE_KEY;
    if (!pk)
        throw new Error("CYBERDYNE_EVM_PRIVATE_KEY not set — cannot sign the escrow authorization");
    const chainId = Number(process.env.CYBERDYNE_CHAIN_ID ?? 8453);
    const chain = chainId === 8453 ? base : baseSepolia;
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`));
    const pub = createPublicClient({ chain, transport: http(process.env.CYBERDYNE_RPC_URL) });
    // toClientEvmSigner(account, PUBLIC client) — account first, public client second.
    return new AuthCaptureEvmScheme(toClientEvmSigner(account, pub));
}
/** The agent's signing wallet address (so the platform can verify payer == this). */
export function evmAddress() {
    const pk = process.env.CYBERDYNE_EVM_PRIVATE_KEY;
    return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`)).address;
}
/**
 * Sign the auth-capture requirements (the `authIntent.requirements` the platform
 * returns) → base64 payload the platform's authorize route consumes as `signedPayment`.
 */
export async function signAuthCapture(requirements) {
    const result = await scheme().createPaymentPayload(2, requirements);
    return Buffer.from(JSON.stringify(result)).toString("base64");
}
