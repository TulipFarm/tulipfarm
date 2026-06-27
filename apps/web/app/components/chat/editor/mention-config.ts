/**
 * Shared, dependency-free config for the composer's three mention triggers. Both the pure serializer
 * (`serialize.ts`) and the Tiptap glue (`mentions.ts`) import this so the ProseMirror node names, the
 * trigger characters, and the serialized token prefixes can never drift apart.
 *
 *   @agent    → routes the turn (first one wins, sets `agentId`)
 *   /skill    → eagerly loads the skill body into the agent's context for this turn
 *   #resource → eagerly loads the resource type's schema into context for this turn
 *   ~knowledge→ pins a knowledge page's content into context (search-powered, server fuzzy search)
 */

export type MentionKind = "agent" | "skill" | "resource" | "knowledge";

export interface MentionKindConfig {
  kind: MentionKind;
  /** Trigger character; also the prefix written into the serialized message text (`@name`, `/name`, `#name`). */
  char: string;
  /** ProseMirror node name for this mention's inline chip. */
  nodeName: string;
}

export const MENTION_KINDS: readonly MentionKindConfig[] = [
  { kind: "agent", char: "@", nodeName: "mentionAgent" },
  { kind: "skill", char: "/", nodeName: "mentionSkill" },
  { kind: "resource", char: "#", nodeName: "mentionResource" },
  { kind: "knowledge", char: "~", nodeName: "mentionKnowledge" },
];

/** Reverse lookup: ProseMirror node name → its mention config. Used by the serializer. */
export const NODE_TO_KIND: Record<string, MentionKindConfig> = Object.fromEntries(
  MENTION_KINDS.map((c) => [c.nodeName, c])
);
