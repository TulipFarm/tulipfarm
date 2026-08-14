/* Wrap resolved `[n]` text only; code, links, and unknown refs stay literal. */

import { type HastNode, walkTextNodes } from "./hast-text-walk";

// Split one text node on `[n]` markers, emitting an anchor for each ref present in `refs` and leaving
// the rest (including unknown refs) as plain text. A fresh regex per call keeps the `/g` `lastIndex`
// state local — no shared module-level cursor.
function splitCitations(text: string, refs: Map<number, string>): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  const re = /\[(\d+)\]/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const url = refs.get(Number(m[1]));
    if (url === undefined) continue; // unknown ref → leave it inside the surrounding text slice
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({
      type: "element",
      tagName: "a",
      properties: { href: url, className: ["tf-citation"] },
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/** No-op when refs are empty; mapped citation numbers become `.tf-citation` anchors. */
export function rehypeCitations(options: { refs: Map<number, string> }) {
  return (tree: HastNode): void => {
    if (options.refs.size === 0) return;
    walkTextNodes(tree, (text) => splitCitations(text, options.refs));
  };
}
