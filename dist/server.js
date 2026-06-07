#!/usr/bin/env node
/**
 * CYBERDYNE MCP server — the agent gateway (LIVE).
 *
 * Exposes the CYBERDYNE marketplace to any MCP-capable agent (Claude, etc.) as
 * tools that call the REAL platform API. There is NO in-memory state any more —
 * every tool is a thin, typed wrapper over an HTTP endpoint on the live backend.
 *
 *   list_categories  — the static task taxonomy (no network)
 *   search_humans    — POST /api/a2a {search_humans}      → capability index
 *   get_treasury     — GET  /api/treasury                 → the agent's balance
 *   fund_treasury    — POST /api/treasury/fund            → demo top-up (testnet only)
 *   get_deposit_address — GET  /api/treasury/deposit      → where to send real USDC (live)
 *   deposit          — POST /api/treasury/deposit         → credit treasury from a real USDC tx
 *   post_task        — POST /api/tasks                    → open a task
 *   assign_task      — POST /api/tasks/[id]/assign        → pick a human (→ authIntent)
 *   authorize_task   — POST /api/tasks/[id]/authorize     → open the escrow hold
 *   get_task         — GET  /api/tasks/[id]               → status + submissions/claims
 *   release_payment  — POST /api/tasks/[id]/release       → direct-hire: capture (pay) or reject
 *   review_submission — POST /api/submissions/[id]/review → pool/FCFS: approve/reject one submission
 *   close_task       — POST /api/tasks/[id]/close         → close a (multi-unit) bounty
 *
 * Auth: every networked tool sends the agent's `cyb_…` key. The REST routes take
 * it as `Authorization: Bearer …`; search_humans goes through the a2a JSON-RPC
 * gateway (the REST GET /api/humans is session-only), which carries the key as
 * `identity_token`.
 *
 * The HUMAN submit-proof step happens in the app/UI (human-only — agents cannot
 * submit on a human's behalf). There are TWO settlement flows:
 *
 *   FLOW A — DIRECT HIRE (the path that works TODAY on the live custodial USDC
 *   rail: real deposit → escrow → withdraw on Base mainnet). You pick one human:
 *     get_deposit_address → send USDC → deposit  (fund the treasury)
 *       → post_task → search_humans → assign_task (→ authIntent)
 *       → authorize_task (open the escrow hold)
 *       → poll get_task until a submission is pending
 *       → release_payment (approve → capture/pay; else reject → refund)
 *
 *   FLOW B — POOL / FCFS BOUNTY (non-custodial pool escrow). Post a multi-unit
 *   bounty, freeze the whole budget once, and let any eligible human claim+submit
 *   first-come-first-served; you approve each unit. This rail is BUILT but GATED
 *   OFF today (server env ESCROW_POOL is not enabled), pending certification — so
 *   real-money non-custodial pool payouts are NOT live yet. When the server
 *   enables it, post_task returns an `authIntent` + a separate `deployFee`:
 *     post_task (quantity>1) → authorize_task (sign the budget + pay the deploy fee)
 *       → humans claim+submit FCFS → poll get_task
 *       → review_submission per pending submission (approve → capture one unit;
 *         reject → the slot reopens) → close_task to refund unfilled units.
 *
 * Config comes from the environment (see src/client.ts):
 *   CYBERDYNE_API_URL         default "https://app.cyberdyne-os.xyz"
 *   CYBERDYNE_IDENTITY_TOKEN  the agent's cyb_ key (required for networked tools)
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CATEGORIES, TASK_CATEGORIES } from "./registry.js";
import { ApiError, CyberdyneClient, MissingTokenError, readConfig, saveToken } from "./client.js";
// `cyberdyne-mcp login` — persist the key so the MCP add line can omit it (short
// one-time-login install). Runs before the server boots, then exits. The key is read
// (most-private first) from: piped stdin → CYBERDYNE_LOGIN_TOKEN env → argv. argv
// works but lands the secret in shell history / `ps`, so we steer to the others.
if (process.argv[2] === "login") {
    const fromArg = process.argv[3]?.trim();
    let token = "";
    if (!process.stdin.isTTY) {
        try {
            token = readFileSync(0, "utf8").trim(); // piped: echo cyb_… | npx cyberdyne-mcp login
        }
        catch {
            /* nothing piped */
        }
    }
    token = token || process.env.CYBERDYNE_LOGIN_TOKEN?.trim() || fromArg || "";
    if (!token.startsWith("cyb_")) {
        console.error("Save your CYBERDYNE key (most private first):\n" +
            "  echo cyb_<key> | npx cyberdyne-mcp login\n" +
            "  CYBERDYNE_LOGIN_TOKEN=cyb_<key> npx cyberdyne-mcp login\n" +
            "  npx cyberdyne-mcp login cyb_<key>      (key is left in shell history / process list)\n" +
            "Get your key at https://app.cyberdyne-os.xyz → Agent Console → Generate API key.");
        process.exit(1);
    }
    if (fromArg && token === fromArg) {
        console.error("⚠  Heads-up: passing the key as an argument leaves it in your shell history.\n" +
            "   Next time, pipe it instead:  echo cyb_<key> | npx cyberdyne-mcp login");
    }
    const path = saveToken(token);
    console.error(`✓ Saved your CYBERDYNE key to ${path}.\n` +
        "Now run:  claude mcp add cyberdyne -- npx -y cyberdyne-mcp");
    process.exit(0);
}
const config = readConfig();
const client = new CyberdyneClient(config);
// ---- Result helpers -------------------------------------------------------
const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const err = (message) => ({
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
});
/** Run a tool body, mapping client errors to a clean MCP error result. */
async function guard(fn) {
    try {
        return json(await fn());
    }
    catch (e) {
        if (e instanceof MissingTokenError)
            return err(e.message);
        if (e instanceof ApiError)
            return err(e.message);
        return err(e instanceof Error ? e.message : String(e));
    }
}
// ---- Server ---------------------------------------------------------------
const server = new McpServer({ name: "cyberdyne", version: "0.2.0" });
server.tool("list_categories", "List the kinds of real-world work CYBERDYNE humans can do. Static (no network). Use this to learn the valid `category` values before posting a task.", {}, async () => json(Object.entries(CATEGORIES).map(([id, blurb]) => ({ id, blurb }))));
server.tool("search_humans", "Find verified humans by capability via the live capability index (a2a gateway). Filters are optional and combine (AND). Results are role='human' profiles ranked by reputation, projected to public columns (no wallets/balances). Note: `skills` is an array.", {
    skills: z
        .array(z.enum(TASK_CATEGORIES))
        .optional()
        .describe("Task categories the human must be able to do (all must match)."),
    min_reputation: z.number().min(0).max(5).optional().describe("Minimum reputation (0–5)."),
    location: z.string().optional().describe("Substring match on location, e.g. 'ES', 'Tokyo'."),
}, async ({ skills, min_reputation, location }) => guard(() => client.a2a("search_humans", {
    ...(skills ? { skills } : {}),
    ...(min_reputation != null ? { min_reputation } : {}),
    ...(location ? { location } : {}),
})));
server.tool("get_treasury", "Get the agent's own treasury (the source of task rewards on the manual rail). Returns null if the agent has no treasury yet — call fund_treasury to create one.", {}, async () => guard(() => client.rest("GET", "/api/treasury")));
server.tool("fund_treasury", "Demo top-up (TESTNET/DEMO ONLY): add USD to the treasury balance. DISABLED when the platform is live (returns 403 funding_disabled) — on the live rail fund with REAL USDC via get_deposit_address + deposit instead.", { amount_usd: z.number().positive().describe("USD to add to the treasury balance.") }, async ({ amount_usd }) => guard(() => client.rest("POST", "/api/treasury/fund", { body: { amount_usd } })));
server.tool("get_deposit_address", "Get the on-chain address to fund your treasury with REAL USDC (live rail). Returns { deposit_address, chain_id, usdc_address, decimals }. Send USDC from your VERIFIED wallet to deposit_address on Base, then call `deposit` with the tx hash to credit your treasury.", {}, async () => guard(() => client.rest("GET", "/api/treasury/deposit")));
server.tool("deposit", "Credit your treasury from a REAL on-chain USDC deposit (live rail; the real-money replacement for fund_treasury). First send USDC to the address from get_deposit_address (from your verified wallet), then call this with the transaction hash. The transfer is verified on-chain (to = platform wallet, from = your wallet) and credited exactly once — resubmitting the same tx never double-credits.", {
    tx_hash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .describe("The Base tx hash of your USDC transfer to the deposit address."),
}, async ({ tx_hash }) => guard(() => client.rest("POST", "/api/treasury/deposit", { body: { tx_hash } })));
server.tool("post_task", "Open a task on the marketplace. Funds are NOT charged at post — the escrow hold opens later at authorize_task. `reward_usd` is the total budget; with quantity>1 each unit holds reward_usd/quantity (each unit must be >= $0.01). Returns the created task (with its id). DIRECT-HIRE / custodial rail (the path live today): the platform checks the prefunded treasury can cover the budget (402 insufficient_treasury otherwise); response is { task }. POOL/FCFS rail (only when the server enables it): response also includes `authIntent` (the budget authorization to sign) and `deployFee` { usd, bps, recipient, token } (a SEPARATE non-refundable fee tx) — pass both to authorize_task.", {
    title: z.string().min(2).max(160).describe("Short task title."),
    category: z.enum(TASK_CATEGORIES),
    description: z.string().max(4000).optional().describe("What you need the human to do."),
    steps: z.array(z.string()).optional().describe("Ordered steps / acceptance criteria."),
    reward_usd: z.number().positive().describe("Total reward budget in USD."),
    quantity: z.number().int().positive().optional().describe("Number of identical units (default 1)."),
    duration_min: z.number().int().positive().describe("Estimated minutes to complete."),
    difficulty: z.enum(["easy", "medium", "hard"]),
    pay_token: z.enum(["USDC", "BNKR", "CYOS"]).optional().describe("Settlement token (default USDC)."),
    deadline_hours: z.number().int().positive().optional(),
}, async (args) => guard(() => client.rest("POST", "/api/tasks", { body: args })));
server.tool("assign_task", "Assign an open task to a chosen human (poster-only) and open the escrow intent. Returns `{ task, authIntent }`: on an on-chain rail `authIntent` is the auth-capture requirements the agent must sign; on the manual rail it is null. Next call authorize_task to actually open the hold.", {
    task_id: z.string().uuid(),
    human_id: z.string().uuid().describe("The human profile id (from search_humans / get_task claims)."),
}, async ({ task_id, human_id }) => guard(() => client.rest("POST", `/api/tasks/${task_id}/assign`, { body: { human_id } })));
server.tool("authorize_task", "Open the escrow hold for a task. CUSTODIAL/MANUAL rail (the path live today): call with just { task_id } — the prefunded treasury is debited into a logical escrow hold, no signature needed. TRUSTLESS on-chain DIRECT-HIRE rail: the agent signs an auth-capture authorization — if CYBERDYNE_EVM_PRIVATE_KEY is set pass `auth_intent` (the authIntent from assign_task) and the MCP signs automatically, else pass a pre-signed `signed_payment`. POOL/FCFS rail (only when the server enables it): pass BOTH `auth_intent` (from post_task) AND `deploy_fee` (the deployFee object from post_task) — the MCP signs the budget and pays the separate 2.5% USDC / 5% other-token fee tx from its wallet, then submits both; or pass a pre-signed `signed_payment` and a pre-paid `fee_tx_hash`. Idempotent once held.", {
    task_id: z.string().uuid(),
    signed_payment: z.string().optional().describe("Pre-signed base64 auth-capture payload (external/Bankr signer)."),
    auth_intent: z.unknown().optional().describe("The authIntent from assign_task/post — required for MCP wallet auto-signing."),
    deploy_fee: z
        .unknown()
        .optional()
        .describe("POOL rail: the deployFee object {usd,recipient,token} from post_task — the MCP auto-pays it."),
    fee_tx_hash: z.string().optional().describe("POOL rail: hash of an already-paid deploy-fee tx (skips auto-pay)."),
}, async ({ task_id, signed_payment, auth_intent, deploy_fee, fee_tx_hash }) => guard(async () => {
    let payload = signed_payment;
    let feeTx = fee_tx_hash;
    if ((!payload && auth_intent) || (!feeTx && deploy_fee)) {
        const { hasEvmKey, signAuthCapture, payDeployFee } = await import("./evm-signer.js");
        if (hasEvmKey()) {
            if (!payload && auth_intent) {
                const requirements = auth_intent.requirements ?? auth_intent;
                payload = await signAuthCapture(requirements);
            }
            if (!feeTx && deploy_fee) {
                const f = deploy_fee;
                feeTx = await payDeployFee({ amountUsd: f.usd, recipient: f.recipient, token: f.token });
            }
        }
    }
    return client.rest("POST", `/api/tasks/${task_id}/authorize`, {
        body: {
            ...(payload ? { signedPayment: payload } : {}),
            ...(feeTx ? { fee_tx_hash: feeTx } : {}),
        },
    });
}));
server.tool("get_task", "Get the live state of a task: the task row plus the submissions and per-unit claims the agent (as poster) may see. Poll this after authorize_task until a submission with status 'pending' appears — that is the human's proof, ready for release_payment.", { task_id: z.string().uuid() }, async ({ task_id }) => guard(() => client.rest("GET", `/api/tasks/${task_id}`)));
server.tool("release_payment", "DIRECT-HIRE settle (poster-only): settle a submitted proof for a single-human task (the custodial-rail path live today). approve:true → CAPTURE: pay the human net of the platform fee. approve:false → REJECT/REFUND the held escrow. Requires the `submission_id` to act on; if omitted, the gateway fetches the task and uses the latest pending submission (and errors if none is pending yet — poll get_task first). For POOL/FCFS bounties use review_submission instead (this path captures the whole task hold, not one unit).", {
    task_id: z.string().uuid(),
    approve: z.boolean().describe("true = proof meets criteria → pay; false = reject/refund."),
    submission_id: z
        .string()
        .uuid()
        .optional()
        .describe("The submission to settle. Auto-resolved to the latest pending one if omitted."),
    score: z.number().int().min(1).max(5).optional().describe("Rating of the human's work (1–5)."),
    reject_reason: z.string().max(1000).optional().describe("Why the proof was rejected (approve:false)."),
}, async ({ task_id, approve, submission_id, score, reject_reason }) => guard(async () => {
    // The release endpoint settles a specific submission. If the caller didn't
    // pass one, resolve the latest PENDING submission from the live task.
    let sid = submission_id;
    if (!sid) {
        const detail = await client.rest("GET", `/api/tasks/${task_id}`);
        const pending = (detail.submissions ?? []).find((s) => s.status === "pending");
        if (!pending) {
            throw new ApiError(409, "no_pending_submission (poll get_task until the human submits proof)", `GET /api/tasks/${task_id}`);
        }
        sid = pending.id;
    }
    return client.rest("POST", `/api/tasks/${task_id}/release`, {
        body: {
            submission_id: sid,
            approve,
            ...(score != null ? { score } : {}),
            ...(reject_reason ? { reject_reason } : {}),
        },
    });
}));
server.tool("review_submission", "POOL / FCFS settle (poster-only): approve or reject ONE submission on a pool bounty. approve:true → CAPTURE one unit from the frozen pool budget to the human and consume a slot; approve:false → reject (the slot reopens for the next submitter — no spot-blocking). For single-human direct-hire tasks use release_payment instead. Poll get_task for pending submissions. NOTE: the pool/FCFS rail is gated off on the server until certification — this tool acts on pool tasks once the operator enables that rail.", {
    submission_id: z.string().uuid().describe("The pending submission to review (from get_task)."),
    approve: z.boolean().describe("true = proof meets criteria → capture one unit; false = reject (slot reopens)."),
    score: z.number().int().min(1).max(5).optional().describe("Rating of the human's work (1–5)."),
    comment: z.string().max(280).optional().describe("Optional feedback note on the human."),
    reject_reason: z.string().max(1000).optional().describe("Why the proof was rejected (approve:false)."),
}, async ({ submission_id, approve, score, comment, reject_reason }) => guard(() => client.rest("POST", `/api/submissions/${submission_id}/review`, {
    body: {
        approve,
        ...(score != null ? { score } : {}),
        ...(comment ? { comment } : {}),
        ...(reject_reason ? { reject_reason } : {}),
    },
})));
server.tool("close_task", "Close a (multi-unit) bounty (poster-only): refund every still-held unit to the agent, mark unclaimed units done, and stop further claims. Idempotent on an already-closed task.", { task_id: z.string().uuid() }, async ({ task_id }) => guard(() => client.rest("POST", `/api/tasks/${task_id}/close`)));
// ---- Self-onboarding prompt -----------------------------------------------
// Surfaces as /mcp__cyberdyne__quickstart — the agent (or user) runs it once to
// learn the end-to-end campaign flow without reading docs. This is the "skill"
// shipped inside the MCP: guidance travels with the tools.
server.registerPrompt("quickstart", {
    title: "CYBERDYNE quickstart",
    description: "How to fund, post a task, and pay humans end-to-end — both the direct-hire and pool/FCFS flows.",
}, () => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    "You are connected to CYBERDYNE — hire and pay verified humans for tasks AI can't do alone. The live settlement rail is REAL USDC on Base (custodial: deposit -> escrow -> withdraw). The human submit-proof step is human-only, in the app; you drive everything else.",
                    "",
                    "FUND (real money, custodial rail):",
                    "1. get_deposit_address -> the platform deposit address on Base.",
                    "2. Send USDC to it FROM your own verified wallet (the one you signed in with).",
                    "3. deposit({ tx_hash }) -> credits your treasury by the verified amount (idempotent).",
                    "   (fund_treasury is demo/testnet only and is disabled on the live rail.)",
                    "Check get_treasury anytime for your balance.",
                    "",
                    "FLOW A - DIRECT HIRE (works today): pick one human, hold, then pay.",
                    "4. post_task({ title, category, reward_usd, duration_min, difficulty }). Returns { task }. Use reward_usd >= 0.50 so the 2.5% fee is visible; each unit must be >= $0.01.",
                    "5. search_humans({ skills, min_reputation }) -> assign_task({ task_id, human_id }) -> authorize_task({ task_id }) to open the escrow hold (custodial rail = no signature; just task_id).",
                    "6. Poll get_task until a submission is pending (the human's proof).",
                    "7. release_payment({ task_id, approve: true, score }) -> CAPTURE: net USDC to the human, the 2.5% fee to the protocol wallet. approve:false rejects and refunds the hold.",
                    "",
                    "FLOW B - POOL / FCFS BOUNTY: one frozen budget, many humans claim+submit first-come-first-served. NOTE: this non-custodial pool rail is BUILT but GATED OFF on the server today (pending certification) - real-money pool payouts are not live yet. When the operator enables it:",
                    "8. post_task({ ..., quantity: N }) -> returns { task, authIntent, deployFee }. authIntent is the budget authorization; deployFee is a SEPARATE non-refundable fee tx (2.5% USDC / 5% other token).",
                    "9. authorize_task({ task_id, auth_intent, deploy_fee }) -> with CYBERDYNE_EVM_PRIVATE_KEY set, the MCP signs the budget AND pays the deploy fee, then freezes the whole budget (or pass pre-made signed_payment + fee_tx_hash).",
                    "10. Humans claim+submit FCFS. Poll get_task; for each pending submission call review_submission({ submission_id, approve, score }) -> approve captures one unit; reject reopens the slot.",
                    "11. close_task({ task_id }) -> refund any still-unfilled units (the deploy fee is non-refundable).",
                    "",
                    "Every payout and fee on the live rail is a real on-chain transaction.",
                ].join("\n"),
            },
        },
    ],
}));
// ---- Boot -----------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`CYBERDYNE MCP server running on stdio → ${config.apiUrl}` +
    (config.token ? "" : " (no key — run `npx cyberdyne-mcp login cyb_…` or set CYBERDYNE_IDENTITY_TOKEN; networked tools error until then)") +
    ". Tools (13): list_categories, search_humans, get_treasury, fund_treasury, get_deposit_address, deposit, post_task, assign_task, authorize_task, get_task, release_payment, review_submission, close_task.");
