/**
 * The editor's contenteditable can't be driven under jsdom, so all message-shaping logic lives
 * here as plain functions over the ProseMirror JSON (`editor.getJSON()`) and is unit-tested
 * directly. `serializeDoc` produces the wire payload for a turn: - `text` — markdown
 * (bold/italic/code/strike/link) with mentions kept as literal `@/ / /#` tokens - `agentId` —
 * the first `@agent` mention (routes the turn); undefined if none - `skills` — every `/skill`
 * mention id, in order, de-duplicated - `resources`— every `#resource` mention id, in order,
 * de-duplicated `filterItems` is the suggestion-menu filter (prefix matches rank above
 * substring matches).
 */

import type { Autonomy } from "~/lib/agents";
import { type MentionKind, NODE_TO_KIND } from "./mention-config";

/** The slice of a ProseMirror JSON node the serializer reads. */
export interface PMNode {
  type: string;
  text?: string;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

export interface SerializedMessage {
  text: string;
  agentId?: string;
  skills: string[];
  resources: string[];
  knowledge: string[];
}

export interface MentionItem {
  id: string;
  label: string;
  description?: string;
  domain?: string;
  autonomy?: Autonomy;
  model?: string;
}

/** Only http(s)/mailto links survive serialization; unsafe schemes become plain text. */
function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function applyMarks(text: string, marks: PMNode["marks"]): string {
  if (!marks || marks.length === 0) return text;
  const has = (type: string) => marks.some((m) => m.type === type);
  let out = text;
  if (has("code")) out = `\`${out}\``;
  if (has("bold")) out = `**${out}**`;
  if (has("italic")) out = `*${out}*`;
  if (has("strike")) out = `~~${out}~~`;
  const href = safeHref(marks.find((m) => m.type === "link")?.attrs?.href);
  if (href) out = `[${out}](${href})`;
  return out;
}

function serializeInline(
  nodes: PMNode[] | undefined,
  collected: Record<MentionKind, string[]>
): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    const kindConfig = NODE_TO_KIND[node.type];
    if (kindConfig) {
      const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
      const label = typeof node.attrs?.label === "string" ? node.attrs.label : id;
      if (id) collected[kindConfig.kind].push(id);
      out += `${kindConfig.char}${label}`;
      continue;
    }
    if (node.type === "hardBreak") {
      out += "\n";
      continue;
    }
    if (node.type === "text" && typeof node.text === "string") {
      out += applyMarks(node.text, node.marks);
    }
  }
  return out;
}

/** Ordered de-duplication, preserving first occurrence. */
function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function serializeDoc(doc: PMNode): SerializedMessage {
  const collected: Record<MentionKind, string[]> = {
    agent: [],
    skill: [],
    resource: [],
    knowledge: [],
  };
  const blocks = (doc.content ?? []).map((block) => serializeInline(block.content, collected));
  const text = blocks.join("\n\n").trim();
  return {
    text,
    agentId: collected.agent[0],
    skills: uniq(collected.skill),
    resources: uniq(collected.resource),
    knowledge: uniq(collected.knowledge),
  };
}

export function firstAgentMentionId(doc: PMNode): string | undefined {
  for (const block of doc.content ?? []) {
    for (const node of block.content ?? []) {
      if (NODE_TO_KIND[node.type]?.kind === "agent") {
        const id = typeof node.attrs?.id === "string" ? node.attrs.id : undefined;
        if (id) return id;
      }
    }
  }
  return undefined;
}

export function filterItems(query: string, items: MentionItem[], limit = 8): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items.slice(0, limit);
  const scored: { item: MentionItem; rank: number }[] = [];
  for (const item of items) {
    const hay = `${item.label} ${item.id}`.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx === -1) continue;
    const rank =
      item.label.toLowerCase().startsWith(q) || item.id.toLowerCase().startsWith(q) ? 0 : 1;
    scored.push({ item, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((s) => s.item);
}
