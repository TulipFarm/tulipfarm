/*
 * Rehype plugin: render GitHub-alert blockquotes (`> [!NOTE] …`) as callouts. It tags a matching
 * blockquote with `properties.dataCallout = <KIND>` and strips the `[!KIND]` marker from the first
 * paragraph, so the `blockquote` renderer in markdown-view can branch on the kind. Mirrors the
 * canonical grammar in `@tulipfarm/editor` (CALLOUT_KINDS / CALLOUT_ALERT_RE) — kept inline here so
 * the read view doesn't pull the TipTap editor into its bundle.
 */

const ALERT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\n]*\n?/i;

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function rehypeCallouts() {
  return (tree: HastNode) => {
    walk(tree);
  };
}

function walk(node: HastNode): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === "element" && child.tagName === "blockquote") {
      applyCallout(child);
    }
    walk(child);
  }
}

function applyCallout(bq: HastNode): void {
  const firstEl = bq.children?.find((c) => c.type === "element");
  if (!firstEl || firstEl.tagName !== "p" || !firstEl.children) return;
  const firstText = firstEl.children.find((c) => c.type === "text");
  if (!firstText || typeof firstText.value !== "string") return;

  const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(firstText.value);
  if (!m) return;

  bq.properties = { ...(bq.properties ?? {}), dataCallout: m[1].toUpperCase() };
  firstText.value = firstText.value.replace(ALERT_RE, "");

  // If the marker consumed the whole first text node, remove it — plus any leading <br> left by the
  // soft break after the marker line — then drop the paragraph entirely if it is now empty.
  if (!firstText.value) {
    firstEl.children = firstEl.children.filter((c) => c !== firstText);
    const lead = firstEl.children[0];
    if (lead?.type === "element" && lead.tagName === "br") {
      firstEl.children = firstEl.children.filter((c) => c !== lead);
    }
  }
  if (firstEl.children.length === 0) {
    bq.children = bq.children?.filter((c) => c !== firstEl);
  }
}
