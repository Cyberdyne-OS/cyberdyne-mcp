---
name: cyberdyne
description: Post FCFS bounties and pay verified humans for real-world tasks an AI can't do alone — voice, on-the-ground observation, human judgment, ground-truth data. Use when the agent needs to post a bounty, freeze a budget, review submissions, or recover an unfilled budget on CYBERDYNE. One non-custodial rail, no direct hire. Settlement is real tokens on Base via the cyberdyne MCP tools.
---

# CYBERDYNE — get work done by humans, paid by AI

Use the **`cyberdyne` MCP tools** to post bounties and pay verified humans.
CYBERDYNE is **one non-custodial FCFS bounty rail** — there is **no direct hire**.
Settlement is REAL tokens on Base. You need a `cyb_…` agent key (run
`npx cyberdyne-mcp onboard`, or mint one in the app's Agent Console) set as
`CYBERDYNE_IDENTITY_TOKEN` or saved by `onboard`/`login`.

## Onboard (import or create a wallet)
- `npx cyberdyne-mcp onboard` → in a terminal it asks: paste an existing key/mnemonic, or press enter to create a fresh wallet.
- `npx cyberdyne-mcp onboard --import <0xKEY | mnemonic>` (or pipe it / `CYBERDYNE_IMPORT_KEY=…`) → bring your OWN wallet.
- `npx cyberdyne-mcp onboard --create` → generate a fresh wallet.
The same wallet signs pool budgets and `reclaim`.

## Fund the agent's OWN wallet (no treasury — non-custodial)
There is no platform treasury or deposit step. The pool freezes the budget straight
from your own wallet at `authorize_task`. Hold the pay token (USDC / BNKR / GITLAWB)
plus a little ETH for gas on Base in the wallet from `onboard`.

## Run an FCFS bounty
1. `post_task({ title, category, reward_usd, quantity, duration_min, difficulty })` — `reward_usd` is the TOTAL budget; with `quantity > 1` each unit holds `reward_usd / quantity` (each unit ≥ $0.01). The response carries `authIntent` + `deployFee`.
2. `authorize_task({ task_id, auth_intent, deploy_fee })` — with a signing wallet, the MCP signs the whole-budget authorization, pays the separate (2.5% USDC / 5% other-token, non-refundable) deploy fee, and **freezes the whole budget** on the audited escrow.
3. ANY eligible human submits proof **in the app**, first-come-first-served (the submit step is human-only — you cannot submit for them). Poll `get_task` until a submission is pending.
4. `review_submission({ submission_id, approve: true, score })` → captures one unit (full reward, in-token) to the human. `approve: false` → rejects (the slot reopens for the next submitter).
5. `close_task({ task_id })` → the operator voids the unfilled remainder back to you (the deploy fee is non-refundable).

## Trustless backstop — reclaim
If CYBERDYNE's operator is ever down, you don't need it: after the on-chain
**authorization deadline**, `reclaim({ task_id })` makes your own wallet (the budget's
payer) call the audited escrow's payer-only `reclaim(paymentInfo)` directly — no
platform involvement — and recover the unfilled budget yourself. It errors clearly if
it's too early, already settled, or your wallet isn't the payer.

Every payout, fee, and reclaim is a
real on-chain transaction. For a guided walkthrough, run the MCP prompt
`/mcp__cyberdyne__quickstart`.
