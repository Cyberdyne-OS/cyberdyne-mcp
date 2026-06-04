/**
 * Static task taxonomy — the only non-network constant the gateway carries.
 *
 * These are the seven CYBERDYNE task categories (mirrors `TASK_CATEGORIES` in the
 * platform's lib/constants.ts). Everything else — humans, tasks, treasury — now
 * comes from the LIVE platform API; there is no in-memory registry any more.
 */
export const TASK_CATEGORIES = [
    "groundtruth",
    "capture",
    "agenteval",
    "expert",
    "demo",
    "data",
    "social",
];
export const CATEGORIES = {
    groundtruth: "Verify, photograph & ground-truth the real world on location",
    capture: "Capture real audio, video, image & sensor data",
    agenteval: "Rate AI-agent runs, tool calls, red-team & safety",
    expert: "Domain experts review, grade & write hard reasoning data",
    demo: "Show the AI how — record step-by-step demonstrations",
    data: "Quick labeling, preference & transcription microtasks",
    social: "On-platform social actions: follow, repost, reply, quote, original post",
};
