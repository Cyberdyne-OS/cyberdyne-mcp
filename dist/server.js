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
 *   post_task        — POST /api/tasks                    → open an FCFS pool bounty
 *   authorize_task   — POST /api/tasks/[id]/authorize     → sign budget + pay fee + freeze
 *   get_task         — GET  /api/tasks/[id]               → status + submissions/claims
 *   review_submission — POST /api/submissions/[id]/review → approve (pay one unit) / reject (reopen)
 *   close_task       — POST /api/tasks/[id]/close         → refund the unfilled budget (operator voids)
 *   reclaim          — on-chain reclaim(paymentInfo)      → trustless self-recovery, payer-only, no operator
 *
 * Auth: every networked tool sends the agent's `cyb_…` key. The REST routes take
 * it as `Authorization: Bearer …`; search_humans goes through the a2a JSON-RPC
 * gateway (the REST GET /api/humans is session-only), which carries the key as
 * `identity_token`.
 *
 * The HUMAN submit-proof step happens in the app/UI (human-only — agents cannot
 * submit on a human's behalf). There is ONE settlement model for real tokens:
 *
 *   FCFS POOL BOUNTY (non-custodial pool escrow). There is NO direct hire and NO
 *   agent-picks-human. EVERY task is an open bounty: the agent freezes a budget once,
 *   ANY eligible human submits first-come-first-served, and the agent approves/rejects
 *   each submission — approved pays one unit in-token, rejected reopens the slot, and
 *   any unfilled budget is refunded on close. The agent funds the budget directly
 *   from its OWN wallet at deploy (non-custodial) — there is no platform treasury.
 *       post_task({ ..., quantity }) → returns { task, authIntent, deployFee }
 *       → authorize_task({ task_id, auth_intent, deploy_fee })  (sign budget + pay fee + freeze)
 *       → humans submit FCFS → poll get_task
 *       → review_submission per pending submission (approve → pay one unit;
 *         reject → the slot reopens)
 *       → close_task to refund the unfilled budget.
 *
 *   TRUSTLESS BACKSTOP: `reclaim` lets the agent recover its OWN unfilled budget
 *   DIRECTLY from the audited escrow as the payer — no CYBERDYNE operator involved.
 *   After the authorization deadline, even if the operator is down, the agent calls
 *   reclaim(paymentInfo) itself. This is the deepest non-custodial guarantee.
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
import { onboard, onboardCli, nextStepsText } from "./onboard.js";
// `cyberdyne-mcp onboard` — FULLY AUTONOMOUS, zero-browser bootstrap (Bankr-style).
// IMPORT or CREATE a wallet, mint a cyb_ API key via SIWE, save both to
// ~/.cyberdyne/config.json (0600), print the summary, then exit. No web dashboard.
//   --import <0xKEY | mnemonic>  bring your OWN wallet (or pipe it / CYBERDYNE_IMPORT_KEY)
//   --create                     generate a fresh wallet (default in non-TTY/CI)
//   (no flag, interactive TTY)   prompt: paste a key/mnemonic, or enter to create
if (process.argv[2] === "onboard") {
    try {
        const r = await onboardCli(process.argv.slice(3));
        const mode = r.generated ? "GENERATED" : r.imported ? "IMPORTED" : "loaded";
        console.error(`✓ CYBERDYNE agent onboarded — wallet ${mode} + API key minted.\n` +
            `\n  wallet address : ${r.address}` +
            `\n  API key (cyb_) : ${r.apiKey}    ← shown once; saved to ${r.configPath}` +
            (r.generated
                ? `\n  (a fresh wallet private key was generated and saved to ${r.configPath}; keep that file safe)`
                : r.imported
                    ? `\n  (your imported wallet private key was saved to ${r.configPath}; keep that file safe)`
                    : "") +
            `\n\n${nextStepsText()}` +
            `\n\nThis MCP is already configured for this agent — networked tools will use the saved key.`);
        process.exit(0);
    }
    catch (e) {
        console.error(`✗ onboard failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}
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
// Bankr-style convenience CLI subcommands (additional entry points, not MCP tools).
// Each runs autonomously with the saved key/wallet, prints a summary, and exits.
//   post                           — open a task; pool rail auto sign+pay+authorize (like `bankr launch`)
//   tasks                          — list your own posted tasks with status
if (process.argv[2] === "post") {
    const { runPost } = await import("./cli.js");
    await runPost(process.argv.slice(3));
}
if (process.argv[2] === "tasks") {
    const { runTasks } = await import("./cli.js");
    await runTasks();
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
const server = new McpServer({ name: "cyberdyne", version: "0.6.6" });
server.tool("list_categories", "List the kinds of real-world work CYBERDYNE humans can do. Static (no network). Use this to learn the valid `category` values before posting a task.", {}, async () => json(Object.entries(CATEGORIES).map(([id, blurb]) => ({ id, blurb }))));
server.tool("onboard", "BOOTSTRAP (works WITHOUT an existing key — the one tool that self-onboards). Zero-browser: generates a fresh wallet if you don't have one, signs in to CYBERDYNE with it (SIWE), mints your `cyb_` agent API key, and saves both to ~/.cyberdyne/config.json (0600) so every other tool here authenticates automatically. No web dashboard, no env vars. Returns your wallet address, the cyb_ key (shown once), and the next steps (fund your WALLET with USDC + a little ETH for gas on Base → post_task → authorize_task → review_submission → close_task). The non-custodial pool freezes the budget directly from your wallet at deploy — there is no platform treasury to deposit into. The same generated wallet auto-signs pool budgets. To bring your OWN wallet instead, use the CLI: `npx cyberdyne-mcp onboard --import <0xKEY | mnemonic>` (or --create for a fresh one). Idempotent-ish: re-running with a saved wallet reuses it and mints a fresh key.", {}, async () => guard(async () => {
    const r = await onboard();
    return {
        address: r.address,
        apiKey: r.apiKey,
        generated: r.generated,
        savedTo: r.configPath,
        next_steps: nextStepsText(),
        note: "API key + wallet saved (0600). This MCP now authenticates automatically; networked tools are ready.",
    };
}));
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
server.tool("post_task", "Open an FCFS pool bounty on the marketplace. There is NO direct hire and NO agent-picks-human — every task is an open bounty: you freeze a budget, ANY eligible human submits first-come-first-served, and you approve/reject each submission. Funds are NOT charged at post — the budget is frozen later at authorize_task. `reward_usd` is the total budget; `quantity` is how many identical units (humans) it pays — each unit holds reward_usd/quantity (each unit must be >= $0.01). Returns the created task (with its id) plus `authIntent` (the budget authorization to sign) and `deployFee` { usd, bps, recipient, token } (a SEPARATE non-refundable fee tx) — pass BOTH to authorize_task. The non-custodial POOL escrow (USDC/BNKR/GITLAWB on Base) is the only settlement rail; a non-real token (CYOS) or non-live config has no rail and returns 422 settlement_unavailable.", {
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
server.tool("authorize_task", "Freeze the bounty budget on-chain (the second step of the FCFS flow). REAL-TOKEN POOL rail: pass BOTH `auth_intent` (the authIntent from post_task) AND `deploy_fee` (the deployFee object from post_task) — with CYBERDYNE_EVM_PRIVATE_KEY set, the MCP signs the whole-budget authorization AND pays the separate 2.5% USDC / 5% other-token deploy fee tx from its wallet, then freezes the budget on the audited escrow; or pass a pre-signed `signed_payment` and a pre-paid `fee_tx_hash`. After this, any eligible human submits FCFS and you review_submission each. The non-custodial POOL escrow is the only rail; a non-real token / non-live config returns 409 settlement_unavailable. Idempotent once frozen.", {
    task_id: z.string().uuid(),
    signed_payment: z.string().optional().describe("Pre-signed base64 auth-capture payload (external/Bankr signer)."),
    auth_intent: z.unknown().optional().describe("The authIntent from post_task — required for MCP wallet auto-signing."),
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
server.tool("get_task", "Get the live state of a task: the task row plus the submissions and per-unit claims the agent (as poster) may see. Poll this after authorize_task until a submission with status 'pending' appears — that is the human's proof, ready for review_submission (approve pays one unit; reject reopens the slot).", { task_id: z.string().uuid() }, async ({ task_id }) => guard(() => client.rest("GET", `/api/tasks/${task_id}`)));
server.tool("review_submission", "THE settle tool (poster-only): approve or reject ONE submission on your FCFS pool bounty — this is how you pay humans (there is no direct hire). approve:true → CAPTURE one unit from the frozen budget to the human (full reward, in-token) and consume a slot; approve:false → reject (the slot reopens for the next submitter — no spot-blocking). Poll get_task for pending submissions and review each one. When the budget is consumed (or you're done) call close_task to refund the unfilled remainder.", {
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
server.tool("close_task", "Close your FCFS pool bounty (poster-only): refund the unfilled budget back to your wallet on-chain (the uncaptured remainder = unfilled units × per-unit reward) and stop further submissions. The deploy fee is non-refundable. Idempotent on an already-closed task. (close_task goes through CYBERDYNE's operator; if the operator is ever down, use `reclaim` to recover the budget yourself after the authorization deadline.)", { task_id: z.string().uuid() }, async ({ task_id }) => guard(() => client.rest("POST", `/api/tasks/${task_id}/close`)));
server.tool("reclaim", "Trustless self-recovery — if CYBERDYNE's operator is ever down, after the authorization deadline you can reclaim your unfilled budget directly from the audited escrow yourself, no platform involvement. This is the DEEPEST non-custodial guarantee: your MCP wallet (the payer) calls the audited AuthCaptureEscrow's payer-only `reclaim(paymentInfo)` ON-CHAIN itself — CYBERDYNE never touches it. Normally you close_task (operator voids the unfilled remainder back to you); reclaim is the backstop that needs no operator. Requirements: this MCP wallet MUST be the budget's payer (the wallet that froze it), and the on-chain authorizationExpiry must have passed (errors clearly if it's too early, already settled, or you're not the payer). Reads escrow_payment_info from GET /api/tasks/[id], reconstructs the exact PaymentInfo struct, signs+sends on Base, and waits for the receipt. Returns { ok, tx_hash, reclaimed }.", { task_id: z.string().uuid() }, async ({ task_id }) => guard(async () => {
    const task = await client.rest("GET", `/api/tasks/${task_id}`);
    const info = (task.escrow_payment_info ?? task.task?.escrow_payment_info);
    if (!info) {
        throw new Error("this task has no escrow_payment_info — it was never frozen on the non-custodial pool escrow, so there is nothing to reclaim on-chain.");
    }
    const { hasEvmKey, reclaimBudget } = await import("./evm-signer.js");
    if (!hasEvmKey()) {
        throw new Error("no signing wallet — reclaim is an on-chain call you make yourself. Set CYBERDYNE_EVM_PRIVATE_KEY or run `npx cyberdyne-mcp onboard` with the SAME wallet that froze the budget.");
    }
    return reclaimBudget(info);
}));
// ---- Self-onboarding prompt -----------------------------------------------
// Surfaces as /mcp__cyberdyne__quickstart — the agent (or user) runs it once to
// learn the end-to-end campaign flow without reading docs. This is the "skill"
// shipped inside the MCP: guidance travels with the tools.
server.registerPrompt("quickstart", {
    title: "CYBERDYNE quickstart",
    description: "How to fund, post an FCFS pool bounty, and pay verified humans end-to-end.",
}, () => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    "You are connected to CYBERDYNE — pay verified humans for tasks AI can't do alone. There is ONE model: every task is an open FCFS pool bounty. There is NO direct hire and NO picking a human — you freeze a budget, ANY eligible human submits first-come-first-served, and you approve/reject each submission (approved = paid one unit in-token, rejected = the slot reopens). The live settlement rail is REAL tokens on Base (non-custodial freeze-at-deploy). The human submit-proof step is human-only, in the app; you drive everything else.",
                    "",
                    "FUND: hold USDC (or BNKR/GITLAWB) + a little ETH for gas in your OWN wallet on Base. The pool freezes the budget directly from your wallet at deploy and pays the deploy fee from it — there is NO platform treasury to deposit into (fully non-custodial).",
                    "",
                    "POST + PAY (the single FCFS flow):",
                    "3. post_task({ title, category, reward_usd, quantity }) -> returns { task, authIntent, deployFee }. reward_usd is the TOTAL budget; quantity is how many humans it pays (each unit must be >= $0.01). authIntent is the whole-budget authorization; deployFee is a SEPARATE non-refundable fee tx (2.5% USDC / 5% other token).",
                    "4. authorize_task({ task_id, auth_intent, deploy_fee }) -> with CYBERDYNE_EVM_PRIVATE_KEY set, the MCP signs the budget AND pays the deploy fee, then FREEZES the whole budget on the audited escrow (or pass pre-made signed_payment + fee_tx_hash).",
                    "5. Any eligible human submits FCFS. Poll get_task; for EACH pending submission call review_submission({ submission_id, approve, score }) -> approve captures one unit (full reward to the human, in-token); reject reopens the slot for the next submitter.",
                    "6. close_task({ task_id }) -> refunds the unfilled budget back to your wallet (the deploy fee is non-refundable).",
                    "",
                    "TRUSTLESS BACKSTOP: close_task asks CYBERDYNE's operator to void the unfilled budget. If the operator is ever down, reclaim({ task_id }) is the non-custodial fallback — after the authorization deadline your own wallet (the payer) calls the audited escrow's payer-only reclaim() directly on-chain and recovers the budget with zero platform involvement.",
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
    (config.token ? "" : " (no key — run `npx cyberdyne-mcp onboard` to self-generate a wallet + key, or `login cyb_…`, or set CYBERDYNE_IDENTITY_TOKEN; networked tools error until then)") +
    ". Tools (9): onboard, list_categories, search_humans, post_task, authorize_task, get_task, review_submission, close_task, reclaim." +
    " CLI: onboard, login, post, tasks.");
