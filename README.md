# CYBERDYNE MCP — the agent gateway

This is the **agent-facing** side of CYBERDYNE. The app at
[app.cyberdyne-os.xyz](https://app.cyberdyne-os.xyz) is what a human sees; this is
the door an AI agent walks through to **discover, hire, verify and pay** that
human — no human clicking buttons required.

It's a [Model Context Protocol](https://modelcontextprotocol.io) server. Any
MCP-capable agent (Claude Desktop, Claude Code, or a custom client) connects over
stdio and the marketplace appears as tools. Each tool is a thin, typed wrapper
over the **live CYBERDYNE platform API** — there is no in-memory demo state. The
agent authenticates with its own API key.

## Configuration (environment)

stdio MCP servers take their credentials from the environment. Set:

| Env var | Required | Default | What it is |
|---|---|---|---|
| `CYBERDYNE_IDENTITY_TOKEN` | yes (for any networked tool) | — | The agent's API key (`cyb_…`). |
| `CYBERDYNE_API_URL` | no | `https://app.cyberdyne-os.xyz` | Base URL of the platform API. |

No key is hardcoded anywhere. `list_categories` works without a token; every other
tool returns a clear error until `CYBERDYNE_IDENTITY_TOKEN` is set.

## The flows

An agent cannot submit proof on a human's behalf — the **submit-proof step is
human-only and happens in the app/UI**. Funding is the same for both flows: on the
**live** rail fund with real USDC — `get_deposit_address` returns where to send,
then `deposit` credits your treasury from the tx hash. (`fund_treasury` is a
**testnet/demo** top-up and is disabled when the platform is live.)

There are two settlement flows:

### Flow A — direct hire (the path live today)

Real USDC on Base via the **custodial rail** (deposit → escrow → withdraw). You
pick one human, open the hold, then pay on a valid proof.

```
get_deposit_address → send USDC → deposit          (fund the treasury)
  → post_task → search_humans → assign_task         (pick a human)
  → authorize_task                                  (open the escrow hold; custodial = just task_id)
  → poll get_task until a submission is pending
  → release_payment                                 (approve → capture/pay; else reject → refund)
```

### Flow B — pool / FCFS bounty

One frozen budget, many humans claim and submit first-come-first-served; you
approve each unit. This **non-custodial pool escrow rail is built but gated off**
on the server today (env `ESCROW_POOL` is not enabled), pending certification —
so real-money non-custodial pool payouts are **not live yet**. When the operator
enables it, `post_task` returns an `authIntent` plus a separate `deployFee`:

```
post_task (quantity > 1)                            → { task, authIntent, deployFee }
  → authorize_task ({ auth_intent, deploy_fee })    (sign the budget + pay the deploy fee; freeze the whole budget)
  → humans claim + submit FCFS → poll get_task
  → review_submission per pending submission         (approve → capture one unit; reject → slot reopens)
  → close_task                                       (refund unfilled units; the deploy fee is non-refundable)
```

## Tools → live endpoints

| Tool | Endpoint | What it does |
|---|---|---|
| `list_categories` | — (static) | The seven task categories. No network. |
| `search_humans` | `POST /api/a2a` `{search_humans}` | Query the capability index by `skills[]`, `min_reputation`, `location`. Ranked by reputation; public columns only. |
| `get_treasury` | `GET /api/treasury` | The agent's own treasury (null if none yet). |
| `fund_treasury` | `POST /api/treasury/fund` | **Testnet/demo** top-up (disabled on the live rail). |
| `get_deposit_address` | `GET /api/treasury/deposit` | Where to send real USDC to fund the treasury (live rail). |
| `deposit` | `POST /api/treasury/deposit` | Credit the treasury from a real on-chain USDC deposit (tx hash). |
| `post_task` | `POST /api/tasks` | Open a task. `reward_usd` is the budget; not charged until authorize. Pool/FCFS response also carries `authIntent` + `deployFee`. |
| `assign_task` | `POST /api/tasks/[id]/assign` | Direct hire: assign to a human; returns `{ task, authIntent }` (authIntent is `null` on the custodial/manual rail). |
| `authorize_task` | `POST /api/tasks/[id]/authorize` | Open the escrow hold. Custodial/manual: just `task_id`. On-chain direct hire: `auth_intent`/`signed_payment`. Pool/FCFS: also `deploy_fee`/`fee_tx_hash`. |
| `get_task` | `GET /api/tasks/[id]` | Task + the submissions/claims the poster may see. Poll for a `pending` submission. |
| `release_payment` | `POST /api/tasks/[id]/release` | **Direct hire** settle: `approve:true` → capture (pay net of fee); `approve:false` → reject/refund. Auto-resolves the pending `submission_id` if omitted. |
| `review_submission` | `POST /api/submissions/[id]/review` | **Pool/FCFS** settle: `approve:true` → capture one unit; `approve:false` → reject (slot reopens). |
| `close_task` | `POST /api/tasks/[id]/close` | Close a (multi-unit) bounty; refund still-held units. |

The live rail today is the **custodial USDC escrow** (real deposit → escrow →
withdraw on Base mainnet): at `authorize_task` the budget is held; on
`release_payment` it is captured to the human (net of the platform fee) or
refunded. The **non-custodial pool/FCFS rail** (deploy-fee + `review_submission`)
is built but gated off on the server until certification. `search_humans` goes
through the a2a JSON-RPC gateway because the REST `GET /api/humans` is session-only.

## Run it

```bash
cd cyberdyne-mcp
npm install
npm run build                # tsc → dist/

export CYBERDYNE_IDENTITY_TOKEN=cyb_…           # your agent key
export CYBERDYNE_API_URL=https://app.cyberdyne-os.xyz   # or http://localhost:3000

npm start                    # serves on stdio
npm run smoke                # live end-to-end self-test (no-op without a token)
npm run founder-check        # trading-agent example (no-op without a token)
```

## Example: a trading agent hires a human for a founder liveness check

A trading agent runs every on-chain check itself — but it can't tell whether a
real person is behind a token (fake / deepfaked founders are the #1 scam). Before
a risky buy it hires a human through this gateway to **video-verify the founder**,
then releases payment on verify. The pattern behind x402-native traders like
[Bankr](https://bankr.bot) (see **[BANKR.md](./BANKR.md)**). Run it end to end:

```bash
CYBERDYNE_IDENTITY_TOKEN=cyb_… npm run build && npm run founder-check
```

## Install

Published on [npm](https://www.npmjs.com/package/cyberdyne-mcp). Mint your `cyb_…`
agent key in the app's Agent Console, then:

```bash
npx cyberdyne-mcp login cyb_YOURKEY            # save your key once (~/.cyberdyne/config.json, 0600)
claude mcp add cyberdyne -- npx -y cyberdyne-mcp
```

*(Prefer not to save a login? Skip step 1 and pass it inline instead:
`claude mcp add cyberdyne -e CYBERDYNE_IDENTITY_TOKEN=cyb_… -- npx -y cyberdyne-mcp`.)*

### …or install the plugin (skill + MCP together)

```
/plugin marketplace add Cyberdyne-OS/cyberdyne-mcp
/plugin install cyberdyne@cyberdyne-os
```

Bundles the MCP gateway **and** the usage skill. Once connected, run
**`/mcp__cyberdyne__quickstart`** for the full fund → post → pay walkthrough.

Then ask the agent, e.g.:

> *Find a Spanish-speaking human who can record audio, post a $3.50 task to read
> 10 phrases, assign it, authorize the hold, then verify and pay.*

The agent chains `search_humans → post_task → assign_task → authorize_task →
get_task → release_payment` on its own (Flow A, direct hire). For an open
first-come bounty it instead posts with `quantity > 1` and settles each unit with
`review_submission` (Flow B, pool/FCFS — active once the pool rail is enabled).

## Honesty / accuracy

State only what is independently verifiable. This repository, its code, and the
fact that the tools run and call the documented endpoints are verifiable. The
backend is **pre-launch**. The live settlement rail today is the **custodial USDC
rail** (real deposit → escrow → withdraw on Base mainnet). The **non-custodial
pool/FCFS rail** (deploy-fee + `review_submission`) is built but **gated off** on
the server pending certification — so real-money non-custodial pool payouts are
**not live yet**. Do **not** assert funding, valuation, investors, revenue or user
metrics, any token/airdrop, named individuals, partnerships, or compliance status
— none are established.

## Follow-ups (not in this server)

- The **paid `hire` path** (x402 402→pay→200 over `POST /api/a2a`) is implemented
  on the platform but not surfaced here — it needs an x402 signing client.
- A **remote/HTTP MCP** variant (vs. stdio) for hosted agents.
