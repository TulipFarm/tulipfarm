/*
 * The composer serializes a mention to literal `@<label>` text (the structured chip is lost),
 * and a label may contain spaces ("@Sprint Planner") — so we can't regex-guess a boundary.
 * Instead we wrap occurrences of the EXACT known agent phrases in a `<span
 * class="tf-mention">`, reusing the composer's ruby chip styling.
 */

import { type HastNode, walkTextNodes } from "~/lib/hast-text-walk";

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitMentions(text: string, pattern: RegExp): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({
      type: "element",
      tagName: "span",
      properties: { className: ["tf-mention"] },
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/**
 * Longest-first matching so "@Sprint Planner" beats a "@Sprint" prefix; word boundaries guard
 * against partial hits ("@A" inside "@Andrew") and emails ("foo@bar").
 */
export function rehypeMentions(options: { phrases: string[] }) {
  const phrases = [...new Set(options.phrases.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern =
    phrases.length > 0
      ? new RegExp(`(?<!\\w)(?:${phrases.map(escapeRegExp).join("|")})(?!\\w)`, "g")
      : null;

  return (tree: HastNode): void => {
    if (!pattern) return;
    walkTextNodes(tree, (text) => splitMentions(text, pattern));
  };
}
