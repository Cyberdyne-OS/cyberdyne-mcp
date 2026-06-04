/**
 * Live smoke test: drive the MCP server against the REAL platform API like an
 * agent would. Not shipped.
 *
 * Requires both env vars to run for real:
 *   CYBERDYNE_API_URL        e.g. http://localhost:3000 or https://app.cyberdyne-os.xyz
 *   CYBERDYNE_IDENTITY_TOKEN the agent's cyb_ key
 * If either is missing it no-ops with a clear message (no key is ever hardcoded).
 *
 * The server inherits this process's env over stdio, so the same creds drive it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const apiUrl = process.env.CYBERDYNE_API_URL;
const token = process.env.CYBERDYNE_IDENTITY_TOKEN;
if (!token) {
    console.log("smoke: no-op. Set CYBERDYNE_IDENTITY_TOKEN (a cyb_ key) and optionally " +
        "CYBERDYNE_API_URL to run the live flow against the platform.\n" +
        "  e.g. CYBERDYNE_API_URL=http://localhost:3000 CYBERDYNE_IDENTITY_TOKEN=cyb_… npm run smoke");
    process.exit(0);
}
const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: { ...process.env },
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const data = JSON.parse(r.content[0].text);
    if (r.isError)
        throw new Error(`${name} → ${data.error}`);
    return data;
};
console.log(`smoke → ${apiUrl ?? "https://app.cyberdyne-os.xyz"}`);
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
// 1. Categories (static, no network).
const cats = await call("list_categories");
console.log(`list_categories → ${cats.length} categories`);
// 2. Treasury — ensure it can cover a small task; top up if needed.
let treasury = await call("get_treasury");
const balance = Number(treasury.treasury?.balance_usd ?? 0);
console.log(`get_treasury → balance $${balance}`);
if (balance < 5) {
    treasury = await call("fund_treasury", { amount_usd: 25 });
    console.log(`fund_treasury → balance $${treasury.treasury?.balance_usd}`);
}
// 3. Discover a human via the live capability index.
const found = await call("search_humans", { skills: ["capture"] });
console.log(`search_humans(capture) → ${found.humans.length} match`);
const human = found.humans[0];
// 4. Post a task. reward_usd is the budget; not charged until authorize.
const posted = await call("post_task", {
    title: "Read 10 phrases (smoke)",
    category: "capture",
    description: "Record 10 short phrases clearly in a quiet room.",
    reward_usd: 3.5,
    duration_min: 10,
    difficulty: "easy",
});
const taskId = posted.task.id;
console.log(`post_task → ${taskId} (status ${posted.task.status})`);
// 5. If we found a human, assign + authorize (open the escrow hold).
if (human?.id) {
    const assigned = await call("assign_task", { task_id: taskId, human_id: human.id });
    console.log(`assign_task → status ${assigned.task.status}, authIntent ${assigned.authIntent ? "present" : "null (manual rail)"}`);
    const authd = await call("authorize_task", { task_id: taskId });
    console.log(`authorize_task → escrow_status ${authd.task?.escrow_status}`);
}
// 6. Poll the live task. The human submits proof in the app (human-only), so on a
//    fresh task there is typically no submission yet — that is expected here.
const got = await call("get_task", { task_id: taskId });
console.log(`get_task → status ${got.task.status}, submissions ${got.submissions.length}, claims ${got.claims.length}`);
const pending = (got.submissions ?? []).find((s) => s.status === "pending");
if (pending) {
    const settled = await call("release_payment", { task_id: taskId, approve: true, score: 5 });
    console.log(`release_payment → settled, task status ${settled.task?.status}`);
}
else {
    console.log("release_payment → skipped: no pending submission yet (a human submits proof in the app). " +
        "Closing the task to release the hold.");
    const closed = await call("close_task", { task_id: taskId });
    console.log(`close_task → status ${closed.task?.status}`);
}
await client.close();
console.log("OK");
