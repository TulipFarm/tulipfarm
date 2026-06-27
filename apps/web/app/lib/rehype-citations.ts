/*
 * Turn inline `[n]` citation markers in assistant prose into links to the cited knowledge page. The
 * agent writes plain `[1]`/`[2]` markers (not markdown links) and declares the page per ref via the
 * `cite_sources` tool, which arrives as the message's `sources` part. This rehype plugin (operating on
 * the rendered hast tree via the shared `walkTextNodes`, so it never touches code spans or existing
 * links) wraps each `[n]` whose ref has a resolved url in an anchor; unknown refs stay literal text.
 */

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

/**
 * rehype plugin (use as `[rehypeCitations, { refs }]`). `refs` maps a citation number to the wiki url
 * of the page it cites. A `[n]` whose number is in the map becomes a `.tf-citation` anchor; everything
 * else is untouched. No-op when `refs` is empty.
 */
export function rehypeCitations(options: { refs: Map<number, string> }) {
  return (tree: HastNode): void => {
    if (options.refs.size === 0) return;
    walkTextNodes(tree, (text) => splitCitations(text, options.refs));
  };
}
