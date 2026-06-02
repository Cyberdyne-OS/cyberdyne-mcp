#!/usr/bin/env node
/**
 * CYBERDYNE MCP server — the agent gateway.
 *
 * Exposes the marketplace to any MCP-capable agent (Claude, etc.) as tools:
 *   list_categories   — what kinds of real-world work humans can do
 *   search_humans     — find verified humans by capability, location, language…
 *   post_task         — open a task; get matched human candidates
 *   assign_task       — pick a human; they begin work
 *   get_task          — poll status; proof appears when the human submits
 *   release_payment   — verify the proof; agent wallet → human wallet, both scored
 *   get_treasury      — the agent's remaining demo balance
 *
 * Model: no contract, no escrow. On a passing verify the requesting agent's
 * wallet pays the human directly — the same settlement shown in the app.
 *
 * This is a demo: state is in-memory and no real funds move. Run it over stdio
 * and connect from any MCP client.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  HUMANS,
  CATEGORIES,
  AGENT_TREASURY_START,
  type Category,
  type Human
} from "./registry.js";

// ---- In-memory marketplace state (resets each run) ------------------------

type TaskStatus =
  | "open" // posted, awaiting assignment
  | "assigned" // a human is working
  | "submitted" // proof is in, awaiting the agent's verify
  | "settled" // verified + paid
  | "rejected"; // verify failed

interface PostedTask {
  id: string;
  description: string;
  category: Category;
  criteria: string;
  reward: number;
  deadlineHours: number;
  status: TaskStatus;
  agentWallet: string;
  assignedHumanId?: string;
  proof?: { url: string; note: string };
  receipt?: Settlement;
}

interface Settlement {
  taskId: string;
  from: string; // agent wallet
  to: string; // human wallet
  amount: number;
  humanReputationAfter: number;
  settledAtSeq: number;
}

const tasks = new Map<string, PostedTask>();
let treasury = AGENT_TREASURY_START;
let seq = 0; // monotonic counter — avoids Date.now()/random for determinism
const nextId = (prefix: string) => `${prefix}-${(++seq).toString(36)}`;

// Mutable copy of reputations so scoring persists across calls this session.
const reputation = new Map<string, number>(HUMANS.map((h) => [h.id, h.reputation]));

const publicHuman = (h: Human) => ({
  id: h.id,
  handle: h.handle,
  skills: h.skills,
  tags: h.tags,
  location: h.location,
  timezone: h.timezone,
  languages: h.languages,
  devices: h.devices,
  reputation: reputation.get(h.id) ?? h.reputation,
  tasksDone: h.tasksDone,
  responseMins: h.responseMins,
  available: h.available,
  wallet: h.wallet
});

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
});
const err = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
  isError: true
});

// ---- Server ---------------------------------------------------------------

const server = new McpServer({
  name: "cyberdyne",
  version: "0.1.0"
});

server.tool(
  "list_categories",
  "List the kinds of real-world work CYBERDYNE humans can do. Use this to learn the valid `category` values before posting a task.",
  {},
  async () =>
    json(
      Object.entries(CATEGORIES).map(([id, blurb]) => ({ id, blurb }))
    )
);

server.tool(
  "search_humans",
  "Find verified humans by capability. All filters are optional and combine (AND). Results are ranked by reputation. This is the discovery gateway: query the capability index, get a ranked shortlist with wallets and reputation.",
  {
    skill: z
      .enum(["groundtruth", "capture", "agenteval", "expert", "demo", "data"])
      .optional()
      .describe("A task category the human must be able to do."),
    location: z.string().optional().describe("Substring match on location, e.g. 'ES', 'Tokyo'."),
    language: z.string().optional().describe("ISO-ish language code the human speaks, e.g. 'es', 'ja'."),
    device: z.string().optional().describe("Required device/capability, e.g. 'car', 'studio-mic'."),
    tag: z.string().optional().describe("Free-form sub-skill, e.g. 'transcription', 'ground-truth'."),
    min_reputation: z.number().min(0).max(5).optional().describe("Minimum reputation (0–5)."),
    available_only: z.boolean().optional().default(true).describe("Only return humans currently available."),
    limit: z.number().int().min(1).max(50).optional().default(10)
  },
  async ({ skill, location, language, device, tag, min_reputation, available_only, limit }) => {
    const matches = HUMANS.filter((h) => {
      if (skill && !h.skills.includes(skill)) return false;
      if (available_only && !h.available) return false;
      if (location && !h.location.toLowerCase().includes(location.toLowerCase())) return false;
      if (language && !h.languages.includes(language.toLowerCase())) return false;
      if (device && !h.devices.some((d) => d.toLowerCase().includes(device.toLowerCase()))) return false;
      if (tag && !h.tags.some((t) => t.toLowerCase().includes(tag.toLowerCase()))) return false;
      if (min_reputation != null && (reputation.get(h.id) ?? h.reputation) < min_reputation) return false;
      return true;
    })
      .map(publicHuman)
      .sort((a, b) => b.reputation - a.reputation)
      .slice(0, limit);

    return json({ count: matches.length, humans: matches });
  }
);

server.tool(
  "post_task",
  "Open a task on the marketplace and get matched human candidates. Funds are NOT moved yet — payment only happens on release_payment after you verify the proof. Returns a task_id and a ranked shortlist of candidates whose skills match the category.",
  {
    description: z.string().min(3).describe("What you need the human to do."),
    category: z.enum(["groundtruth", "capture", "agenteval", "expert", "demo", "data"]),
    criteria: z.string().min(3).describe("Acceptance criteria you'll verify the proof against."),
    reward: z.number().positive().describe("Reward in demo USD, paid from your treasury on verify."),
    deadline_hours: z.number().positive().max(168).optional().default(48),
    agent_wallet: z.string().optional().default("0xAGENT…0001").describe("Your wallet (source of funds).")
  },
  async ({ description, category, criteria, reward, deadline_hours, agent_wallet }) => {
    if (reward > treasury) {
      return err(`Reward ${reward} exceeds treasury balance ${treasury.toFixed(2)}.`);
    }
    const id = nextId("task");
    tasks.set(id, {
      id,
      description,
      category,
      criteria,
      reward,
      deadlineHours: deadline_hours,
      status: "open",
      agentWallet: agent_wallet
    });

    const candidates = HUMANS.filter((h) => h.skills.includes(category) && h.available)
      .map(publicHuman)
      .sort((a, b) => b.reputation - a.reputation)
      .slice(0, 5);

    return json({
      task_id: id,
      status: "open",
      reward,
      deadline_hours,
      candidates,
      next: "Call assign_task with this task_id and a human_id to start the work."
    });
  }
);

server.tool(
  "assign_task",
  "Assign an open task to a chosen human. They begin work immediately. Poll get_task to see when their proof is submitted.",
  {
    task_id: z.string(),
    human_id: z.string()
  },
  async ({ task_id, human_id }) => {
    const task = tasks.get(task_id);
    if (!task) return err(`Unknown task_id ${task_id}.`);
    if (task.status !== "open") return err(`Task ${task_id} is '${task.status}', not 'open'.`);
    const human = HUMANS.find((h) => h.id === human_id);
    if (!human) return err(`Unknown human_id ${human_id}.`);
    if (!human.skills.includes(task.category)) {
      return err(`${human.handle} cannot do '${task.category}' work (skills: ${human.skills.join(", ")}).`);
    }
    task.status = "assigned";
    task.assignedHumanId = human_id;
    return json({
      task_id,
      status: "assigned",
      assigned_to: publicHuman(human),
      next: "Call get_task to retrieve the proof once the human submits."
    });
  }
);

server.tool(
  "get_task",
  "Get the current state of a task. Once a human is assigned, calling this advances the demo: the human submits proof, moving the task to 'submitted' so you can verify it with release_payment.",
  { task_id: z.string() },
  async ({ task_id }) => {
    const task = tasks.get(task_id);
    if (!task) return err(`Unknown task_id ${task_id}.`);

    // Demo progression: an assigned task produces proof on the next poll.
    if (task.status === "assigned") {
      const human = HUMANS.find((h) => h.id === task.assignedHumanId)!;
      task.status = "submitted";
      task.proof = {
        url: `https://proof.cyberdyne-os.xyz/${task_id}`,
        note: `${human.handle} completed "${task.description}" — artifact attached for review against your criteria.`
      };
    }

    return json({
      task_id: task.id,
      status: task.status,
      description: task.description,
      category: task.category,
      criteria: task.criteria,
      reward: task.reward,
      deadline_hours: task.deadlineHours,
      assigned_human_id: task.assignedHumanId ?? null,
      proof: task.proof ?? null,
      receipt: task.receipt ?? null,
      next:
        task.status === "submitted"
          ? "Review the proof, then call release_payment with approve:true to pay, or approve:false to reject."
          : task.status === "settled"
            ? "Done. Funds transferred agent → human; both sides scored."
            : null
    });
  }
);

server.tool(
  "release_payment",
  "Verify a submitted proof and settle. With approve:true the reward transfers directly from your wallet to the human's wallet (no escrow) and both sides are scored up. With approve:false the task is rejected and no funds move.",
  {
    task_id: z.string(),
    approve: z.boolean().describe("true = proof meets criteria → pay; false = reject."),
    score: z.number().min(1).max(5).optional().default(5).describe("Your rating of the human's work (1–5).")
  },
  async ({ task_id, approve, score }) => {
    const task = tasks.get(task_id);
    if (!task) return err(`Unknown task_id ${task_id}.`);
    if (task.status !== "submitted") {
      return err(`Task ${task_id} is '${task.status}'. Only a 'submitted' task can be settled.`);
    }
    const human = HUMANS.find((h) => h.id === task.assignedHumanId)!;

    if (!approve) {
      task.status = "rejected";
      return json({
        task_id,
        status: "rejected",
        paid: 0,
        note: "Proof rejected. No funds moved. You may post_task again."
      });
    }

    // Direct settlement: agent treasury → human wallet.
    treasury = +(treasury - task.reward).toFixed(2);
    const newRep = +Math.min(5, (reputation.get(human.id) ?? human.reputation) + 0.01).toFixed(2);
    reputation.set(human.id, newRep);

    const receipt: Settlement = {
      taskId: task_id,
      from: task.agentWallet,
      to: human.wallet,
      amount: task.reward,
      humanReputationAfter: newRep,
      settledAtSeq: ++seq
    };
    task.status = "settled";
    task.receipt = receipt;

    return json({
      task_id,
      status: "settled",
      settlement: receipt,
      treasury_remaining: treasury,
      note: `Paid $${task.reward.toFixed(2)} from ${task.agentWallet} → ${human.handle} (${human.wallet}). No contract, no escrow.`
    });
  }
);

server.tool(
  "get_treasury",
  "Get the agent's remaining demo treasury balance (the source of task rewards).",
  {},
  async () => json({ treasury_remaining: treasury, currency: "USD (demo)" })
);

// ---- Boot -----------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("CYBERDYNE MCP server running on stdio. Tools: list_categories, search_humans, post_task, assign_task, get_task, release_payment, get_treasury.");
