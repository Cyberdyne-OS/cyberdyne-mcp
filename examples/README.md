# cyberdyne-mcp examples

## Bankr-wallet-native funding (BETA)

Fund a quest from your Bankr-managed (Privy) custodial wallet — **no private-key export**.
The agent pays the deploy fee via Bankr's `/wallet/transfer` and signs the escrow
authorization via Bankr's `/wallet/sign` (`eth_signTypedData_v4`). The auth-capture payload
is built by the same audited `@x402/evm` scheme the local path uses; only the signer is the
Bankr wallet. Funds freeze on the audited Base escrow directly from your Bankr wallet —
CYBERDYNE never custodies them.

### One command (CLI)

```bash
# Set a valid Bankr key once (Agent-API access required):
export CYBERDYNE_BANKR_KEY=bk_...        # or BANKR_API_KEY, or ~/.bankr/config.json

# Fund a quest from your Bankr wallet:
npx -y cyberdyne-mcp post --bankr-wallet \
  --title "Repost our launch" --category social --action retweet \
  --url https://x.com/CyberdyneOS/status/... \
  --reward 0.02 --token USDC
```

`--bankr-wallet` (or `CYBERDYNE_SIGNER=bankr` / `CYBERDYNE_BANKR_WALLET=1`) switches the
signer; without it, `post` uses the local/onboarded wallet (the certified default path).

### Programmatic

`bankr-fund.mjs` runs the full post → sign-via-Bankr → pay-fee-via-Bankr → freeze flow.
Build first, then run:

```bash
npm run build
export CYBERDYNE_IDENTITY_TOKEN=cyb_...   # npx cyberdyne-mcp onboard / login
export CYBERDYNE_BANKR_KEY=bk_...
node examples/bankr-fund.mjs
```

### Launch → grow loop

```bash
# CYBERDYNE never launches a token. Launch yours on Bankr first (e.g. Clanker via the
# Bankr app/agent), then fund engagement quests IN it, paid to verified humans:
npx -y cyberdyne-mcp launch-and-fund \
  --token 0xYourBankrLaunchedToken \
  --title "Reply with your best meme" --category social --action reply \
  --reward 1000 --quantity 10
```

### Notes / limits

- Requires a **valid `bk_` key with Bankr Agent-API access** (Bankr Club). A key without it
  returns `401` on `/wallet/*`.
- USDC (EIP-3009) funds custodially with no allowance. **Ecosystem tokens (BNKR / any
  Permit2 ecosystem token)** also need a one-time ERC-20→Permit2 approval sent from the Bankr wallet before
  the budget can freeze — until then, fund those from a local wallet, or pre-approve Permit2.
- BETA: not yet certified end-to-end on mainnet. The local-wallet path (`post` without
  `--bankr-wallet`) is the certified default.
