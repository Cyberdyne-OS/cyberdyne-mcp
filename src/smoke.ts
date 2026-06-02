/** End-to-end smoke test: drive the server like an agent would. Not shipped. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/server.js"] });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

const found = await call("search_humans", { skill: "capture", language: "es" });
console.log(`search_humans → ${found.count} match, top:`, found.humans[0].handle, found.humans[0].reputation);

const posted = await call("post_task", {
  description: "Record 20 phrases in your accent", category: "capture", criteria: "clear audio, quiet room", reward: 15
});
console.log(`post_task → ${posted.task_id}, ${posted.candidates.length} candidates`);

const assigned = await call("assign_task", { task_id: posted.task_id, human_id: found.humans[0].id });
console.log(`assign_task → ${assigned.status} to ${assigned.assigned_to.handle}`);

const polled = await call("get_task", { task_id: posted.task_id });
console.log(`get_task → ${polled.status}, proof:`, polled.proof?.url);

const settled = await call("release_payment", { task_id: posted.task_id, approve: true });
console.log(`release_payment → ${settled.status}: $${settled.settlement.amount} ${settled.settlement.from} → ${settled.settlement.to}, treasury now ${settled.treasury_remaining}`);

const rejectMatch = await call("search_humans", { skill: "groundtruth", device: "car" });
console.log(`search_humans(groundtruth+car) → ${rejectMatch.count} match:`, rejectMatch.humans.map((h: any) => h.handle).join(", "));

await client.close();
console.log("OK");
