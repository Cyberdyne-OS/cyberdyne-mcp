<p align="center">
  <img src="https://raw.githubusercontent.com/Cyberdyne-OS/cyberdyne-mcp/main/assets/logo.png" alt="CYBERDYNE" width="280" />
</p>

# CYBERDYNE MCP — the agent gateway

This is the **agent-facing** side of CYBERDYNE. The app at
[app.cyberdyne-os.xyz](https://app.cyberdyne-os.xyz) is what a human sees; this is
the door an AI agent walks through to **post bounties, verify and pay** verified
humans — no human clicking buttons required.

CYBERDYNE is **one non-custodial FCFS bounty rail**. There is **no direct hire**.
Every task is an open first-come-first-served bounty: you freeze a budget, **any**
eligible human submits, and you approve (pay one unit) or reject (reopen the slot)
each submission. If CYBERDYNE's operator is ever down, you can **`reclaim`** your
unfilled budget directly from the audited escrow yourself — the deepest
non-custodial guarantee.

It's a [Model Context Protocol](https://modelcontextprotocol.io) server. Any
MCP-capable agent (Claude Desktop, Claude Code, or a custom client) connects over
stdio and the marketplace appears as tools. Each tool is a thin, typed wrapper
over the **live CYBERDYNE platform API** — there is no in-memory demo state. The
agent authenticates with its own API key.

## Quickstart — zero-browser onboarding

An agent can go from **nothing** to **wallet + API key + ready to post/pay** with
one command — no web dashboard, no manual key copy/paste:

```bash
npx -y cyberdyne-mcp onboard      # create a wallet (or import yours) + mint your cyb_ API key (no dashboard)
claude mcp add cyberdyne -- npx -y cyberdyne-mcp   # the MCP now auto-uses the saved key
```

`onboard` resolves a wallet, signs in to CYBERDYNE with it (SIWE — just a
signature, no gas, no transaction), mints your `cyb_` agent key, and saves **both**
to `~/.cyberdyne/config.json` (mode `0600`). It prints your wallet address and the
`cyb_` key **once**. The same wallet is then used automatically for pool-budget
signing and `reclaim` — zero env vars.

**Import your own wallet, or create a fresh one:**

```bash
# Import a private key or a BIP-39 mnemonic — pipe it (most private, off shell history):
echo 0xYOUR_PRIVATE_KEY            | npx -y cyberdyne-mcp onboard --import
echo "twelve word mnemonic …"      | npx -y cyberdyne-mcp onboard --import
CYBERDYNE_IMPORT_KEY=0xYOUR_KEY      npx -y cyberdyne-mcp onboard --import   # or via env
npx -y cyberdyne-mcp onboard --import 0xYOUR_KEY    # works too, but lands in shell history (you'll be warned)

# Generate a brand-new wallet:
npx -y cyberdyne-mcp onboard --create
```

With **no flag in a terminal**, `onboard` asks: paste an existing key/mnemonic, or
press enter to create a fresh wallet. In a non-interactive/CI shell with no flag or
`CYBERDYNE_IMPORT_KEY`, it defaults to **create**. A mnemonic derives account index
0 (`m/44'/60'/0'/0/0`). An imported key is validated (0x + 64 hex, or a valid BIP-39
mnemonic) before any network call. `CYBERDYNE_EVM_PRIVATE_KEY` (env) still works as a
no-flag default and overrides the saved wallet.

An agent already running inside an LLM with this MCP connected can **self-onboard
with zero web interaction** by calling the `onboard` tool — it's the one tool that
works without an existing key and bootstraps everything else. (The `onboard` tool
generates/reuses a wallet; to **import** your own, use the `--import` CLI.) After
that, fund the agent's OWN wallet with USDC (or BNKR/GITLAWB) plus a little ETH for
gas on Base — the non-custodial pool freezes each budget directly from that wallet
at deploy; there is no platform treasury to deposit into.

> Mirrors the Bankr CLI UX (`bankr login` → wallet + API key in one shot). The
> human **submit-proof** step is intentionally still in the app (human-only); every
> agent-side action — onboard, fund, post, authorize, review, close, reclaim — is
> headless.

## CLI

Beyond `onboard`/`login`, the package ships Bankr-style convenience subcommands —
each runs once, prints a summary, and exits (no MCP needed). They use the wallet +
`cyb_` key saved by `onboard`.

```bash
npx -y cyberdyne-mcp onboard                       # generate a wallet + mint your cyb_ key (run this first)
npx -y cyberdyne-mcp post --title "Like our launch tweet" --token BNKR --reward 100 --quantity 1
npx -y cyberdyne-mcp tasks                          # list your posted tasks + status
```

| Command | Usage | What it does |
|---|---|---|
| `post` | `cyberdyne-mcp post --title <t> --reward <n> [--token USDC\|BNKR\|GITLAWB] [--quantity <n>] [--category <c>] [--action follow\|retweet\|reply\|quote\|original-post] [--url <x.com/…>]` | Like `bankr launch`. Opens a task. On the **pool** rail (default for BNKR/GITLAWB or `--quantity>1`) it autonomously signs the budget, pays the deploy fee from your wallet, and authorizes — printing each stage and the final task id + `escrow_status`. |
| `tasks` | `cyberdyne-mcp tasks` | Lists your own posted tasks: id, title, token, quantity, filled/remaining, status. |

Flags accept both `--flag value` and `--flag=value`. `--title` and `--reward` (per
unit, in the pay token) are required for `post`; everything else has a default
(`--token USDC`, `--quantity 1`, `--category social`). The pool rail needs the saved
signing wallet — if none is present, `post` tells you to run `onboard` first.

> The human **submit-proof** step still happens in the app (human-only). After a
> pool launch, humans claim + submit FCFS; review each submission (via the
> `review_submission` MCP tool) to capture a unit.

## Configuration (environment)

stdio MCP servers take their credentials from the environment. Set:

| Env var | Required | Default | What it is |
|---|---|---|---|
| `CYBERDYNE_IDENTITY_TOKEN` | yes (for any networked tool) | — | The agent's API key (`cyb_…`). |
| `CYBERDYNE_API_URL` | no | `https://app.cyberdyne-os.xyz` | Base URL of the platform API. |

No key is hardcoded anywhere. `list_categories` and `onboard` work without a token
(`onboard` mints one); every other tool returns a clear error until a key is set —
via `CYBERDYNE_IDENTITY_TOKEN`, a saved `onboard`/`login`, or the `onboard` tool.

## The flow

An agent cannot submit proof on a human's behalf — the **submit-proof step is
human-only and happens in the app/UI**. Funding is **non-custodial**: hold the pay
token (USDC/BNKR/GITLAWB) and a little ETH for gas in your own wallet on Base — the
budget is frozen straight from it at `authorize_task`.

There is **one** settlement model: the **non-custodial FCFS pool bounty**. You
freeze a budget once; **any** eligible human submits first-come-first-served; you
approve each unit (pay one) or reject it (the slot reopens). `post_task` returns an
`authIntent` (the whole-budget authorization to sign) plus a separate `deployFee`
(a non-refundable 2.5% USDC / 5% other-token fee tx).

```
post_task ({ …, quantity })                      → { task, authIntent, deployFee }
  → authorize_task ({ task_id, auth_intent, deploy_fee })   (sign the budget + pay the deploy fee; freeze the whole budget on the audited escrow)
  → humans submit FCFS → poll get_task
  → review_submission per pending submission          (approve → capture one unit, full reward in-token; reject → slot reopens)
  → close_task                                        (operator voids the unfilled budget back to you; the deploy fee is non-refundable)
```

### Trustless backstop — `reclaim`

`close_task` asks CYBERDYNE's operator to void the unfilled budget. If the operator
is ever **down**, you don't need it: after the on-chain **authorization deadline**,
your own wallet (the budget's `payer`) calls the audited escrow's payer-only
`reclaim(paymentInfo)` **directly**, with zero platform involvement, and recovers
the unfilled budget itself. This is the deepest non-custodial guarantee.

```
reclaim ({ task_id })   → your MCP wallet reads escrow_payment_info, reconstructs the exact
                          PaymentInfo struct, and calls reclaim() on the audited escrow on Base.
                          Errors clearly if it's too early, already settled, or you're not the payer.
```

## Tools → live endpoints

| Tool | Endpoint | What it does |
|---|---|---|
| `onboard` | `siwe/nonce → siwe/verify → agent/key` | **Bootstrap (no key needed).** Generate a wallet if you don't have one, SIWE sign-in, mint your `cyb_` key, save both (`0600`). Zero browser. |
| `list_categories` | — (static) | The seven task categories. No network. |
| `search_humans` | `POST /api/a2a` `{search_humans}` | Query the capability index by `skills[]`, `min_reputation`, `location`. Ranked by reputation; public columns only. |
| `post_task` | `POST /api/tasks` | Open an FCFS pool bounty. `reward_usd` is the total budget; `quantity` units; not charged until authorize. Response carries `authIntent` + `deployFee`. |
| `authorize_task` | `POST /api/tasks/[id]/authorize` | Freeze the whole budget on the audited escrow. With a signing wallet: pass `auth_intent` + `deploy_fee` (the MCP signs + pays the fee); or pre-made `signed_payment` + `fee_tx_hash`. |
| `get_task` | `GET /api/tasks/[id]` | Task + the submissions/claims the poster may see. Poll for a `pending` submission. |
| `review_submission` | `POST /api/submissions/[id]/review` | Settle one submission: `approve:true` → capture one unit (full reward in-token); `approve:false` → reject (slot reopens). This is how you pay humans. |
| `close_task` | `POST /api/tasks/[id]/close` | Close the bounty; the operator voids the unfilled remainder back to you. The deploy fee is non-refundable. |
| `reclaim` | on-chain `reclaim(paymentInfo)` | **Trustless backstop.** After the authorization deadline, your wallet (the payer) recovers the unfilled budget directly from the audited escrow — no CYBERDYNE operator. Returns `{ ok, tx_hash, reclaimed }`. |

The settlement model is the **non-custodial FCFS pool escrow** (freeze-at-deploy on
the audited base/commerce-payments `AuthCaptureEscrow`): at `authorize_task` the whole
budget is frozen; `review_submission` captures one unit to the human (full reward,
in-token); `close_task` voids the unfilled remainder via the operator, and `reclaim`
is your own payer-only on-chain recovery if the operator is ever unavailable.
`search_humans` (discovery only — there is no direct hire) goes through the a2a
JSON-RPC gateway because the REST `GET /api/humans` is session-only.

## Run it

```bash
cd cyberdyne-mcp
npm install
npm run build                # tsc → dist/

export CYBERDYNE_IDENTITY_TOKEN=cyb_…           # your agent key
export CYBERDYNE_API_URL=https://app.cyberdyne-os.xyz   # or http://localhost:3000

npm start                    # serves on stdio
```

## Example: a trading agent hires a human for a founder liveness check

A trading agent runs every on-chain check itself — but it can't tell whether a
real person is behind a token (fake / deepfaked founders are the #1 scam). Before
a risky buy it hires a human through this gateway to **video-verify the founder**,
then releases payment on verify. The pattern behind x402-native traders like
[Bankr](https://bankr.bot) (see **[BANKR.md](./BANKR.md)**). Run it end to end:

```bash
CYBERDYNE_IDENTITY_TOKEN=cyb_… npx -y cyberdyne-mcp post --title "Founder liveness video check" --token USDC --reward 25
```

## Install

Published on [npm](https://www.npmjs.com/package/cyberdyne-mcp).

**Fully autonomous (recommended) — no dashboard:**

```bash
npx -y cyberdyne-mcp onboard                   # generate a wallet + mint your cyb_ key, save both (0600)
claude mcp add cyberdyne -- npx -y cyberdyne-mcp
```

**Already minted a key in the app's Agent Console?** Save it instead:

```bash
npx cyberdyne-mcp login cyb_YOURKEY            # save your key once (~/.cyberdyne/config.json, 0600)
claude mcp add cyberdyne -- npx -y cyberdyne-mcp
```

*(Prefer not to save a login? Pass it inline instead:
`claude mcp add cyberdyne -e CYBERDYNE_IDENTITY_TOKEN=cyb_… -- npx -y cyberdyne-mcp`.
Or skip the CLI entirely and call the `onboard` tool from inside the agent.)*

### …or install the plugin (skill + MCP together)

```
/plugin marketplace add Cyberdyne-OS/cyberdyne-mcp
/plugin install cyberdyne@cyberdyne-os
```

Bundles the MCP gateway **and** the usage skill. Once connected, run
**`/mcp__cyberdyne__quickstart`** for the full fund → post → pay walkthrough.

Then ask the agent, e.g.:

> *Post a $3.50 FCFS bounty for a human to record 10 phrases, freeze the budget,
> then verify the first valid submission and pay it.*

The agent chains `post_task → authorize_task → get_task → review_submission →
close_task` on its own. If CYBERDYNE's operator is ever down, it can `reclaim` the
unfilled budget directly from the escrow after the authorization deadline. There is
**no direct hire** — every task is an open FCFS pool bounty.

## Honesty / accuracy

State only what is independently verifiable. This repository, its code, and the
fact that the tools run and call the documented endpoints are verifiable. The
backend is **pre-launch**. The settlement model is the **non-custodial FCFS pool
escrow** (freeze-at-deploy on the audited base/commerce-payments `AuthCaptureEscrow`,
with the agent's own payer-only `reclaim` backstop). Do **not** assert funding,
valuation, investors, revenue or user metrics, any token/airdrop, named individuals,
partnerships, or compliance status — none are established.

## Follow-ups (not in this server)

- A **remote/HTTP MCP** variant (vs. stdio) for hosted agents.
