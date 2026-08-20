/** Shared trigger config keeps node names, trigger chars, and serialized prefixes aligned. */

export type MentionKind = "agent" | "skill" | "resource" | "knowledge";

export interface MentionKindConfig {
  kind: MentionKind;
  /** Trigger character; also the prefix written into the serialized message text (`@name`, `/name`, `#name`). */
  char: string;
  /** ProseMirror node name for this mention's inline chip. */
  nodeName: string;
  /** Shown when the menu has nothing to offer. Required so no trigger can render an invisible menu. */
  emptyLabel: string;
  /**
   * Shown while a server-side search is in flight. Present only for search-powered triggers: the
   * suggestion plugin reports `loading` for every trigger, but a statically filtered list is never
   * genuinely pending.
   */
  loadingLabel?: string;
}

export const MENTION_KINDS: readonly MentionKindConfig[] = [
  { kind: "agent", char: "@", nodeName: "mentionAgent", emptyLabel: "No matching Agents." },
  { kind: "skill", char: "/", nodeName: "mentionSkill", emptyLabel: "No matching Skills." },
  {
    kind: "resource",
    char: "#",
    nodeName: "mentionResource",
    emptyLabel: "No matching Resource types.",
  },
  {
    kind: "knowledge",
    char: "~",
    nodeName: "mentionKnowledge",
    emptyLabel: "No matching Knowledge.",
    loadingLabel: "Searching Knowledge…",
  },
];

/** Reverse lookup: ProseMirror node name → its mention config. Used by the serializer. */
export const NODE_TO_KIND: Record<string, MentionKindConfig> = Object.fromEntries(
  MENTION_KINDS.map((c) => [c.nodeName, c])
);

/** Reverse lookup: trigger kind → its config. Used by the menu to label its empty/loading states. */
export const KIND_TO_CONFIG = Object.fromEntries(MENTION_KINDS.map((c) => [c.kind, c])) as Record<
  MentionKind,
  MentionKindConfig
>;
