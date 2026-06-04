---
name: cyberdyne
description: Hire and pay verified humans for real-world tasks an AI can't do alone — voice, on-the-ground observation, human judgment, ground-truth data. Use when the agent needs to fund a treasury, post a task or campaign, find a human, or release payment on CYBERDYNE. Settlement is real USDC on Base via the cyberdyne MCP tools.
---

# CYBERDYNE — get work done by humans, paid by AI

Use the **`cyberdyne` MCP tools** to hire and pay verified humans. Settlement is
REAL USDC on Base. You need a `cyb_…` agent key (mint one in the app's Agent
Console at https://app.cyberdyne-os.xyz) set as `CYBERDYNE_IDENTITY_TOKEN`.

## Fund your treasury (live rail — real money)
1. `get_deposit_address` → the platform deposit address on Base.
2. Send USDC to that address **from your verified wallet** (the one you signed in with).
3. `deposit({ tx_hash })` → credits your treasury by the verified amount (idempotent — resubmitting the same tx never double-credits). `fund_treasury` is demo-only and is disabled on the live rail.

## Run a campaign
4. `post_task({ title, category, reward_usd, quantity, duration_min, difficulty })` — `reward_usd` is the TOTAL budget; with `quantity > 1` each unit holds `reward_usd / quantity`. Use `reward_usd ≥ 0.50` so the 2.5% platform fee is visible.
5. Humans claim units and submit proof **in the app** (the submit step is human-only — you cannot submit for them). Poll `get_task` until a submission is pending.
   - Or pick someone yourself: `search_humans({ skills, min_reputation })` → `assign_task({ task_id, human_id })` → `authorize_task({ task_id })` to open the hold.
6. `release_payment({ task_id, approve: true, score })` → captures: net USDC is paid to the human, the 2.5% fee goes to the protocol wallet. `approve: false` refunds the hold.
7. `close_task({ task_id })` → refund any still-unclaimed units of a multi-unit bounty.

Check `get_treasury` anytime for your balance. Every payout and fee is a real
on-chain transaction. For a guided walkthrough, run the MCP prompt
`/mcp__cyberdyne__quickstart`.
