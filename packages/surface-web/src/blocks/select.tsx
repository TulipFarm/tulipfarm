/**
 * Themed replacements for native `<select>` and `<select multiple>`.
 *
 * A native `<select multiple>` selects with the OS's own listbox model: a plain click on an
 * option replaces the whole selection with just that option, and only `Cmd`/`Ctrl`-click adds to
 * it. That model is correct for a desktop file picker and wrong for a web form, where a reader
 * expects a click to toggle the option it lands on. `SurfaceMultiSelect` below replaces that model
 * rather than working around it. `SurfaceSelect` gets the same popup and keyboard handling for the
 * single-value case, so the two share one listbox implementation.
 */

import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" data-surface-select-icon>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" data-surface-select-check>
      <path d="M3.5 8.5l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

/** Opens/closes a listbox popup, closing it on an outside click or focus leaving the widget. */
function useListboxPopup(rootRef: RefObject<HTMLDivElement | null>) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, rootRef]);

  return [open, setOpen] as const;
}

function moveActive(current: number, count: number, delta: number): number {
  if (count === 0) return -1;
  return (current + delta + count) % count;
}

export function SurfaceSelect({
  id,
  name,
  options,
  value,
  required,
  dataInput,
  placeholder = "Select an option",
  onChange,
}: {
  readonly id: string;
  readonly name: string;
  readonly options: readonly string[];
  readonly value: string | undefined;
  readonly required?: boolean;
  /** Mirrors what the native control's `data-surface-input` used to name, e.g. `"user"`. */
  readonly dataInput: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useListboxPopup(rootRef);
  const [active, setActive] = useState(() => Math.max(options.indexOf(value ?? ""), 0));
  const listId = `${id}-listbox`;
  const selectedIndex = value === undefined ? -1 : options.indexOf(value);

  const commit = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    onChange(option);
    setOpen(false);
  };

  return (
    <div ref={rootRef} data-surface-select>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-required={required || undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        data-surface-input={dataInput}
        data-surface-select-trigger
        onClick={() => {
          if (!open) setActive(Math.max(selectedIndex, 0));
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              setActive(Math.max(selectedIndex, 0));
              return;
            }
            setActive((current) =>
              moveActive(current, options.length, event.key === "ArrowDown" ? 1 : -1)
            );
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) commit(active);
            else setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <span data-surface-select-value data-placeholder={value === undefined ? "true" : undefined}>
          {value ?? placeholder}
        </span>
        <Chevron />
      </button>
      {/* Carries the value under `name` for parity with the fields around it; the Form reads
          state via `onChange`, not FormData, so this exists for consistency rather than submission. */}
      <input type="hidden" name={name} value={value ?? ""} required={required} />
      {open ? (
        <div id={listId} role="listbox" aria-label={placeholder} data-surface-select-popup>
          {options.map((option, index) => (
            <div
              key={option}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === selectedIndex}
              data-surface-select-option
              data-active={index === active ? "true" : undefined}
              onPointerDown={(event) => {
                event.preventDefault();
                commit(index);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span>{option}</span>
              {index === selectedIndex ? <Check /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SurfaceMultiSelect({
  id,
  name,
  options,
  values,
  required,
  placeholder = "Select options",
  onChange,
}: {
  readonly id: string;
  readonly name: string;
  readonly options: readonly string[];
  readonly values: readonly string[];
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly onChange: (values: readonly string[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useListboxPopup(rootRef);
  const [active, setActive] = useState(0);
  const listId = `${id}-listbox`;
  const summary =
    values.length === 0
      ? placeholder
      : values.length === 1
        ? values[0]
        : `${values.length} selected`;

  const toggle = (option: string) => {
    onChange(
      values.includes(option) ? values.filter((value) => value !== option) : [...values, option]
    );
  };

  return (
    <div ref={rootRef} data-surface-select>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-required={required || undefined}
        data-surface-input="multiselect"
        data-surface-select-trigger
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            setActive((current) =>
              moveActive(current, options.length, event.key === "ArrowDown" ? 1 : -1)
            );
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) {
              const option = options[active];
              if (option !== undefined) toggle(option);
            } else {
              setOpen(true);
            }
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <span data-surface-select-value data-placeholder={values.length === 0 ? "true" : undefined}>
          {summary}
        </span>
        <Chevron />
      </button>
      {values.length === 0 ? (
        <input type="hidden" name={name} required={required} value="" />
      ) : (
        values.map((value) => <input key={value} type="hidden" name={name} value={value} />)
      )}
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={placeholder}
          data-surface-select-popup
        >
          {options.map((option, index) => {
            const selected = values.includes(option);
            return (
              <div
                key={option}
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                data-surface-select-option
                data-active={index === active ? "true" : undefined}
                onPointerDown={(event) => {
                  event.preventDefault();
                  toggle(option);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span>{option}</span>
                {selected ? <Check /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
