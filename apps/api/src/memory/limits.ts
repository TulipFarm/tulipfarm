/**
 * Working-memory caps (MEM-V1-003). Working memory is a tiny, always-injected, per-user
 * store of stable personal facts — these bounds keep the `<memory>` block small. The two
 * binding caps are the entry COUNT and the per-entry VALUE length; `MAX_TOTAL_CHARS` is
 * derived from them as the aggregate ceiling the render path enforces.
 */
export const MAX_ENTRIES = 100;
/**
 * Per-entry value cap. A memory is one short, stable fact (a sentence, not a paragraph); a single
 * value larger than this is "long-form" → rejected toward create_knowledge_page.
 */
export const MAX_VALUE_CHARS = 256;
export const MAX_KEY_CHARS = 128;
/**
 * Total key+value chars across a user's entries; over this, oldest entries are LRU-evicted (and the
 * whole `<memory>` block is dropped at render time). Derived from the count × value caps so it never
 * binds before them — a full store of max-size entries lands right at this aggregate budget.
 */
export const MAX_TOTAL_CHARS = MAX_ENTRIES * MAX_VALUE_CHARS;
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
