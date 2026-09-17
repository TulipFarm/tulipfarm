import { type FormEvent, useRef, useState } from "react";
import { LinkCombobox } from "~/components/link-combobox";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { Textarea } from "~/components/ui/textarea";
import { UnsavedChangesDialog, useUnsavedChangesGuard } from "~/components/unsaved-changes-guard";
import { ApiError } from "~/lib/api";
import type { FieldDescriptor } from "~/lib/schema";

/* Server validation is authoritative; client validation only checks JSON textareas parse. */

const inputClass =
  "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";

/**
 * A `datetime-local` input reads and writes `YYYY-MM-DDTHH:mm`, which JSON Schema's `date-time`
 * format rejects because RFC 3339 requires seconds and an offset. Without this pair, every type
 * with a required date-time field is impossible to create from the form.
 */
function toRfc3339(local: string): string {
  if (!local) return "";
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? local : parsed.toISOString();
}

function toLocalInputValue(value: unknown): string {
  const raw = String(value ?? "");
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const offsetMs = parsed.getTime() - parsed.getTimezoneOffset() * 60_000;
  return new Date(offsetMs).toISOString().slice(0, 16);
}

function isJsonKind(field: FieldDescriptor): boolean {
  return field.kind === "array" || field.kind === "object";
}

function isStoredMultilineString(field: FieldDescriptor, value: unknown): boolean {
  return field.kind === "string" && typeof value === "string" && /[\r\n]/.test(value);
}

type NormalizedDecimal = {
  negative: boolean;
  coefficient: string;
  exponent: bigint;
};

function normalizeDecimal(value: string): NormalizedDecimal | null {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;

  const integer = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  let coefficient = `${integer}${fraction}`.replace(/^0+/, "");
  if (coefficient === "") {
    return { negative: match[1] === "-", coefficient: "0", exponent: 0n };
  }

  let trailingZeros = 0;
  while (coefficient.endsWith("0")) {
    coefficient = coefficient.slice(0, -1);
    trailingZeros += 1;
  }

  return {
    negative: match[1] === "-",
    coefficient,
    exponent: BigInt(match[5] ?? "0") - BigInt(fraction.length) + BigInt(trailingZeros),
  };
}

export function parseNumberInput(
  value: string
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: "must be a finite number" };
  }

  const entered = normalizeDecimal(value);
  const serialized = normalizeDecimal(String(parsed));
  if (
    !entered ||
    !serialized ||
    entered.negative !== serialized.negative ||
    entered.coefficient !== serialized.coefficient ||
    entered.exponent !== serialized.exponent
  ) {
    return { ok: false, error: "cannot be represented without changing its value" };
  }

  return { ok: true, value: parsed };
}

function initialValue(
  field: FieldDescriptor,
  mode: "create" | "edit",
  initial?: Record<string, unknown>
): unknown {
  if (initial !== undefined && Object.hasOwn(initial, field.name)) return initial[field.name];
  if (field.kind === "enum") return undefined;
  if (field.kind === "boolean") {
    if (mode === "create" && typeof field.defaultValue === "boolean") return field.defaultValue;
    return field.required ? false : undefined;
  }
  return "";
}

function initialDraft(
  fields: FieldDescriptor[],
  mode: "create" | "edit",
  initial?: Record<string, unknown>
) {
  return {
    values: Object.fromEntries(
      fields
        .filter((field) => !isJsonKind(field))
        .map((field) => [field.name, initialValue(field, mode, initial)])
    ),
    jsonText: Object.fromEntries(
      fields
        .filter(isJsonKind)
        .map((field) => [
          field.name,
          initial?.[field.name] !== undefined ? JSON.stringify(initial[field.name], null, 2) : "",
        ])
    ),
  };
}

function draftSignature(
  fields: FieldDescriptor[],
  values: Record<string, unknown>,
  jsonText: Record<string, string>
): string {
  return JSON.stringify(
    fields.map((field) => [
      field.name,
      isJsonKind(field) ? (jsonText[field.name] ?? "") : values[field.name],
    ])
  );
}

