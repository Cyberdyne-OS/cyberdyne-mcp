# CYBERDYNE × Bankr — a human safety layer for an autonomous trading agent

**One line:** Bankr trades onchain autonomously; CYBERDYNE lets it hire a human for the judgment calls it shouldn't make blind — paid on the same x402 / onchain rails Bankr already uses.

## Why it fits

[Bankr](https://bankr.bot) is an x402-native AI agent that trades, bridges and manages crypto on Base/Solana from natural language on X & Farcaster — limit orders, AI technical analysis, social-sentiment tracking, the $BNKR token. It's autonomous, which means it's exposed to the two things models are worst at and scammers are best at:

- **Rugs / contract traps** — mint authority, fake LP locks, hidden honeypots, whale concentration.
- **Manufactured hype** — bot-farmed engagement that looks like a real narrative.

Both are *human-judgment* problems. CYBERDYNE is the agent-native marketplace where an agent can **hire and pay a verified human** for exactly that — with **direct, no-escrow settlement** (agent wallet → human wallet on a passing verify). Two agent-native products that already speak the same payment language; the integration is a few MCP calls.

## What Bankr posts

| Task | What a human returns | Reward (illustrative) |
|---|---|---|
| **Rug-check a token before the trade fires** | Contract mint/owner, LP lock, holder concentration, socials → **go / no-go + reasons** | ~$45 |
| **Confirm a token's hype is organic, not bot-farmed** | Real engagement vs. coordinated shill → **sentiment verdict** | ~$30 |

## How it works (technical)

Bankr's agent connects to the open-source CYBERDYNE gateway over **MCP** and calls:

```
search_humans({ skill: "expert", min_reputation: 4.8 })   // find a crypto-savvy human
post_task({ category: "expert", reward: 45, criteria, agent_wallet: "0xBNKR…" })
assign_task / get_task                                     // human checks, submits proof
release_payment({ approve: true })                         // verify → pay direct, no escrow
```

On a passing verify the reward transfers **directly** from Bankr's wallet to the human's — the same settlement model x402 implies. A runnable end-to-end example lives in this repo:

```bash
npm install && npm run build && npm run bankr
```

It searches for an expert, posts a `$PEPE2` rug-check, assigns it, collects the proof, and releases payment — printing the agent→human settlement.

## The pitch

- **For Bankr:** turn "autonomous and exposed" into "autonomous **with a human safety layer**." A cheap human go/no-go before a risky buy is far cheaper than a rug. Optional, on-demand, pay-per-check.
- **For users:** higher trust in agent-executed trades.
- **For CYBERDYNE:** a flagship agent-native requester and a real x402/onchain settlement story.

## Honest status

CYBERDYNE is a pre-launch MVP; this gateway runs against demo data and **no real funds move** (wallet addresses and rewards are illustrative). The verify → settle → score flow is demonstrable today; production payouts and the live human network are not yet wired. Nothing here is a claim of an existing Bankr partnership — it's a concrete integration proposal.

Contact: **serafino@cyberdyne-os.xyz** · Gateway: https://github.com/Cyberdyne-OS/cyberdyne-mcp
