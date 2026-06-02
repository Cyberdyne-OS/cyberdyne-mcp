/**
 * Example: a trading agent hires a human for a token reliability check before it buys.
 *
 * Autonomous onchain trading is exposed to scams (honeypots, fake LP locks,
 * whale traps, bot-farmed hype) — judgment calls models are bad at. Before it
 * fires a risky buy, a trading agent can hire a human through CYBERDYNE to run a
 * reliability & liquidity check on the token, then pay directly on a passing
 * verify (no escrow). This is the pattern behind e.g. Bankr (https://bankr.bot)
 * and any x402-native trader.
 *
 *   npm run build && npm run reliability-check   (or: npx tsx src/reliability-check.ts)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/server.js"] });
const client = new Client({ name: "trading-agent", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};

const AGENT_WALLET = "0xTRADE…a402";
console.log("[agent] connected to CYBERDYNE over MCP\n");

// 1. The agent wants a human to vet a low-cap token before buying — find an expert.
const found = await call("search_humans", { skill: "expert", min_reputation: 4.8 });
const human = found.humans[0];
console.log(`search_humans(expert, min_rep 4.8) -> ${found.count} match`);
console.log(`  hiring ${human.handle}  ${human.location}  rep ${human.reputation}  ${human.wallet}\n`);

// 2. Post the reliability check, funded from the agent's treasury. No funds move yet.
const posted = await call("post_task", {
  description:
    "Reliability & liquidity check on $PEPE2 (0xabc123…) before buying 2 ETH worth: contract mint/owner authority, LP lock, top-holder concentration, and socials. Return a go / no-go.",
  category: "expert",
  criteria: "Mint renounced + LP locked >6mo + no holder >5% + real socials => go; otherwise no-go with reasons.",
  reward: 45,
  deadline_hours: 1,
  agent_wallet: AGENT_WALLET
});
console.log(`post_task -> ${posted.task_id}  reward $${posted.reward}  ${posted.candidates.length} candidates`);

// 3. Assign it to the chosen human; they begin the check.
await call("assign_task", { task_id: posted.task_id, human_id: human.id });

// 4. Poll until the human's proof is in.
const got = await call("get_task", { task_id: posted.task_id });
console.log(`get_task -> ${got.status}  proof: ${got.proof?.url}`);

// 5. Verify the proof and release payment directly, agent wallet -> human wallet.
const settled = await call("release_payment", { task_id: posted.task_id, approve: true, score: 5 });
console.log(
  `release_payment -> ${settled.status}: $${settled.settlement.amount} ${settled.settlement.from} -> ${settled.settlement.to}`
);
console.log(`\n[agent] has a human go/no-go and the contributor is paid. Treasury left: ${settled.treasury_remaining}`);
console.log("Direct settlement, no escrow — the same x402 / on-chain rails the agent already uses.");

await client.close();