// Maps a thrown write error into form state: a 422 with a `path` highlights the offending field;
// the version-conflict code becomes concurrency advice; anything else keeps the server message.
// Shared by both routes.
export function writeErrorState(err: unknown): {
  fieldErrors: Record<string, string>;
  formError: string;
} {
  if (err instanceof ApiError) {
    if (err.status === 422 && err.path) {
      const name = err.path.replace(/^\//, "").split("/")[0];
      return { fieldErrors: { [name]: err.message }, formError: "" };
    }
    if (err.status === 409 && err.code === "version conflict") {
      return {
        fieldErrors: {},
        formError: "this record changed since you loaded it: reload and retry",
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
  onSubmit: (values: Record<string, unknown>, confirmSaved: () => boolean) => void | Promise<void>;
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
  const startingDraft = useRef(initialDraft(fields, mode, initial));
  const [values, setValues] = useState<Record<string, unknown>>(startingDraft.current.values);
  const [jsonText, setJsonText] = useState<Record<string, string>>(startingDraft.current.jsonText);
  const [savedDraft, setSavedDraft] = useState(() =>
    draftSignature(fields, startingDraft.current.values, startingDraft.current.jsonText)
  );
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const currentDraft = draftSignature(fields, values, jsonText);
  const currentDraftRef = useRef(currentDraft);
  currentDraftRef.current = currentDraft;
  const unsavedChanges = useUnsavedChangesGuard(currentDraft !== savedDraft);
  // A ref, not state: the `submitting` prop only disables the button one commit after the parent
  // reacts, so two submit events landing in the same task both pass an is-it-disabled check.
  const inFlight = useRef(false);

  function set(name: string, value: unknown) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || submitting) return;
    const payload: Record<string, unknown> = {};
    const nextClientErrors: Record<string, string> = {};

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
          nextClientErrors[field.name] = "invalid JSON";
        }
        continue;
      }

      if (readonlyImmutable) {
        if (initial?.[field.name] !== undefined) payload[field.name] = initial[field.name];
        continue;
      }

      const value = values[field.name];
      if (field.kind === "enum") {
        if (value === undefined) continue;
        payload[field.name] = value;
      } else if (field.kind === "boolean") {
        if (value === undefined) continue;
        payload[field.name] = value === null ? null : value === true;
      } else if (field.kind === "number") {
        if (value === "" || value === undefined) continue;
        const parsed = parseNumberInput(String(value));
        if (parsed.ok) payload[field.name] = parsed.value;
        else nextClientErrors[field.name] = parsed.error;
      } else {
        if (value === "" || value === undefined) continue; // omit empty optional strings
        payload[field.name] = value;
      }
    }

    if (Object.keys(nextClientErrors).length > 0) {
      setClientErrors(nextClientErrors);
      return;
    }
    setClientErrors({});
    const submittedDraft = currentDraftRef.current;
    const confirmSaved = () => {
      if (currentDraftRef.current !== submittedDraft) return false;
      unsavedChanges.clear();
      setSavedDraft(submittedDraft);
      return true;
    };
    inFlight.current = true;
    try {
      await onSubmit(payload, confirmSaved);
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4" noValidate>
      <UnsavedChangesDialog {...unsavedChanges} />
      {formError ? (
        <p className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
          error: {formError}
        </p>
      ) : null}

      {fields.map((field) => {
        const readOnly = mode === "edit" && field.immutable === true;
        const optionalBoolean = field.kind === "boolean" && !field.required && !readOnly;
        const error = fieldErrors[field.name] ?? clientErrors[field.name];
        const label = (
          <>
            {field.name}
            {field.required ? <span className="text-primary"> *</span> : null}
            {readOnly ? <span className="opacity-60"> (immutable)</span> : null}
          </>
        );
        return (
          <div key={field.name} className="flex flex-col gap-1">
            {optionalBoolean ? (
              <span id={`${field.name}-label`} className="text-xs text-muted-foreground">
                {label}
              </span>
            ) : (
              <label htmlFor={field.name} className="text-xs text-muted-foreground">
                {label}
              </label>
            )}
            <Field
              field={field}
              value={values[field.name]}
              jsonValue={jsonText[field.name]}
              multiline={isStoredMultilineString(field, initial?.[field.name])}
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
  multiline,
  readOnly,
  onValue,
  onJson,
}: {
  field: FieldDescriptor;
  value: unknown;
  jsonValue?: string;
  multiline: boolean;
  readOnly: boolean;
  onValue: (v: unknown) => void;
  onJson: (v: string) => void;
}) {
  if (readOnly) {
    const display = isJsonKind(field) ? (jsonValue ?? "") : String(value ?? "-");
    if (multiline) {
      return <Textarea id={field.name} value={display} disabled readOnly />;
    }
    return <input id={field.name} className={inputClass} value={display} disabled readOnly />;
  }

  if (multiline) {
    return (
      <Textarea
        id={field.name}
        required={field.required}
        value={String(value ?? "")}
        onChange={(e) => onValue(e.target.value)}
      />
    );
  }

  switch (field.kind) {
    case "boolean": {
      if (!field.required) {
        const choices = [
          { label: "Unset", value: undefined },
          { label: "True", value: true },
          { label: "False", value: false },
        ] as const;
        return (
          <div
            role="radiogroup"
            aria-labelledby={`${field.name}-label`}
            className="flex w-fit items-center gap-3 rounded-sm border border-border px-3 py-2"
          >
            {choices.map((choice) => (
              <label
                key={choice.label}
                className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground"
              >
                <input
                  type="radio"
                  name={field.name}
                  value={choice.label.toLowerCase()}
                  checked={Object.is(value, choice.value)}
                  onChange={() => onValue(choice.value)}
                  className="size-4 accent-primary"
                />
                {choice.label}
              </label>
            ))}
          </div>
        );
      }
      return (
        <input
          id={field.name}
          type="checkbox"
          className="size-4 accent-primary"
          checked={Boolean(value)}
          onChange={(e) => onValue(e.target.checked)}
        />
      );
    }
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
    case "enum": {
      const enumValues = field.enumValues ?? [];
      const selectedIndex = enumValues.findIndex((option) => Object.is(option, value));
      return (
        <select
          id={field.name}
          className={inputClass}
          required={field.required}
          value={selectedIndex === -1 ? "" : String(selectedIndex)}
          onChange={(e) => {
            const index = Number(e.target.value);
            onValue(e.target.value === "" ? undefined : enumValues[index]);
          }}
        >
          <option value="">-</option>
          {enumValues.map((opt, index) => (
            <option key={`${typeof opt}:${String(opt)}`} value={String(index)}>
              {String(opt)}
            </option>
          ))}
        </select>
      );
    }
    case "date":
      return (
        <input
          id={field.name}
          type={field.format === "date-time" ? "datetime-local" : "date"}
          className={inputClass}
          required={field.required}
          value={field.format === "date-time" ? toLocalInputValue(value) : String(value ?? "")}
          onChange={(e) =>
            onValue(field.format === "date-time" ? toRfc3339(e.target.value) : e.target.value)
          }
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
