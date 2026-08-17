/**
 * The Memory Document's section contract.
 *
 * Three packages must agree on this vocabulary and none of them owns it: `memory` renders the
 * document, `curator` proposes patches against it, and the API applies them. The budgets that
 * bound a section deliberately stay in `memory` — they are runtime policy, and the *remaining*
 * budget depends on the current document, which no constant can express.
 */

export const MEMORY_SECTION_KEYS = [
  "identity",
  "standing_instructions",
  "working_context",
  "preferences",
  "recent_decisions",
  "other_facts",
] as const;

export type MemorySectionKey = (typeof MEMORY_SECTION_KEYS)[number];

/** Rendered heading per section. Order here is the order in the document. */
export const MEMORY_SECTION_HEADINGS: Record<MemorySectionKey, string> = {
  identity: "Identity",
  standing_instructions: "Standing instructions",
  working_context: "Working context",
  preferences: "Preferences",
  recent_decisions: "Recent decisions",
  other_facts: "Other durable facts",
};

/** The exact line the model is told to write, so what it writes is what the runtime reads. */
export const MEMORY_TIMEZONE_PREFIX = "Timezone: ";

/** What each section is for, shown to the model so it patches the right one. */
export const MEMORY_SECTION_PURPOSE: Record<MemorySectionKey, string> = {
  identity: `who they are: role, team, location, and their timezone as "${MEMORY_TIMEZONE_PREFIX}Area/City"`,
  standing_instructions: "durable always/never rules they have stated",
  working_context: "what they are working on right now",
  preferences: "language, tone, and format preferences",
  recent_decisions: "dated decisions, newest first",
  other_facts: "anything durable that fits nowhere above",
};

export function isMemorySectionKey(value: string): value is MemorySectionKey {
  return (MEMORY_SECTION_KEYS as readonly string[]).includes(value);
}

export type MemorySections = Record<MemorySectionKey, string>;

export function emptyMemorySections(): MemorySections {
  return {
    identity: "",
    standing_instructions: "",
    working_context: "",
    preferences: "",
    recent_decisions: "",
    other_facts: "",
  };
}
