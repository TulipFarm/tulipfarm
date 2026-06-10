import { Link } from "@remix-run/react";
import { type FormEvent, useRef, useState } from "react";
import { LinkCombobox } from "~/components/link-combobox";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import type { FieldDescriptor } from "~/lib/schema";

/*
 * Generic schema-driven create/edit form (AC-V1-002 write subset). Renders one control per editable
 * field (from `formFields`) following the A2UI type→input mapping: string→text, number→numeric,
 * boolean→checkbox, enum→select, date→date input, array/object→JSON textarea, x-links→combobox.
 * `x-immutable` fields are read-only on edit. Validation is server-authoritative: the parent passes
 * `formError` (banner) and `fieldErrors` (mapped from the API's 422 `path`). The only client-side
 * check is JSON parseability of array/object textareas, surfaced inline before submit.
 */

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

function isJsonKind(field: FieldDescriptor): boolean {
  return field.kind === "array" || field.kind === "object";
}

function isDateTime(field: FieldDescriptor): boolean {
  return field.kind === "date" && field.format === "date-time";
}

// Stored value -> the lexical form the date/datetime-local input expects. `<input type="date">`
// needs YYYY-MM-DD and datetime-local needs YYYY-MM-DDTHH:mm (no trailing Z/seconds); feeding a
// full ISO string blanks the control. Returns "" for unparseable input so the field shows empty.
function toDateInput(value: unknown, dateTime: boolean): string {
  if (value === undefined || value === null || value === "") return "";
  if (!dateTime) return String(value).slice(0, 10); // date is tz-agnostic — keep YYYY-MM-DD
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  // Local components so the displayed wall-clock time matches the stored instant.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Date input lexical value -> the wire form the API's JSON-Schema validation accepts: a plain date
// passes through as YYYY-MM-DD; a datetime-local value is promoted to a full RFC3339 ISO string.
function fromDateInput(value: string, dateTime: boolean): string {
  if (value === "") return "";
  if (!dateTime) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

// Coerce a select's string value back to the enum's declared JSON type (numbers/booleans) so the
// server doesn't 422 on `enum: [1,2,3]` receiving "1". Unknown/string enums pass through.
function coerceEnum(value: unknown, enumType: FieldDescriptor["enumType"]): unknown {
  if (typeof value !== "string" || value === "") return value;
  if (enumType === "number" || enumType === "integer") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (enumType === "boolean") return value === "true";
  return value;
}

// Initial scalar value for a field, from the record (edit) or a kind-appropriate empty (create).
function initialValue(field: FieldDescriptor, initial?: Record<string, unknown>): unknown {
  const v = initial?.[field.name];
  if (v === undefined || v === null) return field.kind === "boolean" ? false : "";
  // Date fields are held in the input's lexical form throughout, then converted back on submit.
  if (field.kind === "date") return toDateInput(v, isDateTime(field));
  if (field.kind === "enum") return String(v); // <select> values are strings; coerced on submit
  return v;
}

// Maps a thrown write error into form state: a 422 with a `path` highlights the offending field; a
// 409 becomes a concurrency banner; anything else becomes a generic banner. Shared by both routes.
export function writeErrorState(err: unknown): {
  fieldErrors: Record<string, string>;
  formError: string;
} {
  if (err instanceof ApiError) {
    if (err.status === 422 && err.path) {
      const name = err.path.replace(/^\//, "").split("/")[0];
      return { fieldErrors: { [name]: err.message }, formError: "" };
    }
    if (err.status === 409) {
      return {
        fieldErrors: {},
        formError: "this record changed since you loaded it — reload and retry",
      };
    }
    return { fieldErrors: {}, formError: err.message };
  }
  return { fieldErrors: {}, formError: err instanceof Error ? err.message : "request failed" };
}

export type ResourceFormProps = {
  fields: FieldDescriptor[];
  mode: "create" | "edit";
  initial?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
  submitting: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string | null;
  cancelTo: string;
};

export function ResourceForm({
  fields,
  mode,
  initial,
  onSubmit,
  submitting,
  fieldErrors = {},
  formError,
  cancelTo,
}: ResourceFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields.filter((f) => !isJsonKind(f)).map((f) => [f.name, initialValue(f, initial)])
    )
  );
  const [jsonText, setJsonText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields
        .filter(isJsonKind)
        .map((f) => [
          f.name,
          initial?.[f.name] !== undefined ? JSON.stringify(initial[f.name], null, 2) : "",
        ])
    )
  );
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});
  // Fields the user actually interacted with — used so an untouched optional boolean isn't
  // force-submitted as `false` on create (which would override a server-side default of true).
  const touched = useRef<Set<string>>(new Set());

  function set(name: string, value: unknown) {
    touched.current.add(name);
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {};
    const nextJsonErrors: Record<string, string> = {};

    for (const field of fields) {
      const readonlyImmutable = mode === "edit" && field.immutable;

      if (isJsonKind(field)) {
        const raw = jsonText[field.name]?.trim() ?? "";
        if (readonlyImmutable) {
          if (initial?.[field.name] !== undefined) payload[field.name] = initial[field.name];
          continue;
        }
        if (raw === "") continue; // optional / left blank
        try {
          payload[field.name] = JSON.parse(raw);
        } catch {
          nextJsonErrors[field.name] = "invalid JSON";
        }
        continue;
      }

      if (readonlyImmutable) {
        if (initial?.[field.name] !== undefined) payload[field.name] = initial[field.name];
        continue;
      }

      const value = values[field.name];
      if (field.kind === "boolean") {
        // On edit (full-replace) always send the current value to preserve it; on create,
        // only send when the user touched it or it's required — else let the server default.
        if (mode === "edit" || field.required || touched.current.has(field.name)) {
          payload[field.name] = Boolean(value);
        }
      } else if (field.kind === "number") {
        if (value === "" || value === undefined) continue;
        payload[field.name] = Number(value);
      } else if (field.kind === "enum") {
        if (value === "" || value === undefined) continue;
        payload[field.name] = coerceEnum(value, field.enumType);
      } else if (field.kind === "date") {
        const wire = fromDateInput(String(value ?? ""), isDateTime(field));
        if (wire === "") continue;
        payload[field.name] = wire;
      } else {
        if (value === "" || value === undefined) continue; // omit empty optional strings
        payload[field.name] = value;
      }
    }

    if (Object.keys(nextJsonErrors).length > 0) {
      setJsonErrors(nextJsonErrors);
      return;
    }
    setJsonErrors({});
    onSubmit(payload);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {formError ? (
        <p className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
          error: {formError}
        </p>
      ) : null}

      {fields.map((field) => {
        const readOnly = mode === "edit" && field.immutable === true;
        const error = fieldErrors[field.name] ?? jsonErrors[field.name];
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <label htmlFor={field.name} className="text-xs text-muted-foreground">
              {field.name}
              {field.required ? <span className="text-primary"> *</span> : null}
              {readOnly ? <span className="opacity-60"> (immutable)</span> : null}
            </label>
            <Field
              field={field}
              value={values[field.name]}
              jsonValue={jsonText[field.name]}
              readOnly={readOnly}
              onValue={(v) => set(field.name, v)}
              onJson={(v) => setJsonText((prev) => ({ ...prev, [field.name]: v }))}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? "saving…" : mode === "create" ? "Create" : "Save"}
        </Button>
        <Button asChild variant="outline">
          <Link to={cancelTo}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function Field({
  field,
  value,
  jsonValue,
  readOnly,
  onValue,
  onJson,
}: {
  field: FieldDescriptor;
  value: unknown;
  jsonValue?: string;
  readOnly: boolean;
  onValue: (v: unknown) => void;
  onJson: (v: string) => void;
}) {
  if (readOnly) {
    const display = isJsonKind(field) ? (jsonValue ?? "") : String(value ?? "—");
    return <input id={field.name} className={inputClass} value={display} disabled readOnly />;
  }

  switch (field.kind) {
    case "boolean":
      return (
        <input
          id={field.name}
          type="checkbox"
          className="size-4 accent-primary"
          checked={Boolean(value)}
          onChange={(e) => onValue(e.target.checked)}
        />
      );
    case "number":
      return (
        <input
          id={field.name}
          type="number"
          className={inputClass}
          required={field.required}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onValue(e.target.value)}
        />
      );
    case "enum":
      return (
        <select
          id={field.name}
          className={inputClass}
          required={field.required}
          value={String(value ?? "")}
          onChange={(e) => onValue(e.target.value)}
        >
          <option value="">—</option>
          {(field.enumValues ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case "date":
      return (
        <input
          id={field.name}
          type={field.format === "date-time" ? "datetime-local" : "date"}
          className={inputClass}
          required={field.required}
          value={String(value ?? "")}
          onChange={(e) => onValue(e.target.value)}
        />
      );
    case "link":
      return (
        <LinkCombobox
          id={field.name}
          target={field.linkTarget ?? ""}
          value={String(value ?? "")}
          onChange={onValue}
        />
      );
    case "array":
    case "object":
      return (
        <textarea
          id={field.name}
          className={`${inputClass} min-h-24 font-mono`}
          placeholder={field.kind === "array" ? "[ ... ]" : "{ ... }"}
          value={jsonValue ?? ""}
          onChange={(e) => onJson(e.target.value)}
        />
      );
    default:
      return (
        <input
          id={field.name}
          type="text"
          className={inputClass}
          required={field.required}
          value={String(value ?? "")}
          onChange={(e) => onValue(e.target.value)}
        />
      );
  }
}
