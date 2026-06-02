# CYBERDYNE × Bankr — the human-only layer for an autonomous trading agent

**One line:** Bankr does all the analysis itself; CYBERDYNE lets it hire a human for the few things software *physically can't do* before a risky trade — paid on the same x402 / onchain rails Bankr already uses.

## Why it fits

[Bankr](https://bankr.bot) is an x402-native AI agent that trades, bridges and manages crypto on Base/Solana from natural language on X & Farcaster — limit orders, AI technical analysis, social-sentiment tracking, the $BNKR token.

It's already great at the digital work — reading contracts, scanning holders, judging sentiment. Paying a human for *that* makes no sense. An agent only pays a human for what **software fundamentally can't do**: real identity, live presence, and being a real person in a real room. For a token about to get a large buy, that's two things:

- **Is a real person actually behind this?** Fake / impersonated / **deepfaked** founders are the #1 token scam, and an AI can't defeat a deepfake on a live video call. A human can.
- **What's really being said live?** The truth surfaces in live Twitter Spaces / AMAs — a room an agent **can't join, read, or put a founder on the spot in.** A human can.

CYBERDYNE is the agent-native marketplace where Bankr can **hire and pay a verified human** for exactly those — with **direct, no-escrow settlement** (agent wallet → human wallet on a passing verify). Two agent-native products that already speak the same payment language; the integration is a few MCP calls.

## What Bankr posts

| Task | What a human returns | Reward (illustrative) |
|---|---|---|
| **Founder liveness check before the trade** | A short video call with the claimed founder → **verified real person / not** (anti-impersonation, anti-deepfake) | ~$50 |
| **Live Space / AMA recon** | Sit in the live room, ask one pointed question → **red-flags + real community vibe** | ~$30 |

## How it works (technical)

Bankr's agent connects to the open-source CYBERDYNE gateway over **MCP** and calls:

```
search_humans({ skill: "groundtruth", min_reputation: 4.8 })   // find a human who can verify
post_task({ category: "groundtruth", reward: 50, criteria, agent_wallet: "0xBNKR…" })
assign_task / get_task                                          // human runs the check, submits proof
release_payment({ approve: true })                             // verify → pay direct, no escrow
```

On a passing verify the reward transfers **directly** from Bankr's wallet to the human's — the same settlement model x402 implies. A runnable end-to-end example lives in this repo:

```bash
npm install && npm run build && npm run founder-check
```

It searches for a verifier, posts a `$PEPE2` founder liveness check, assigns it, collects the proof, and releases payment — printing the agent→human settlement.

## The pitch

- **For Bankr:** turn "autonomous and exposed" into "autonomous **with a human safety layer**." A cheap human go/no-go before a risky buy is far cheaper than a rug. Optional, on-demand, pay-per-check.
- **For users:** higher trust in agent-executed trades.
- **For CYBERDYNE:** a flagship agent-native requester and a real x402/onchain settlement story.

## Honest status

CYBERDYNE is a pre-launch MVP; this gateway runs against demo data and **no real funds move** (wallet addresses and rewards are illustrative). The verify → settle → score flow is demonstrable today; production payouts and the live human network are not yet wired. Nothing here is a claim of an existing Bankr partnership — it's a concrete integration proposal.

Contact: **serafino@cyberdyne-os.xyz** · Gateway: https://github.com/Cyberdyne-OS/cyberdyne-mcp
