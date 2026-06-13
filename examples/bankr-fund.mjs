#!/usr/bin/env node
/**
 * BETA example — fund a CYBERDYNE quest from your Bankr custodial wallet (NO key export).
 *
 * The agent pays the deploy fee via Bankr's /wallet/transfer and signs the escrow
 * auth-capture via Bankr's /wallet/sign (eth_signTypedData_v4). The auth-capture payload
 * is built by the SAME @x402/evm scheme the certified local path uses — only the signer
 * is the Bankr wallet. CYBERDYNE never custodies funds; the budget freezes on the audited
 * Base escrow directly from your Bankr wallet.
 *
 * Requires (build first: `npm run build`):
 *   CYBERDYNE_IDENTITY_TOKEN   your cyb_ key (run `npx cyberdyne-mcp onboard` or `login`)
 *   CYBERDYNE_BANKR_KEY        a valid bk_ Bankr Agent-API key (or BANKR_API_KEY / ~/.bankr/config.json)
 *   CYBERDYNE_API_URL          optional, defaults to https://app.cyberdyne-os.xyz
 *
 * Run:  node examples/bankr-fund.mjs
 *
 * NOTE: this funds in USDC (EIP-3009 — no allowance needed). Ecosystem tokens (BNKR/
 * GITLAWB/Permit2) additionally need a one-time ERC-20→Permit2 approval sent from the
 * Bankr wallet before the budget can freeze (see ../src/bankr-signer.ts). Uses cents.
 */
import {
  hasBankrSigner,
  bankrSignerAddress,
  bankrSignAuthCapture,
  bankrPayDeployFee,
} from "../dist/bankr-signer.js";

const API = (process.env.CYBERDYNE_API_URL || "https://app.cyberdyne-os.xyz").replace(/\/+$/, "");
const TOKEN = process.env.CYBERDYNE_IDENTITY_TOKEN?.trim();
if (!TOKEN) {
  console.error("set CYBERDYNE_IDENTITY_TOKEN (your cyb_ key) — run `npx cyberdyne-mcp onboard` first");
  process.exit(1);
}
if (!hasBankrSigner()) {
  console.error("set CYBERDYNE_BANKR_KEY or BANKR_API_KEY (a valid bk_ Bankr Agent-API key)");
  process.exit(1);
}

const rest = async (method, path, body) => {
  const r = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};

// 1) Post a tiny USDC engagement quest (1 unit, $0.02). reward_usd is the TOTAL budget.
const post = await rest("POST", "/api/tasks", {
  title: "Repost our launch",
  category: "social",
  social_action: "retweet",
  reward_usd: 0.02,
  quantity: 1,
  pay_token: "USDC",
  duration_min: 2,
  difficulty: "easy",
});
const taskId = post.task.id;
console.error(`posted ${taskId} — funding from Bankr wallet ${await bankrSignerAddress()} (no key export)…`);

// 2) Sign the budget via Bankr (/wallet/sign) + pay the deploy fee via Bankr (/wallet/transfer).
const requirements = post.authIntent?.requirements ?? post.authIntent;
const signedPayment = await bankrSignAuthCapture(requirements);
const feeTx = await bankrPayDeployFee({
  amount: post.deployFee.amount,
  recipient: post.deployFee.recipient,
  token: post.deployFee.token,
});
console.error(`  deploy fee paid via Bankr — ${feeTx}`);

// 3) Freeze the budget on the audited escrow.
const authed = await rest("POST", `/api/tasks/${taskId}/authorize`, { signedPayment, fee_tx_hash: feeTx });
console.error(`✓ funded — task ${taskId}, escrow_status: ${authed.task?.escrow_status ?? "held"}`);
console.error("Humans now submit FCFS. Review each (review_submission); close_task refunds the unfilled remainder.");
