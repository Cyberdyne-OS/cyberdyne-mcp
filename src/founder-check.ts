/**
 * Example: a trading agent hires a human for a founder liveness check before it buys.
 *
 * A trading agent can run every on-chain check itself — but it can't tell whether
 * a real person is behind a token. Fake / impersonated / deepfaked teams are the
 * #1 token scam, and defeating a deepfake on a live call is something only a human
 * can do. So before a risky buy, the agent hires a human through CYBERDYNE to
 * video-verify the founder, then settles on a passing verify. This is the pattern
 * behind e.g. Bankr (https://bankr.bot) and any x402 trader.
 *
 * This drives the LIVE platform. Requires CYBERDYNE_IDENTITY_TOKEN (a cyb_ key);
 * optionally CYBERDYNE_API_URL. No key is hardcoded — it no-ops without one.
 *
 *   CYBERDYNE_API_URL=http://localhost:3000 CYBERDYNE_IDENTITY_TOKEN=cyb_… \
 *     npm run build && npm run founder-check
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.CYBERDYNE_IDENTITY_TOKEN;
if (!token) {
  console.log(
    "founder-check: no-op. Set CYBERDYNE_IDENTITY_TOKEN (a cyb_ key) and optionally " +
      "CYBERDYNE_API_URL to run this example against the live platform.",
  );
  process.exit(0);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  env: { ...process.env } as Record<string, string>,
});
const client = new Client({ name: "trading-agent", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const data = JSON.parse(r.content[0].text);
  if (r.isError) throw new Error(`${name} → ${data.error}`);
  return data;
};

console.log("[agent] connected to CYBERDYNE over MCP\n");

// 0. Make sure the agent treasury can cover the bounty (demo top-up).
const t = await call("get_treasury");
if (Number(t.treasury?.balance_usd ?? 0) < 50) {
  await call("fund_treasury", { amount_usd: 100 });
}

// 1. The agent can't verify a real human is behind the token — find one who can.
const found = await call("search_humans", { skills: ["groundtruth"], min_reputation: 4.8 });
const human = found.humans[0];
console.log(`search_humans(groundtruth, min_rep 4.8) -> ${found.humans.length} match`);
if (human) console.log(`  hiring ${human.handle}  ${human.location}  rep ${human.reputation}\n`);

// 2. Post the founder liveness check. Not charged until authorize.
const posted = await call("post_task", {
  title: "Founder liveness check on $PEPE2",
  category: "groundtruth",
  description:
    "Get the claimed founder on a short video call and confirm they're a real, specific " +
    "person — not an impersonator or deepfake — matched to a known reference. Return verified / not + notes.",
  steps: [
    "Live video matches a known reference",
    "Passes liveness / deepfake probes => verified; otherwise not-verified + reasons",
  ],
  reward_usd: 50,
  duration_min: 30,
  difficulty: "hard",
  deadline_hours: 2,
});
const taskId = posted.task.id;
console.log(`post_task -> ${taskId}  reward $${posted.task.reward_usd}`);

// 3. Assign it to the chosen human and open the escrow hold.
if (human?.id) {
  const assigned = await call("assign_task", { task_id: taskId, human_id: human.id });
  console.log(`assign_task -> ${assigned.task.status}, authIntent ${assigned.authIntent ? "present" : "null"}`);
  const authd = await call("authorize_task", { task_id: taskId });
  console.log(`authorize_task -> escrow ${authd.task?.escrow_status}`);
}

// 4. Poll until the human's proof is in (they submit in the app — human-only).
const got = await call("get_task", { task_id: taskId });
console.log(`get_task -> ${got.task.status}  submissions ${got.submissions.length}`);

// 5. If the proof is in, verify and release payment to the human.
const pending = (got.submissions ?? []).find((s: any) => s.status === "pending");
if (pending) {
  const settled = await call("release_payment", { task_id: taskId, approve: true, score: 5 });
  console.log(`release_payment -> task ${settled.task?.status}`);
  console.log("\n[agent] has a human verification it could not produce itself, and the contributor is paid.");
} else {
  console.log("\n[agent] task is live and the hold is open; the human submits proof in the app, then the agent releases payment.");
}

await client.close();
