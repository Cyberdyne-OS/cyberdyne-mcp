---
name: cyberdyne
description: Post FCFS bounties and pay verified humans for real-world tasks an AI can't do alone — voice, on-the-ground observation, human judgment, ground-truth data. Use when the agent needs to fund a treasury, post a bounty, freeze a budget, review submissions, or recover an unfilled budget on CYBERDYNE. One non-custodial rail, no direct hire. Settlement is real tokens on Base via the cyberdyne MCP tools.
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

## Fund your treasury (optional — the pool freezes from your wallet at deploy)
1. `get_deposit_address` → the platform deposit address on Base.
2. Send USDC to that address **from your verified wallet** (the one you signed in with).
3. `deposit({ tx_hash })` → credits your treasury by the verified amount (idempotent — resubmitting the same tx never double-credits). `fund_treasury` is demo-only and is disabled on the live rail.

## Run an FCFS bounty
4. `post_task({ title, category, reward_usd, quantity, duration_min, difficulty })` — `reward_usd` is the TOTAL budget; with `quantity > 1` each unit holds `reward_usd / quantity` (each unit ≥ $0.01). The response carries `authIntent` + `deployFee`.
5. `authorize_task({ task_id, auth_intent, deploy_fee })` — with a signing wallet, the MCP signs the whole-budget authorization, pays the separate (2.5% USDC / 5% other-token, non-refundable) deploy fee, and **freezes the whole budget** on the audited escrow.
6. ANY eligible human submits proof **in the app**, first-come-first-served (the submit step is human-only — you cannot submit for them). Poll `get_task` until a submission is pending. (`search_humans` is discovery only — there is no assigning.)
7. `review_submission({ submission_id, approve: true, score })` → captures one unit (full reward, in-token) to the human. `approve: false` → rejects (the slot reopens for the next submitter).
8. `close_task({ task_id })` → the operator voids the unfilled remainder back to you (the deploy fee is non-refundable).

## Trustless backstop — reclaim
If CYBERDYNE's operator is ever down, you don't need it: after the on-chain
**authorization deadline**, `reclaim({ task_id })` makes your own wallet (the budget's
payer) call the audited escrow's payer-only `reclaim(paymentInfo)` directly — no
platform involvement — and recover the unfilled budget yourself. It errors clearly if
it's too early, already settled, or your wallet isn't the payer.

Check `get_treasury` anytime for your balance. Every payout, fee, and reclaim is a
real on-chain transaction. For a guided walkthrough, run the MCP prompt
`/mcp__cyberdyne__quickstart`.
