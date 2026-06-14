import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { MentionItem } from "./serialize";

/**
 * The `@`/`/`/`#` suggestion dropdown. Rendered into `document.body` by the Tiptap suggestion glue
 * (`mentions.ts`) via `ReactRenderer`, positioned above the caret. Keyboard navigation is driven
 * imperatively through the exposed `onKeyDown` (the suggestion plugin forwards keystrokes to it),
 * so arrows/enter/tab move and pick without the editor losing focus. Styled to match the portalled
 * dropdown in `model-selector.tsx` (flat card surface, hairline border, ruby on the active row).
 */

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<
  MentionListRef,
  { items: MentionItem[]; command: (item: { id: string; label: string }) => void }
>(({ items, command }, ref) => {
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
          className={`flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left transition-colors ${
            i === selected ? "bg-secondary" : "hover:bg-secondary"
          }`}
        >
          <span className="font-medium text-foreground">{item.label}</span>
          {item.description ? (
            <span className="line-clamp-1 text-xs text-muted-foreground">{item.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
});

MentionList.displayName = "MentionList";
