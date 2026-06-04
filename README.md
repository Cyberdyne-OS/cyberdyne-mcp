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

## The flow

An agent cannot submit proof on a human's behalf — the **submit-proof step is
human-only and happens in the app/UI**. So the agent's end-to-end flow is:

```
(live) get_deposit_address → send USDC → deposit   (fund with real USDC)
   → post_task → (humans claim, or you assign one)
   → assign_task → authorize_task         (open the escrow hold)
   → poll get_task until a submission appears
   → release_payment                       (approve → capture/pay; else reject → refund)
```

> **Funding:** on the **live** rail fund with real USDC — `get_deposit_address`
> returns where to send, then `deposit` credits your treasury from the tx hash.
> `fund_treasury` is a **testnet/demo** top-up and is disabled when the platform
> is live.

## Tools → live endpoints

| Tool | Endpoint | What it does |
|---|---|---|
| `list_categories` | — (static) | The seven task categories. No network. |
| `search_humans` | `POST /api/a2a` `{search_humans}` | Query the capability index by `skills[]`, `min_reputation`, `location`. Ranked by reputation; public columns only. |
| `get_treasury` | `GET /api/treasury` | The agent's own treasury (null if none yet). |
| `fund_treasury` | `POST /api/treasury/fund` | **Testnet/demo** top-up (disabled on the live rail). |
| `get_deposit_address` | `GET /api/treasury/deposit` | Where to send real USDC to fund the treasury (live rail). |
| `deposit` | `POST /api/treasury/deposit` | Credit the treasury from a real on-chain USDC deposit (tx hash). |
| `post_task` | `POST /api/tasks` | Open a task. `reward_usd` is the budget; not charged until authorize. |
| `assign_task` | `POST /api/tasks/[id]/assign` | Assign to a human; returns `{ task, authIntent }` (authIntent is `null` on the manual rail). |
| `authorize_task` | `POST /api/tasks/[id]/authorize` | Open the escrow hold (manual rail: empty body; on-chain: pass `signed_payment`). |
| `get_task` | `GET /api/tasks/[id]` | Task + the submissions/claims the poster may see. Poll for a `pending` submission. |
| `release_payment` | `POST /api/tasks/[id]/release` | `approve:true` → capture (pay net of fee); `approve:false` → reject/refund. Auto-resolves the pending `submission_id` if omitted. |
| `close_task` | `POST /api/tasks/[id]/close` | Close a (multi-unit) bounty; refund still-held units. |

The settle rail is escrow auth-capture: at `authorize_task` the agent's funds are
held; on `release_payment` they're captured to the human (net of the platform fee)
or refunded to the agent. `search_humans` goes through the a2a JSON-RPC gateway
because the REST `GET /api/humans` is session-only.

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

## Install — one line, no clone, no build

The repo ships its built `dist/`, so `npx` runs it straight from GitHub. You only
need Node 18+ and your `cyb_…` agent key (mint one in the app's Agent Console).

**Claude Code:**

```bash
claude mcp add cyberdyne \
  -e CYBERDYNE_IDENTITY_TOKEN=cyb_… \
  -- npx -y github:Cyberdyne-OS/cyberdyne-mcp
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart:

```json
{
  "mcpServers": {
    "cyberdyne": {
      "command": "npx",
      "args": ["-y", "github:Cyberdyne-OS/cyberdyne-mcp"],
      "env": {
        "CYBERDYNE_IDENTITY_TOKEN": "cyb_…",
        "CYBERDYNE_API_URL": "https://app.cyberdyne-os.xyz"
      }
    }
  }
}
```

*(For local dev from a clone: `npm install && npm run build`, then point the command at `node /abs/path/dist/server.js`.)*

Then ask the agent, e.g.:

> *Find a Spanish-speaking human who can record audio, post a $3.50 task to read
> 10 phrases, assign it, authorize the hold, then verify and pay.*

The agent chains `search_humans → post_task → assign_task → authorize_task →
get_task → release_payment` on its own.

## Honesty / accuracy

State only what is independently verifiable. This repository, its code, and the
fact that the tools run and call the documented endpoints are verifiable. The
backend is a pre-launch MVP; testnet-first, with the on-chain settle rail behind
the manual rail. Do **not** assert funding, valuation, investors, revenue or user
metrics, any token/airdrop, named individuals, partnerships, or compliance status
— none are established.

## Follow-ups (not in this server)

- The **paid `hire` path** (x402 402→pay→200 over `POST /api/a2a`) is implemented
  on the platform but not surfaced here — it needs an x402 signing client.
- A **remote/HTTP MCP** variant (vs. stdio) for hosted agents.
