# CYBERDYNE × Bankr — the human-only layer for an autonomous trading agent

**One line:** Bankr does all the analysis itself; CYBERDYNE lets it hire a human for the few things software *physically can't do* before a risky trade — paid on the same x402 / onchain rails Bankr already uses.

## Why it fits

[Bankr](https://bankr.bot) is an x402-native AI agent that trades, bridges and manages crypto on Base/Solana from natural language on X & Farcaster — limit orders, AI technical analysis, social-sentiment tracking, the $BNKR token.

It's already great at the digital work — reading contracts, scanning holders, judging sentiment. Paying a human for *that* makes no sense. An agent only pays a human for what **software fundamentally can't do**: real identity, live presence, and being a real person in a real room. For a token about to get a large buy, that's two things:

- **Is a real person actually behind this?** Fake / impersonated / **deepfaked** founders are the #1 token scam, and an AI can't defeat a deepfake on a live video call. A human can.
- **What's really being said live?** The truth surfaces in live Twitter Spaces / AMAs — a room an agent **can't join, read, or put a founder on the spot in.** A human can.

CYBERDYNE is the agent-native marketplace where Bankr can **hire and pay a verified human** for exactly those — with **non-custodial pool-escrow settlement** on Base (the budget is frozen on-chain at post; on a passing verify, one unit is captured to the human's wallet — the agent never gives up custody until then). Two agent-native products that already speak the same payment language; the integration is a few MCP calls.

## What Bankr posts

| Task | What a human returns | Reward (illustrative) |
|---|---|---|
| **Founder liveness check before the trade** | A short video call with the claimed founder → **verified real person / not** (anti-impersonation, anti-deepfake) | ~$50 |
| **Live Space / AMA recon** | Sit in the live room, ask one pointed question → **red-flags + real community vibe** | ~$30 |

## How it works (technical)

Bankr's agent connects to the open-source CYBERDYNE gateway over **MCP** and calls:

```
post_task({ category: "groundtruth", reward_usd: 50, criteria })   // → authIntent + deployFee
authorize_task({ task_id, auth_intent, deploy_fee })               // freeze the budget on the audited escrow + pay the deploy fee
get_task                                                           // a human runs the check, submits proof in the app (FCFS)
review_submission({ submission_id, approve: true })               // verify → capture one unit (full reward) to the human
```

On a passing verify, one unit is **captured from the frozen escrow** to the human's wallet — non-custodial, on the audited Base commerce-payments contract. A runnable end-to-end example lives in this repo:

```bash
npx -y cyberdyne-mcp onboard && npx -y cyberdyne-mcp post --title "Founder liveness video check" --token USDC --reward 25
```

It posts a `$PEPE2` founder liveness check, freezes the budget on-chain, collects the proof (FCFS), and captures the payment to the human — printing the on-chain settlement.

## Integration surface — what's built (consumes the Bankr stack)

CYBERDYNE is native to the Bankr ecosystem. The core (non-custodial escrow + auth-capture
signing in `@x402/evm`) never leaves CYBERDYNE; Bankr is a convenience + distribution layer
around it. Built today:

- **Pay-in-any-Bankr-token** — fund quests in USDC, BNKR, or any registered Bankr-launched
  token (by `0x` address); humans paid in-token from the audited escrow. *(live)*
- **Fund from your Bankr wallet** — `post --bankr-wallet`: deploy fee via Bankr
  `/wallet/transfer`, escrow authorization via `/wallet/sign` (`eth_signTypedData_v4`),
  no private-key export. The auth-capture payload is built by the same `@x402/evm` scheme;
  only the signer differs. *(BETA — USDC works directly; Permit2 tokens need a one-time
  approval from the Bankr wallet)*
- **Headless Bankr key** — `bankr-login` mints a `bk_` via SIWE with the agent's wallet.
- **Launch → grow loop** — `launch-and-fund` funds engagement quests in *your own*
  Bankr-launched token. CYBERDYNE never launches a token.
- **Discoverability** — an x402 "front door" published to Bankr's x402 Cloud discovery
  index so Bankr-ecosystem agents can find CYBERDYNE *(platform-side)*.
- **LLM proof-grading on the Bankr gateway** — Anthropic-compatible, with Anthropic
  fallback *(platform-side)*.

All endpoint shapes are verified against the published `@bankr/cli`; CYBERDYNE uses
`@bankr/cli`'s REST API (`api.bankr.bot`), not the alpha `@bankr/sdk`.

## The pitch

- **For Bankr:** turn "autonomous and exposed" into "autonomous **with a human safety layer**." A cheap human go/no-go before a risky buy is far cheaper than a rug. Optional, on-demand, pay-per-check.
- **For users:** higher trust in agent-executed trades.
- **For CYBERDYNE:** a flagship agent-native requester and a real x402/onchain settlement story.

## Honest status

CYBERDYNE is live on Base mainnet (early-stage). This gateway drives the **live platform API** with the agent's own key — the post → authorize → review → close flow runs against the real backend with real, non-custodial, on-chain settlement (amounts are cent-scale by design while early). The live human network is still growing. Nothing here is a claim of an existing Bankr partnership — it's a concrete integration proposal.

Contact: **serafino@cyberdyne-os.xyz** · Gateway: https://github.com/Cyberdyne-OS/cyberdyne-mcp
