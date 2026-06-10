/**
 * Bankr-style convenience CLI for CYBERDYNE — `post` / `tasks`.
 *
 * These are ADDITIONAL command-line entry points (not MCP tools). They run, print
 * a human-readable summary to stderr, and exit — exactly like `onboard`/`login`.
 * They mirror the Bankr CLI UX (`bankr fees`, `bankr launch`): a single command
 * that does the full thing autonomously using the saved `cyb_` key + wallet.
 *
 *   post                           — open a task; on the pool rail, sign + pay +
 *                                    authorize in one shot (bankr launch)
 *   tasks                          — list your own posted tasks with status
 *
 * Networking reuses CyberdyneClient (the saved Bearer key); pool signing/fee
 * payment reuses src/evm-signer.ts — no signing logic is reinvented here.
 */
import { CyberdyneClient, readConfig, ApiError, MissingTokenError } from "./client.js";

// ── tiny argv parser ───────────────────────────────────────────────────────
// Supports `--flag value` and `--flag=value`. Bare `--flag` (no value) ⇒ "true".
export function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[body] = next;
      i++;
    } else {
      out[body] = "true";
    }
  }
  return out;
}

function client(): CyberdyneClient {
  return new CyberdyneClient(readConfig());
}

function hasKey(): boolean {
  return !!readConfig().token;
}

const NO_KEY = "No CYBERDYNE key saved. Run:  npx -y cyberdyne-mcp onboard";

