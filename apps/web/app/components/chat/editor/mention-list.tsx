import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { AgentGlyph } from "~/components/agent-glyph";
import { FileTypeIcon } from "~/components/files/file-type-icon";
import { KIND_TO_CONFIG, type MentionKind } from "./mention-config";
import type { MentionItem } from "./serialize";

/** Imperative key handling keeps suggestion navigation from blurring the editor. */

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<
  MentionListRef,
  {
    items: MentionItem[];
    command: (item: MentionItem) => void;
    /** Trigger kind — picks the empty/loading wording, and agent rows render a glyph avatar. */
    kind: MentionKind;
    /** A search is pending; rendered only for a trigger that declares a `loadingLabel`. */
    loading?: boolean;
    /** The server had more matches than the menu shows, so narrowing the query is worth suggesting. */
    truncated?: boolean;
  }
>(({ items, command, kind, loading = false, truncated = false }, ref) => {
  const [selected, setSelected] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh query yields a fresh list — reset the highlight to the top.
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowUp") {
          setSelected((s) => (s + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [items, selected, command]
  );

  // A menu that renders nothing is indistinguishable from a broken one, so an empty list still
  // draws a labelled panel for every trigger (docs/qa/playbooks/chat.md S4 step 6).
  if (items.length === 0) {
    const { emptyLabel, loadingLabel } = KIND_TO_CONFIG[kind];
    const pending = loading ? loadingLabel : undefined;
    return (
      <div className="w-64 rounded-sm border border-border bg-card p-2 text-sm shadow-md">
        <p className="text-muted-foreground" role={pending ? "status" : undefined}>
          {pending ?? emptyLabel}
        </p>
      </div>
    );
  }

  return (
    <div className="max-h-64 w-64 overflow-y-auto rounded-sm border border-border bg-card p-1 text-sm shadow-md">
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          // Mousedown (not click) so the pick lands before the editor blur cancels the suggestion.
          onMouseDown={(e) => {
            e.preventDefault();
            command(item);
          }}
          className={`flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors ${
            i === selected ? "bg-secondary" : "hover:bg-secondary"
          }`}
        >
          {kind === "agent" ? (
            <AgentGlyph
              name={item.id}
              domain={item.domain}
              autonomy={item.autonomy}
              size="xs"
              decorative
              className="mt-0.5 shrink-0"
            />
          ) : kind === "file" ? (
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-muted">
              <FileTypeIcon
                mediaType={item.mediaType ?? "application/octet-stream"}
                filename={item.label}
              />
            </span>
          ) : null}
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="font-medium text-foreground">{item.label}</span>
            {item.description ? (
              <span className="line-clamp-1 text-xs text-muted-foreground">{item.description}</span>
            ) : null}
          </span>
        </button>
      ))}
      {truncated ? (
        <p className="px-2 py-1.5 text-muted-foreground text-xs">
          More matches. Keep typing to narrow.
        </p>
      ) : null}
    </div>
  );
});

MentionList.displayName = "MentionList";
