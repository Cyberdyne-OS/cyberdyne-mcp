/**
 * Example: a trading agent hires a human for a founder liveness check before it buys.
 *
 * A trading agent can run every on-chain check itself — but it can't tell whether
 * a real person is behind a token. Fake / impersonated / deepfaked teams are the
 * #1 token scam, and defeating a deepfake on a live call is something only a human
 * can do. So before a risky buy, the agent hires a human through CYBERDYNE to
 * video-verify the founder, then pays directly on a passing verify (no escrow).
 * This is the pattern behind e.g. Bankr (https://bankr.bot) and any x402 trader.
 *
 *   npm run build && npm run founder-check   (or: npx tsx src/founder-check.ts)
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

// 1. The agent can't verify a real human is behind the token — find a human who can.
const found = await call("search_humans", { skill: "groundtruth", min_reputation: 4.8 });
const human = found.humans[0];
console.log(`search_humans(groundtruth, min_rep 4.8) -> ${found.count} match`);
console.log(`  hiring ${human.handle}  ${human.location}  rep ${human.reputation}  ${human.wallet}\n`);

// 2. Post the founder liveness check, funded from the agent's treasury. No funds move yet.
const posted = await call("post_task", {
  description:
    "Founder liveness check on $PEPE2 before buying 2 ETH worth: get the claimed founder on a short video call and confirm they're a real, specific person — not an impersonator or deepfake — matched to a known reference. Return verified / not + notes.",
  category: "groundtruth",
  criteria: "Live video matches a known reference, passes liveness/deepfake probes => verified; otherwise not-verified + reasons.",
  reward: 50,
  deadline_hours: 2,
  agent_wallet: AGENT_WALLET
});
console.log(`post_task -> ${posted.task_id}  reward $${posted.reward}  ${posted.candidates.length} candidates`);

// 3. Assign it to the chosen human; they run the call.
await call("assign_task", { task_id: posted.task_id, human_id: human.id });

// 4. Poll until the human's proof is in.
const got = await call("get_task", { task_id: posted.task_id });
console.log(`get_task -> ${got.status}  proof: ${got.proof?.url}`);

// 5. Verify the proof and release payment directly, agent wallet -> human wallet.
const settled = await call("release_payment", { task_id: posted.task_id, approve: true, score: 5 });
console.log(
  `release_payment -> ${settled.status}: $${settled.settlement.amount} ${settled.settlement.from} -> ${settled.settlement.to}`
);
console.log(`\n[agent] has a human verification it could not produce itself, and the contributor is paid.`);
console.log("Direct settlement, no escrow — the same x402 / on-chain rails the agent already uses.");

await client.close();
