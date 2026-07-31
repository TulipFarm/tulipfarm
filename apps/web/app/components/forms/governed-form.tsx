import type { FormSubmissionResult, GovernedForm } from "@tulipfarm/surface";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { type FormSubmissionBody, submitGovernedForm } from "~/lib/forms";
import { randomUUID } from "~/lib/uuid";

interface FieldSchema {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly (string | number)[];
}

interface ObjectSchema {
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, FieldSchema>>;
}

export interface GovernedFormViewProps {
  readonly form: GovernedForm;
  readonly resumeToken?: string;
  readonly submit?: (formId: string, body: FormSubmissionBody) => Promise<FormSubmissionResult>;
}

function initialValues(form: GovernedForm): Record<string, unknown> {
  const schema = form.schema as ObjectSchema;
  return Object.fromEntries(
    form.visibleFields.map((field) => [
      field,
      schema.properties?.[field]?.type === "boolean" ? false : "",
    ])
  );
}

/** Accessible renderer for server-governed standalone and exact-RunWait forms. */
export function GovernedFormView({
  form,
  resumeToken,
  submit = submitGovernedForm,
}: GovernedFormViewProps) {
  const schema = form.schema as ObjectSchema;
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(form));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FormSubmissionResult | null>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  const setValue = (field: string, value: unknown) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const submitted = await submit(form.id, {
        formVersion: form.version,
        schemaRef: form.schemaRef,
        guardrailRevision: form.guardrailRevision,
        data: values,
        idempotencyKey: randomUUID(),
        ...(form.mode === "run_wait" ? { runId: form.runId, resumeToken } : {}),
      });
      setResult(submitted);
    } catch {
      setError("The form could not be submitted. Refresh it and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      aria-label={`${form.id} form`}
      className="flex w-full max-w-2xl flex-col gap-4 rounded-sm border border-border p-4"
      aria-describedby={error ? `${form.id}-error` : undefined}
    >
      {form.visibleFields.map((field) => {
        const definition = schema.properties?.[field] ?? {};
        const label = definition.title ?? field;
        const labelText = `${label}${required.has(field) ? " *" : ""}`;
        const id = `${form.id}-${field}`;
        if (definition.type === "boolean") {
          return (
            <label key={field} htmlFor={id} className="flex items-center gap-2 text-sm">
              <input
                id={id}
                type="checkbox"
                checked={Boolean(values[field])}
                onChange={(event) => setValue(field, event.target.checked)}
              />
              {labelText}
            </label>
          );
        }
        if (definition.enum) {
          return (
            <label key={field} htmlFor={id} className="flex flex-col gap-1 text-sm">
              <span>{labelText}</span>
              <select
                id={id}
                required={required.has(field)}
                value={String(values[field] ?? "")}
                onChange={(event) => setValue(field, event.target.value)}
                className="rounded-sm border border-border bg-background px-2 py-1.5"
              >
                <option value="">Select…</option>
                {definition.enum.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        const number = definition.type === "number" || definition.type === "integer";
        return (
          <label key={field} htmlFor={id} className="flex flex-col gap-1 text-sm">
            <span>{labelText}</span>
            <input
              id={id}
              type={number ? "number" : "text"}
              required={required.has(field)}
              aria-describedby={definition.description ? `${id}-description` : undefined}
              value={String(values[field] ?? "")}
              onChange={(event) =>
                setValue(field, number ? Number(event.target.value) : event.target.value)
              }
              className="rounded-sm border border-border bg-background px-2 py-1.5"
            />
            {definition.description ? (
              <span id={`${id}-description`} className="text-xs text-muted-foreground">
                {definition.description}
              </span>
            ) : null}
          </label>
        );
      })}
      {error ? (
        <p id={`${form.id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {result ? (
        <p
          ref={resultRef}
          role="status"
          tabIndex={-1}
          className="text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {result.mode === "standalone"
            ? `Run ${result.runId} started`
            : `Run ${result.runId} resumed`}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? "Submitting…" : "Submit form"}
      </Button>
    </form>
  );
}
