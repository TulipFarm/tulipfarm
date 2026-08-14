import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { AgentGlyph } from "~/components/agent-glyph";
import type { MentionKind } from "./mention-config";
import type { MentionItem } from "./serialize";

/** Imperative key handling keeps suggestion navigation from blurring the editor. */

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<
  MentionListRef,
  {
    items: MentionItem[];
    command: (item: { id: string; label: string }) => void;
    /** Trigger kind — agent rows render a glyph avatar; skill/resource rows don't. */
    kind?: MentionKind;
  }
>(({ items, command, kind }, ref) => {
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
          if (item) command({ id: item.id, label: item.label });
          return true;
        }
        return false;
      },
    }),
    [items, selected, command]
  );

  if (items.length === 0) return null;

  return (
    <div className="max-h-64 w-64 overflow-y-auto rounded-sm border border-border bg-card p-1 text-sm shadow-md">
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          // Mousedown (not click) so the pick lands before the editor blur cancels the suggestion.
          onMouseDown={(e) => {
            e.preventDefault();
            command({ id: item.id, label: item.label });
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
          ) : null}
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="font-medium text-foreground">{item.label}</span>
            {item.description ? (
              <span className="line-clamp-1 text-xs text-muted-foreground">{item.description}</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
});

MentionList.displayName = "MentionList";
