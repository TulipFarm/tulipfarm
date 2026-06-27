/*
 * Rehype plugin: turn inline `#tag` tokens in a rendered page body into chip links to the
 * tag-filtered listing. Mirrors `chat/mention-highlight.ts` — it walks the hast tree (so it never
 * fires inside code spans or existing links) and splits matching text nodes into `<a class="tf-tag-chip">`
 * anchors with an internal `/knowledge/tags/<tag>` href (the markdown view renders internal hrefs as
 * client-side links). Headings keep their `#` markers stripped by markdown already, so only genuine
 * inline `#word` tokens match.
 */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP_TAGS = new Set(["code", "pre", "a"]);

function splitTags(text: string, tagBase: string): HastNode[] {
  // A tag is `#` + a LETTER-led slug, anchored to a word boundary (start / whitespace / "("). The
  // letter-first rule excludes numeric refs like `#123`. Local (not module-scoped) so the stateful
  // `/g` `lastIndex` can't be corrupted by an interleaved render. Mirrors `inline-tags.ts`.
  const re = /(^|[\s(])#([a-z][a-z0-9_-]*)/gi;
  const out: HastNode[] = [];
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const lead = m[1];
    const tag = m[2];
    const hashAt = m.index + lead.length;
    if (hashAt > last) out.push({ type: "text", value: text.slice(last, hashAt) });
    out.push({
      type: "element",
      tagName: "a",
      properties: {
        className: ["tf-tag-chip"],
        href: `${tagBase}${encodeURIComponent(tag.toLowerCase())}`,
      },
      children: [{ type: "text", value: `#${tag}` }],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ type: "text", value: text.slice(last) });
  return out;
}

export function rehypeTags(options: { tagBase: string }) {
  return (tree: HastNode): void => {
    const walk = (node: HastNode): void => {
      if (!node.children) return;
      if (node.tagName && SKIP_TAGS.has(node.tagName)) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
          next.push(...splitTags(child.value, options.tagBase));
        } else {
          walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}
