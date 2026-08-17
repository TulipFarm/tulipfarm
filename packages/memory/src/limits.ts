/** Max sequential LLM steps in one chat turn's tool loop (TOOLS spec: max_tool_calls). */
export const MAX_TOOL_STEPS = 25;

/** Conversation compaction starts when coarse history estimate exceeds the model-safe budget. */
export const MAX_HISTORY_TOKENS = 120_000;
/** Keep newest history verbatim; summarize older turns in one pass per overflow. */
export const RECENT_RETENTION_TOKENS = 60_000;
