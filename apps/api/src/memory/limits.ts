/** Memory caps keep always-injected per-user facts small. */
export const MAX_ENTRIES = 100;
/**
 * Per-entry value cap. A memory is one short, stable fact (a sentence, not a paragraph); a single
 * value larger than this is "long-form" → rejected toward create_knowledge_page.
 */
export const MAX_VALUE_CHARS = 256;
export const MAX_KEY_CHARS = 128;
/** Aggregate memory cap is derived so count and per-value caps bind first. */
export const MAX_TOTAL_CHARS = MAX_ENTRIES * MAX_VALUE_CHARS;
/** Max sequential LLM steps in one chat turn's tool loop (TOOLS spec: max_tool_calls). */
export const MAX_TOOL_STEPS = 25;

/** Conversation compaction starts when coarse history estimate exceeds the model-safe budget. */
export const MAX_HISTORY_TOKENS = 120_000;
/** Keep newest history verbatim; summarize older turns in one pass per overflow. */
export const RECENT_RETENTION_TOKENS = 60_000;
