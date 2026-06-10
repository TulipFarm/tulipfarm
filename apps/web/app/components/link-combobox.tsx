import { useEffect, useMemo, useRef, useState } from "react";
import { type ResourceRecord, listRecords } from "~/lib/api";

/*
 * Searchable combobox for an `x-links` field (AC-V1-002). Loads the first page of the target type's
 * records and filters client-side by label as the user types. The stored value is the target
 * `record.id` — exactly what the API's link validation (findById) consumes and what the read-side
 * detail link points at. Large target sets are truncated to one page (server-side search deferred).
 */

const SYSTEM = new Set(["id", "version", "createdAt", "updatedAt", "deletedAt"]);
const LABEL_HINTS = ["name", "title", "label", "summary"];

// Best human label for a target record: a hinted field, else the first non-system string, else id.
function labelFor(record: ResourceRecord): string {
  for (const hint of LABEL_HINTS) {
    if (typeof record[hint] === "string" && record[hint]) return record[hint] as string;
  }
  for (const [k, v] of Object.entries(record)) {
    if (!SYSTEM.has(k) && typeof v === "string" && v) return v;
  }
  return record.id;
}

type Option = { id: string; label: string };

export function LinkCombobox({
  target,
  value,
  onChange,
  id,
}: {
  target: string;
  value: string;
  onChange: (id: string) => void;
  id?: string;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // A malformed `x-links` (missing target) would make us list the whole resource root —
    // skip the fetch and surface a clear error instead of a confusing raw load failure.
    if (!target) {
      setLoadError("link target not configured");
      return;
    }
    let active = true;
    listRecords(target)
      .then((page) => {
        if (active) setOptions(page.items.map((r) => ({ id: r.id, label: labelFor(r) })));
      })
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : "failed to load options");
      });
    return () => {
      active = false;
    };
  }, [target]);

  // Clear a pending blur-close timer if we unmount within its window (e.g. select → parent navigates).
  useEffect(() => () => clearTimeout(blurTimer.current), []);

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

  function select(option: Option) {
    onChange(option.id);
    setQuery("");
    setOpen(false);
  }

  const listId = id ? `${id}-list` : undefined;

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        className="w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        placeholder={value ? selectedLabel : `search ${target}…`}
        value={open ? query : value ? selectedLabel : ""}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer so an option's onMouseDown/click registers before the list unmounts.
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
      />
      {loadError ? <p className="mt-1 text-xs text-destructive">error: {loadError}</p> : null}
      {open ? (
        <ul
          id={listId}
          className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-sm border border-border bg-card text-sm shadow-sm"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">no {target} records</li>
          ) : (
            filtered.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  aria-pressed={option.id === value}
                  className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-accent"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (blurTimer.current) clearTimeout(blurTimer.current);
                    select(option);
                  }}
                >
                  <span className="truncate">{option.label}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {option.id}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