/** Format a USD-ish numeric value (handles string/number/null) to 2dp. */
function usd(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Map a thrown client error to a clean one-line message. */
function describe(e: unknown): string {
  if (e instanceof MissingTokenError) return NO_KEY;
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// ── post (bankr launch) ──────────────────────────────────────────────────────
// Open a task. Per-unit `--reward` × `--quantity` = the budget. On the pool rail
// (BNKR/GITLAWB/any dynamic token or quantity>1) the response carries authIntent +
// deployFee: sign the budget + pay the fee + authorize, all from the saved wallet.
export async function runPost(argv: string[]): Promise<void> {
  if (!hasKey()) fail(NO_KEY);
  const f = parseFlags(argv);

  const title = f.title?.trim();
  if (!title) fail("--title is required");
  const rewardPerUnit = Number(f.reward);
  if (!Number.isFinite(rewardPerUnit) || rewardPerUnit <= 0) fail("--reward <n> is required (per-unit, in the pay token)");

  // Pay token: a curated symbol (USDC / BNKR / GITLAWB) OR a 0x… address for a
  // DYNAMIC registry token — i.e. ANY Bankr-launched token that's been added to the
  // platform's token registry. The backend resolves + validates it (rejects unknown
  // symbols / unregistered or disabled addresses), so we pass it through verbatim.
  const rawTok = (f.token ?? "USDC").trim();
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(rawTok);
  const token = isAddr ? rawTok.toLowerCase() : rawTok.toUpperCase();

  const quantity = f.quantity != null ? Math.trunc(Number(f.quantity)) : 1;
  if (!Number.isFinite(quantity) || quantity < 1) fail("--quantity must be a positive integer");

  const category = (f.category ?? "social").trim();
  const action = f.action?.trim();
  const url = f.url?.trim();

  // Rail: default pool when token is a real ecosystem token (BNKR/GITLAWB) or it's
  // a multi-unit bounty; else custodial single-hold. `--rail` overrides.
  const railFlag = f.rail?.trim().toLowerCase();
  const rail =
    railFlag === "pool" || railFlag === "custodial"
      ? railFlag
      : token === "BNKR" || token === "GITLAWB" || isAddr || quantity > 1
        ? "pool"
        : "custodial";

  // reward_usd is the TOTAL budget (= per-unit × quantity). For non-USDC tokens this
  // figure is the TOKEN amount (the platform settles in-token on the pool rail).
  const reward_usd = Number((rewardPerUnit * quantity).toFixed(6));

  const body: Record<string, unknown> = {
    title,
    category,
    reward_usd,
    quantity,
    pay_token: token,
    rail,
  };
  if (category === "social" && action) body.social_action = action;
  if (category === "social" && url) body.social_target_url = url;

  const c = client();
  try {
    console.error(
      `→ posting "${title}"  (${rewardPerUnit} ${token} × ${quantity} = ${reward_usd} ${token}, ${rail} rail)…`,
    );
    const res = await c.rest<{
      task: { id: string; escrow_status?: string };
      authIntent?: { requirements?: unknown };
      deployFee?: { amount: number; decimals: number; usd: number; recipient: string; token: string };
    }>("POST", "/api/tasks", { body });
    const taskId = res.task?.id;
    console.error(`  ✓ posted — task ${taskId}`);

    // Custodial/testnet rail (no authIntent): nothing else to do; the hold opens later.
    if (!res.authIntent || !res.deployFee) {
      console.error(
        `\n✓ Task ${taskId} is open. Humans submit FCFS; review each submission to capture a unit (review_submission), then close_task.`,
      );
      process.exit(0);
    }

    // POOL rail — the autonomous `bankr launch` path. Sign the budget with the saved
    // wallet, pay the separate deploy fee, then authorize. Reuses evm-signer (the
    // exact logic the authorize_task MCP tool uses).
    const { hasEvmKey, signAuthCapture, payDeployFee } = await import("./evm-signer.js");
    if (!hasEvmKey()) {
      fail(
        "pool rail needs a signing wallet, but none is saved. Run `npx -y cyberdyne-mcp onboard` " +
          `(the task ${taskId} is posted but not yet funded).`,
      );
    }

    const requirements =
      (res.authIntent as { requirements?: unknown }).requirements ?? res.authIntent;
    console.error("→ signing the budget authorization…");
    const signedPayment = await signAuthCapture(requirements);

    const fee = res.deployFee;
    // `fee.amount` is in the FEE TOKEN's own units; for non-USDC tokens `fee.usd` is the
    // token amount (no oracle), so DON'T render it as a "$" — just show the token amount.
    console.error(`→ paying the deploy fee (${fee.amount} of ${String(fee.token).slice(0, 10)}…) from your wallet…`);
    const feeTx = await payDeployFee({ amount: fee.amount, decimals: fee.decimals, recipient: fee.recipient, token: fee.token });
    console.error(`  ✓ fee paid — ${feeTx}`);

    console.error("→ freezing the budget (authorize)…");
    const authed = await c.rest<{ task?: { escrow_status?: string } }>(
      "POST",
      `/api/tasks/${taskId}/authorize`,
      { body: { signedPayment, fee_tx_hash: feeTx } },
    );
    const escrow = authed.task?.escrow_status ?? "held";
    console.error(
      `\n✓ Launched. task ${taskId} — escrow_status: ${escrow}. ` +
        "Humans can now claim + submit FCFS; review each submission to capture a unit.",
    );
    process.exit(0);
  } catch (e) {
    fail(describe(e));
  }
}

// ── tasks ─────────────────────────────────────────────────────────────────
// List the agent's own posted tasks (GET /api/tasks?mine=posted — works with the
// agent key). Short: id, title, token, qty, filled/remaining, status.
export async function runTasks(): Promise<void> {
  if (!hasKey()) fail(NO_KEY);
  const c = client();
  try {
    const { tasks } = await c.rest<{ tasks: Array<Record<string, unknown>> }>("GET", "/api/tasks", {
      query: { mine: "posted", limit: 50 },
    });
    if (!tasks || tasks.length === 0) {
      console.error("No posted tasks yet. Post one:  npx -y cyberdyne-mcp post --title \"…\" --reward 1");
      process.exit(0);
    }
    const lines = [`Your posted tasks (${tasks.length}):`];
    for (const t of tasks) {
      const qty = Number(t.quantity ?? 1) || 1;
      // The captured-slots column is `slots_filled` (migration 035) — NOT filled_count/
      // captured_count (which don't exist, so the old read was always 0 → always "0/qty").
      const filled = Number(t.slots_filled ?? 0) || 0;
      const remaining = Math.max(qty - filled, 0);
      const token = String(t.pay_token ?? "USDC");
      const status = String(t.escrow_status ? `${t.status}/${t.escrow_status}` : t.status ?? "—");
      const id = String(t.id ?? "—");
      const title = String(t.title ?? "").slice(0, 40);
      lines.push(
        `  ${id}  ${title.padEnd(40)}  ${token.padEnd(7)}  qty ${qty}  filled ${filled}/${qty} (rem ${remaining})  ${status}`,
      );
    }
    console.error(lines.join("\n"));
    process.exit(0);
  } catch (e) {
    fail(describe(e));
  }
}
