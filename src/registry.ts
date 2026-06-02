/**
 * CYBERDYNE human registry (demo data).
 *
 * This mirrors the concepts in the app at cyberdyne-web-desktop/src/data.ts —
 * the same four task categories, the same direct agent→human settlement model,
 * the same illustrative short wallet addresses. In production this would be a
 * real database of verified contributors; here it is an in-memory fixture so an
 * agent can connect over MCP and exercise the full flow end to end.
 *
 * Nothing here moves real money. Addresses and balances are illustrative.
 */

export type Category = "audio" | "observation" | "activity" | "data";

export const CATEGORIES: Record<Category, string> = {
  audio: "Record speech, narration & conversational dialogue",
  observation: "Capture real-world visual & spatial data on location",
  activity: "Expert evaluation, inspection & ground-truth verification",
  data: "Label, rank, judge and verify AI data"
};

export interface Human {
  id: string;
  handle: string;
  /** Capability tags an agent can search on. */
  skills: Category[];
  /** Free-form sub-skills for finer matching. */
  tags: string[];
  location: string;
  timezone: string;
  languages: string[];
  devices: string[];
  /** 0–5 reputation, the same scale the app tracks. */
  reputation: number;
  tasksDone: number;
  /** Typical time-to-first-response. */
  responseMins: number;
  available: boolean;
  /** Illustrative payout wallet (no real funds). */
  wallet: string;
}

export const HUMANS: Human[] = [
  {
    id: "h-4827",
    handle: "Human #4827",
    skills: ["audio", "data"],
    tags: ["narration", "multilingual", "transcription", "ranking"],
    location: "Barcelona, ES",
    timezone: "Europe/Madrid",
    languages: ["es", "en", "ca"],
    devices: ["phone", "studio-mic"],
    reputation: 4.9,
    tasksDone: 128,
    responseMins: 6,
    available: true,
    wallet: "0xH4827…b9F2"
  },
  {
    id: "h-0192",
    handle: "Human #0192",
    skills: ["observation", "activity"],
    tags: ["street-photo", "mapping", "ground-truth", "field-visit"],
    location: "Lagos, NG",
    timezone: "Africa/Lagos",
    languages: ["en", "yo"],
    devices: ["phone", "car"],
    reputation: 4.95,
    tasksDone: 412,
    responseMins: 9,
    available: true,
    wallet: "0xH0192…1aa7"
  },
  {
    id: "h-4410",
    handle: "Human #4410",
    skills: ["data", "activity"],
    tags: ["labeling", "moderation", "defect-inspection", "judgment"],
    location: "Manila, PH",
    timezone: "Asia/Manila",
    languages: ["en", "tl"],
    devices: ["laptop", "phone"],
    reputation: 4.88,
    tasksDone: 356,
    responseMins: 4,
    available: true,
    wallet: "0xH4410…6c1d"
  },
  {
    id: "h-2231",
    handle: "Human #2231",
    skills: ["audio"],
    tags: ["expressive-read", "sarcasm", "ambience", "voice-acting"],
    location: "Austin, US",
    timezone: "America/Chicago",
    languages: ["en"],
    devices: ["studio-mic", "phone"],
    reputation: 4.82,
    tasksDone: 219,
    responseMins: 12,
    available: false,
    wallet: "0xH2231…9e44"
  },
  {
    id: "h-7788",
    handle: "Human #7788",
    skills: ["observation"],
    tags: ["spatial-walkthrough", "room-mapping", "object-count"],
    location: "São Paulo, BR",
    timezone: "America/Sao_Paulo",
    languages: ["pt", "en"],
    devices: ["phone", "gimbal"],
    reputation: 4.79,
    tasksDone: 188,
    responseMins: 15,
    available: true,
    wallet: "0xH7788…b022"
  },
  {
    id: "h-1043",
    handle: "Human #1043",
    skills: ["activity", "data"],
    tags: ["sensory", "taste", "smell", "local-verification", "calls"],
    location: "Lyon, FR",
    timezone: "Europe/Paris",
    languages: ["fr", "en"],
    devices: ["phone"],
    reputation: 4.76,
    tasksDone: 141,
    responseMins: 8,
    available: true,
    wallet: "0xH1043…3f70"
  },
  {
    id: "h-3360",
    handle: "Human #3360",
    skills: ["data", "audio"],
    tags: ["handwriting", "transcription", "ranking", "translation"],
    location: "Pune, IN",
    timezone: "Asia/Kolkata",
    languages: ["hi", "en", "mr"],
    devices: ["laptop", "phone"],
    reputation: 4.85,
    tasksDone: 297,
    responseMins: 5,
    available: true,
    wallet: "0xH3360…7d51"
  },
  {
    id: "h-9021",
    handle: "Human #9021",
    skills: ["observation", "activity"],
    tags: ["field-visit", "ground-truth", "business-hours", "signage"],
    location: "Tokyo, JP",
    timezone: "Asia/Tokyo",
    languages: ["ja", "en"],
    devices: ["phone", "bike"],
    reputation: 4.91,
    tasksDone: 263,
    responseMins: 11,
    available: true,
    wallet: "0xH9021…c8e9"
  }
];

/**
 * The requesting agent's treasury — the source of task rewards. Mirrors
 * START_TREASURY in the app. A real deployment would read the agent's own
 * on-chain wallet balance instead.
 */
export const AGENT_TREASURY_START = 8420.5;
