/**
 * Working-memory caps (MEM-V1-003). Working memory is a tiny, always-injected, per-user
 * store of stable personal facts — these bounds keep the `<memory>` block small.
 */
export const MAX_ENTRIES = 30;
/** A single value larger than this is "long-form" → rejected toward create_knowledge_page (AC-V1-004). */
export const MAX_VALUE_CHARS = 1024;
export const MAX_KEY_CHARS = 128;
/** Total key+value chars across a user's entries; over this, oldest entries are LRU-evicted. */
export const MAX_TOTAL_CHARS = 2048;
/** Max sequential LLM steps in one chat turn's tool loop (TOOLS spec: max_tool_calls). */
export const MAX_TOOL_STEPS = 25;

/**
 * Conversation compaction budget (CTX-V1-001). When a turn's estimated history token
 * count exceeds this, the oldest turns are summarized into one `summary` row. Estimate
 * is a coarse char heuristic (chars/4); value carries headroom under Anthropic's 200k.
 */
export const MAX_HISTORY_TOKENS = 120_000;
/**
 * How much recent history (estimated tokens) is kept verbatim during compaction. The
 * newest turns fitting within this budget survive; everything older is summarized. Half
 * the budget so the post-compaction estimate lands well under `MAX_HISTORY_TOKENS`,
 * guaranteeing a single summarization pass per overflow (CTX-V1-001).
 */
export const RECENT_RETENTION_TOKENS = 60_000;
