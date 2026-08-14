import { type JSONContent, mergeAttributes, Node } from "@tiptap/core";

/* Callouts round-trip GitHub-alert blockquotes while ordinary blockquotes stay untouched. */

export const CALLOUT_KINDS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** Matches the leading alert marker of a callout's first line (shared with the read-view renderer). */
export const CALLOUT_ALERT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

// Removes the whole `[!KIND] …` marker line (incl. its trailing newline) from the start of a string.
const MARKER_LINE_RE = /^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\n]*\n?/i;

function normalizeKind(raw: unknown): CalloutKind {
  const k = String(raw ?? "NOTE").toUpperCase();
  return (CALLOUT_KINDS as readonly string[]).includes(k) ? (k as CalloutKind) : "NOTE";
}

type Tok = { type?: string; text?: string; raw?: string; tokens?: Tok[]; [k: string]: unknown };

/** Strips the leading `[!KIND]` marker from cloned blockquote child tokens. */
function stripMarkerTokens(tokens: Tok[]): Tok[] {
  const rest = tokens.slice();
  const first = rest[0];
  if (first?.type !== "paragraph") return rest;

  const para: Tok = { ...first, tokens: (first.tokens ?? []).map((t) => ({ ...t })) };
  const inline = para.tokens as Tok[];
  const firstInline = inline[0];
  if (firstInline && firstInline.type === "text") {
    const stripped = String(firstInline.text ?? "").replace(MARKER_LINE_RE, "");
    firstInline.text = stripped;
    firstInline.raw = stripped;
    if (!stripped) inline.shift();
  }
  para.text = String(para.text ?? "").replace(MARKER_LINE_RE, "");
  para.raw = String(para.raw ?? "").replace(MARKER_LINE_RE, "");

  if (inline.length === 0 && !String(para.text).trim()) {
    rest.shift(); // marker-only paragraph → drop it, keep the rest (lists, more paragraphs)
  } else {
    rest[0] = para;
  }
  return rest;
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  priority: 110,

  addAttributes() {
    return {
      kind: {
        default: "NOTE",
        parseHTML: (el) => normalizeKind(el.getAttribute("data-callout")),
        renderHTML: (attrs) => ({ "data-callout": attrs.kind }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "tf-callout" }), 0];
  },

  // Parse and render both key on `markdownTokenName`, so render must branch on node type.
  markdownTokenName: "blockquote",

  parseMarkdown(token, helpers) {
    const tokens = (token.tokens ?? []) as Tok[];
    const m = CALLOUT_ALERT_RE.exec(String(token.text ?? ""));
    if (!m) {
      // Not an alert → an ordinary blockquote.
      return { type: "blockquote", content: helpers.parseChildren(tokens as never) };
    }
    const body = helpers.parseChildren(stripMarkerTokens(tokens) as never);
    return {
      type: "callout",
      attrs: { kind: m[1].toUpperCase() },
      content: (body.length ? body : [{ type: "paragraph" }]) as JSONContent[],
    };
  },

  renderMarkdown(node, helpers) {
    // Join block children with a blank line so a paragraph followed by a list separates correctly,
    // then prefix every line with `> ` (blank lines become a bare `>`).
    const inner = helpers.renderChildren(node as never, "\n\n").replace(/\n+$/, "");
    const quoted = inner.length
      ? inner
          .split("\n")
          .map((l) => (l.length ? `> ${l}` : ">"))
          .join("\n")
      : ">";
    if (node.type !== "callout") return quoted; // ordinary blockquote
    const kind = normalizeKind(node.attrs?.kind);
    // An empty callout emits just the marker (no bare `>` line) so it still round-trips to a callout.
    return inner.length ? `> [!${kind}]\n${quoted}` : `> [!${kind}]`;
  },
});
