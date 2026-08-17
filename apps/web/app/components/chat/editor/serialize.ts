/**
 * The editor's contenteditable can't be driven under jsdom, so all message-shaping logic lives
 * here as plain functions over the ProseMirror JSON (`editor.getJSON()`) and is unit-tested
 * directly. `serializeDoc` produces the wire payload for a turn: - `text` — markdown (block
 * structure plus bold/italic/code/strike/link) with mentions kept as literal `@/ / /# / ~`
 * tokens - `agentId` — the first `@agent` mention (routes the turn); undefined if none -
 * `skills` — every `/skill` mention id, in order, de-duplicated - `resources`— every
 * `#resource` mention id, in order, de-duplicated `filterItems` is the suggestion-menu filter
 * (prefix matches rank above substring matches).
 *
 * Block walking is recursive because pasted rich text nests blocks inside blocks
 * (`bulletList > listItem > paragraph`, `blockquote > paragraph`). A flat walk drops every one
 * of those, so a pasted document arrives as a handful of bare headings and nothing else.
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

type Collected = Record<MentionKind, string[]>;

/** Nodes the inline pass renders directly; anything else is a block and must be recursed into. */
function isInline(node: PMNode): boolean {
  return node.type === "text" || node.type === "hardBreak" || NODE_TO_KIND[node.type] !== undefined;
}

function serializeInline(nodes: PMNode[] | undefined, collected: Collected): string {
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

/** Prefixes the first line with `first` and every later line with `rest`, keeping blank lines bare. */
function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => {
      const prefix = index === 0 ? first : rest;
      return line === "" ? prefix.trimEnd() : `${prefix}${line}`;
    })
    .join("\n");
}

function serializeList(node: PMNode, collected: Collected, ordered: boolean): string {
  const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
  return (node.content ?? [])
    .map((item, index) => {
      const marker = ordered ? `${start + index}. ` : "- ";
      const body = serializeBlocks(item.content, collected).join("\n\n");
      return prefixLines(body, marker, " ".repeat(marker.length));
    })
    .join("\n");
}

/** Marks never apply inside a fence, and the fence grows past any backtick run in the code. */
function serializeCodeBlock(node: PMNode): string {
  const code = (node.content ?? []).map((n) => (typeof n.text === "string" ? n.text : "")).join("");
  const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function serializeBlock(node: PMNode, collected: Collected): string {
  switch (node.type) {
    case "bulletList":
      return serializeList(node, collected, false);
    case "orderedList":
      return serializeList(node, collected, true);
    case "blockquote":
      return prefixLines(serializeBlocks(node.content, collected).join("\n\n"), "> ", "> ");
    case "codeBlock":
      return serializeCodeBlock(node);
    case "horizontalRule":
      return "---";
    default: {
      const children = node.content ?? [];
      // An unknown wrapper still gets walked, so no schema addition can silently drop text.
      return children.some((child) => !isInline(child))
        ? serializeBlocks(children, collected).join("\n\n")
        : serializeInline(children, collected);
    }
  }
}

/** Each block as its own markdown chunk; empty blocks drop out rather than leaving blank runs. */
function serializeBlocks(nodes: PMNode[] | undefined, collected: Collected): string[] {
  return (nodes ?? [])
    .map((node) => serializeBlock(node, collected))
    .filter((block) => block !== "");
}

export function serializeDoc(doc: PMNode): SerializedMessage {
  const collected: Collected = {
    agent: [],
    skill: [],
    resource: [],
    knowledge: [],
  };
  const text = serializeBlocks(doc.content, collected).join("\n\n").trim();
  return {
    text,
    agentId: collected.agent[0],
    skills: uniq(collected.skill),
    resources: uniq(collected.resource),
    knowledge: uniq(collected.knowledge),
  };
}

export function firstAgentMentionId(doc: PMNode): string | undefined {
  for (const node of doc.content ?? []) {
    if (NODE_TO_KIND[node.type]?.kind === "agent") {
      const id = typeof node.attrs?.id === "string" ? node.attrs.id : undefined;
      if (id) return id;
    }
    const nested = firstAgentMentionId(node);
    if (nested) return nested;
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
