/** Shared trigger config keeps node names, trigger chars, and serialized prefixes aligned. */

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
