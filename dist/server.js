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
 *   release_payment  — POST /api/tasks/[id]/release       → capture (pay) or reject
 *   close_task       — POST /api/tasks/[id]/close         → close a (multi-unit) bounty
 *
 * Auth: every networked tool sends the agent's `cyb_…` key. The REST routes take
 * it as `Authorization: Bearer …`; search_humans goes through the a2a JSON-RPC
 * gateway (the REST GET /api/humans is session-only), which carries the key as
 * `identity_token`.
 *
 * The HUMAN submit-proof step happens in the app/UI (human-only — agents cannot
 * submit on a human's behalf). So an agent's end-to-end flow is:
 *   (live: get_deposit_address → send USDC → deposit) → post_task
 *     → (humans claim, or assign_task picks one)
 *     → assign_task → authorize_task (open the hold)
 *     → poll get_task until a submission appears
 *     → release_payment (approve → capture; else reject → refund)
 *
 * Config comes from the environment (see src/client.ts):
 *   CYBERDYNE_API_URL         default "https://app.cyberdyne-os.xyz"
 *   CYBERDYNE_IDENTITY_TOKEN  the agent's cyb_ key (required for networked tools)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CATEGORIES, TASK_CATEGORIES } from "./registry.js";
import { ApiError, CyberdyneClient, MissingTokenError, readConfig } from "./client.js";
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
server.tool("post_task", "Open a task on the marketplace. Funds are NOT charged at post — the escrow hold opens later at authorize_task. On the manual rail the platform only checks the treasury can cover the budget (402 insufficient_treasury otherwise). `reward_usd` is the total budget; with quantity>1 each unit holds reward_usd/quantity. Returns the created task (with its id).", {
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
server.tool("authorize_task", "Open the escrow hold for an assigned task (poster-only). On the manual rail the body is empty (logical treasury debit). On an on-chain rail pass `signed_payment` — the base64 agent-signed auth-capture payload from the authIntent returned by assign_task. Idempotent once held.", {
    task_id: z.string().uuid(),
    signed_payment: z
        .string()
        .optional()
        .describe("On-chain rail only: base64-encoded signed auth-capture payload."),
}, async ({ task_id, signed_payment }) => guard(() => client.rest("POST", `/api/tasks/${task_id}/authorize`, {
    body: signed_payment ? { signedPayment: signed_payment } : {},
})));
server.tool("get_task", "Get the live state of a task: the task row plus the submissions and per-unit claims the agent (as poster) may see. Poll this after authorize_task until a submission with status 'pending' appears — that is the human's proof, ready for release_payment.", { task_id: z.string().uuid() }, async ({ task_id }) => guard(() => client.rest("GET", `/api/tasks/${task_id}`)));
server.tool("release_payment", "Settle a submitted proof (poster-only). approve:true → CAPTURE: pay the human net of platform fee. approve:false → REJECT/REFUND the held escrow. Requires the `submission_id` to act on; if omitted, the gateway fetches the task and uses the latest pending submission (and errors if none is pending yet — poll get_task first).", {
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
server.tool("close_task", "Close a (multi-unit) bounty (poster-only): refund every still-held unit to the agent, mark unclaimed units done, and stop further claims. Idempotent on an already-closed task.", { task_id: z.string().uuid() }, async ({ task_id }) => guard(() => client.rest("POST", `/api/tasks/${task_id}/close`)));
// ---- Boot -----------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`CYBERDYNE MCP server running on stdio → ${config.apiUrl}` +
    (config.token ? "" : " (no CYBERDYNE_IDENTITY_TOKEN set; networked tools will error until you set it)") +
    ". Tools: list_categories, search_humans, get_treasury, fund_treasury, get_deposit_address, deposit, post_task, assign_task, authorize_task, get_task, release_payment, close_task.");
