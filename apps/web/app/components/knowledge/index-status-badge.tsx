import type { IndexingStatus } from "~/lib/knowledge-api";

/*
 * Per-document indexing-status pill. `indexed` earns the ruby brand color (the one "good/active"
 * state); `lexical-only` and `pending` stay muted. Glyph + label, terminal aesthetic, no shadow.
 * The `title` carries a plain-language explanation on hover.
 */
const META: Record<
  IndexingStatus,
  { glyph: string; label: string; className: string; hint: string }
> = {
  indexed: {
    glyph: "●",
    label: "indexed",
    className: "text-primary",
    hint: "Embedded — searchable by vector similarity.",
  },
  "lexical-only": {
    glyph: "◐",
    label: "lexical-only",
    className: "text-muted-foreground",
    hint: "Keyword-searchable only (no embedding provider was available at index time).",
  },
  pending: {
    glyph: "○",
    label: "pending",
    className: "text-muted-foreground",
    hint: "Not indexed yet — indexing runs in the background.",
  },
};

export function IndexStatusBadge({ status }: { status: IndexingStatus }) {
  const m = META[status];
  return (
    <span
      data-status={status}
      title={m.hint}
      className={`inline-flex items-center gap-1 text-xs tracking-[0.1em] ${m.className}`}
    >
      <span aria-hidden>{m.glyph}</span>
      <span>{m.label}</span>
    </span>
  );
}
