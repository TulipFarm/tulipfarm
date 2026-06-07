/**
 * Working-memory caps (MEM-V1-003). Working memory is a tiny, always-injected, per-user
 * store of stable personal facts — these bounds keep the `<memory>` block small.
 */
export const MAX_ENTRIES = 30;
/** A single value larger than this is "document-sized" → rejected toward create_knowledge_document (AC-V1-004). */
export const MAX_VALUE_CHARS = 1024;
export const MAX_KEY_CHARS = 128;
/** Total key+value chars across a user's entries; over this, oldest entries are LRU-evicted. */
export const MAX_TOTAL_CHARS = 2048;
/** Max sequential LLM steps in one chat turn's tool loop (TOOLS spec: max_tool_calls). */
export const MAX_TOOL_STEPS = 25;
