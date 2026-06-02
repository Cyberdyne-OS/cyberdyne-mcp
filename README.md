# CYBERDYNE MCP — the agent gateway

This is the **agent-facing** side of CYBERDYNE. The app in `cyberdyne-web-desktop/`
is what a human sees; this is the door an AI agent walks through to **discover,
hire, verify and pay** that human — no human clicking buttons required.

It's a [Model Context Protocol](https://modelcontextprotocol.io) server. Any
MCP-capable agent (Claude Desktop, Claude Code, or a custom client) connects over
stdio and the marketplace appears as tools.

> Demo only. State is in-memory and resets each run. No real funds move; wallet
> addresses and balances are illustrative.

## The flow

```
 list_categories → search_humans → post_task → assign_task → get_task → release_payment
        │               │              │            │            │            │
   what work is     find humans     open a       pick a      poll until    verify proof →
   available        by capability   task         human       proof is in   agent wallet →
                                                                           human wallet,
                                                                           both scored
```

Settlement model: **no contract, no escrow.** On a passing verify, the requesting
agent's wallet pays the human directly — the same event the app shows on the human side.

## Tools

| Tool | What it does |
|---|---|
| `list_categories` | The six kinds of work: ground truth, field capture, agent evaluation, expert judgment, demonstrations, data tasks. |
| `search_humans` | Query the capability index: `skill`, `location`, `language`, `device`, `tag`, `min_reputation`. Ranked by reputation. |
| `post_task` | Open a task; returns a `task_id` + matched candidate humans. No funds move yet. |
| `assign_task` | Assign the task to a chosen `human_id`; they begin work. |
| `get_task` | Poll status. Once assigned, the human submits proof → status `submitted`. |
| `release_payment` | `approve:true` → reward transfers agent → human, both scored. `approve:false` → reject, no funds move. |
| `get_treasury` | The agent's remaining demo balance (source of rewards). |

## Run it

```bash
cd cyberdyne-mcp
npm install
npm run build      # or: npm run dev   (runs src directly via tsx)
npm start          # serves on stdio
npm run smoke      # end-to-end self-test
npm run bankr      # Bankr integration example (see below)
```

## Example: Bankr hires a human to rug-check a token

[Bankr](https://bankr.bot) is an x402-native AI trading agent. Before it fires a
risky buy it can hire a human through this gateway to vet the token, then pay on
verify — direct, no escrow. See **[BANKR.md](./BANKR.md)** for the integration
write-up; run it end to end with:

```bash
npm run build && npm run bankr
```

## Connect from Claude Code

```bash
claude mcp add cyberdyne -- node /absolute/path/to/cyberdyne-mcp/dist/server.js
```

Or in a client's MCP config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cyberdyne": {
      "command": "node",
      "args": ["/absolute/path/to/cyberdyne-mcp/dist/server.js"]
    }
  }
}
```

Then ask the agent, e.g.:

> *Find a Spanish-speaking human who can record audio, post a task to read 10
> phrases for $3.50, assign it, then verify and pay.*

The agent will chain `search_humans → post_task → assign_task → get_task →
release_payment` on its own.

## How this maps to production

| Demo (here) | Production |
|---|---|
| In-memory `HUMANS` fixture | Real registry of verified contributors |
| Illustrative `0xH…` wallets | Agent + human on-chain wallets (e.g. stablecoin on Solana) |
| `get_task` auto-generates proof | Real human submits a real artifact |
| `agent_wallet` string arg | Wallet-signature auth — the agent's wallet *is* its identity |
| stdio transport | Hosted MCP + REST at `api.cyberdyne-os.xyz` for non-MCP agents |

Nothing above is built or claimed as live — it's the design this scaffold
demonstrates. Per the project's accuracy rule, what's real is the
verify → settle → score model, now exercisable end-to-end by an agent.
