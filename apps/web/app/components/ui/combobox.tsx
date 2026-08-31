import { ChevronsUpDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * How many matches are rendered at once.
 *
 * A provider catalogue runs to several hundred models. Rendering all of them costs a visible
 * frame on every keystroke and buys nothing: past the first screenful the reader is going to
 * narrow the query rather than keep scrolling.
 */
const MAX_VISIBLE = 50;

/** Exact match, then prefix, then substring; -1 drops the option. */
function rank(option: string, query: string): number {
  const o = option.toLowerCase();
  const q = query.toLowerCase();
  if (o === q) return 0;
  if (o.startsWith(q)) return 1;
  return o.includes(q) ? 2 : -1;
}

/**
 * A single text field that both filters a list of suggestions and accepts a value that is not on
 * it.
 *
 * The two-control alternative — a `<select>` plus a "Custom…" escape hatch that reveals an input —
 * is what this replaces. A native `<select>` of 400 model IDs cannot be searched, only scrolled,
 * and it hides the fact that a typed ID is allowed at all.
 *
 * Hand-rolled rather than built on `cmdk`: that library forces its own `id` onto the input after
 * spreading props, so an external `<label htmlFor>` can never bind to it.
 */
export function Combobox({
  id,
  value,
  options,
  onValueChange,
  onCommit,
  placeholder,
  emptyLabel = "No match. It is saved exactly as typed.",
  className,
  inputClassName,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: {
  id?: string;
  value: string;
  options: readonly string[];
  onValueChange: (value: string) => void;
  /** Fired when a suggestion is chosen, or when focus leaves after free typing. */
  onCommit?: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
  inputClassName?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const listId = `${id ?? generatedId}-listbox`;

  const query = value.trim();
  const matches = (
    query === ""
      ? options.slice()
      : options
          .map((option) => ({ option, score: rank(option, query) }))
          .filter((m) => m.score >= 0)
          .sort((a, b) => a.score - b.score || a.option.localeCompare(b.option))
          .map((m) => m.option)
  ).slice(0, MAX_VISIBLE);

  // Keeps the highlighted row in view while arrowing through a list taller than the popover.
  // Guarded because jsdom does not implement scrollIntoView.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.children[active];
    if (row instanceof HTMLElement) row.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function commit(next: string) {
    onValueChange(next);
    setOpen(false);
    onCommit?.(next);
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onValueChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Only a move out of the whole widget closes it. Focus crossing into the list is still
          // inside, and closing there would cancel the click that caused it.
          if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
          setOpen(false);
          if (value.trim()) onCommit?.(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive((i) => (i + 1) % Math.max(matches.length, 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i - 1 + matches.length) % Math.max(matches.length, 1));
          } else if (e.key === "Enter" && open && matches[active]) {
            e.preventDefault();
            commit(matches[active]);
          } else if (e.key === "Escape" && open) {
            // Stopped here so the surrounding Sheet does not also read it as "close me".
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={cn(
          "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 pr-9 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none",
          "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
          inputClassName
        )}
      />
      <ChevronsUpDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />

      {open ? (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
          {/*
            Roles on generic elements, not ul/li: an `li` carrying role="option" is a
            non-interactive element given an interactive role, which is both a lint error and a
            worse tree for a screen reader than a plain listbox of options.
          */}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-64 overflow-y-auto overscroll-contain p-1"
          >
            {matches.map((option, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: an aria-activedescendant listbox deliberately leaves options unfocusable and keeps focus on the input; that is what makes the pattern work.
              <div
                key={option}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={option === value}
                // Pointer-down rather than click: click fires after blur, which has already
                // closed the list and unmounted the row being clicked.
                onPointerDown={(e) => {
                  e.preventDefault();
                  commit(option);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "cursor-pointer truncate rounded-sm px-3 py-1.5 font-mono text-sm text-foreground",
                  i === active && "bg-accent text-accent-foreground"
                )}
              >
                {option}
              </div>
            ))}
          </div>
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{emptyLabel}</p>
          ) : null}
          {options.length > matches.length ? (
            <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
              Showing {matches.length} of {options.length}. Type to narrow.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
