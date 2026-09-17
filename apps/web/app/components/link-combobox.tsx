import { type Ref, useEffect, useId, useMemo, useRef, useState } from "react";
import { listRecords } from "~/lib/api";
import { recordLabel } from "~/lib/schema";

/*
 * Loads the first page of the target type's records and filters client-side by label as the
 * user types. The stored value is the target `record.id` — exactly what the API's link
 * validation (findById) consumes and what the read-side detail link points at.
 *
 * Keyboard navigation follows the aria-activedescendant listbox pattern from `ui/combobox.tsx`:
 * options are non-focusable `role="option"` rows and focus stays on the input throughout, so Tab
 * always leaves the whole widget in one step instead of walking through option buttons first.
 */

type Option = { id: string; label: string };

export function LinkCombobox({
  target,
  value,
  onChange,
  id,
  clearable = false,
  inputRef,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  target: string;
  value: string;
  onChange: (id: string) => void;
  id?: string;
  clearable?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();

  useEffect(() => {
    let isActive = true;
    listRecords(target)
      .then((page) => {
        if (isActive) setOptions(page.items.map((r) => ({ id: r.id, label: recordLabel(r) })));
      })
      .catch((err) => {
        if (isActive) setLoadError(err instanceof Error ? err.message : "failed to load options");
      });
    return () => {
      isActive = false;
    };
  }, [target]);

  const selectedLabel = useMemo(
    () => options.find((o) => o.id === value)?.label ?? value,
    [options, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 50);
    return options
      .filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
      .slice(0, 50);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.children[active];
    if (row instanceof HTMLElement) row.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function select(option: Option) {
    onChange(option.id);
    setQuery("");
    setOpen(false);
  }

  function clear() {
    onChange("");
    setQuery("");
    setOpen(false);
    setActive(0);
  }

  const listId = `${id ?? generatedId}-list`;
  const clearLabel = id ?? target;

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        autoComplete="off"
        className={`w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
          clearable && value ? "pr-16" : ""
        }`}
        placeholder={value ? selectedLabel : `search ${target}…`}
        value={open ? query : value ? selectedLabel : ""}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
          setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive((i) => (i + 1) % Math.max(filtered.length, 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive((i) => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
          } else if (e.key === "Enter" && open && filtered[active]) {
            e.preventDefault();
            select(filtered[active]);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {clearable && value ? (
        <button
          type="button"
          aria-label={`Clear ${clearLabel} selection`}
          className="absolute top-1 right-2 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={clear}
        >
          Clear
        </button>
      ) : null}
      {loadError ? <p className="mt-1 text-xs text-destructive">error: {loadError}</p> : null}
      {open ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-sm border border-border bg-card text-sm"
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-muted-foreground">no {target} records</p>
          ) : (
            filtered.map((option, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: an aria-activedescendant listbox deliberately leaves options unfocusable and keeps focus on the input; that is what makes the pattern work.
              <div
                key={option.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={option.id === value}
                className={`flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left hover:bg-accent ${
                  i === active ? "bg-accent" : ""
                }`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  select(option);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="truncate">{option.label}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{option.id}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
