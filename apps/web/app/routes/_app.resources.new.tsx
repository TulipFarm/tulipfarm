import { type MetaFunction, useNavigate, useRouteError } from "@remix-run/react";
import { type FormEvent, useRef, useState } from "react";
import { Plus } from "~/components/icons";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { ApiError, createResourceType } from "~/lib/api";
import { randomUUID } from "~/lib/uuid";

export const meta: MetaFunction = () => [{ title: "New type · Resources · tulipfarm" }];

const NAME_RE = /^[a-z][a-z0-9-]*$/;

type FieldType = "string" | "number" | "integer" | "boolean" | "date" | "datetime" | "enum";

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Whole number" },
  { value: "boolean", label: "Yes or no" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date and time" },
  { value: "enum", label: "Choice list" },
];

function FieldTypePicker({
  id,
  type,
  label,
  onChange,
}: {
  id: string;
  type: FieldType;
  label: string;
  onChange: (type: FieldType) => void;
}) {
  const current = FIELD_TYPES.find((option) => option.value === type)?.label ?? "Text";
  const [value, setValue] = useState(current);
  const hasMatches = FIELD_TYPES.some((option) =>
    option.label.toLowerCase().includes(value.trim().toLowerCase())
  );
  return (
    <fieldset
      className="min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !value.trim()) setValue(current);
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") setValue(current);
        if (event.key === "Enter" && !hasMatches) event.preventDefault();
      }}
    >
      <Combobox
        id={id}
        aria-label={label}
        aria-invalid={!hasMatches}
        value={value}
        options={FIELD_TYPES.map((option) => option.label)}
        onValueChange={setValue}
        onCommit={(next) => {
          const chosen = FIELD_TYPES.find((option) => option.label === next);
          if (chosen) onChange(chosen.value);
          setValue(chosen?.label ?? current);
        }}
        emptyLabel="Choose one of the field types."
      />
    </fieldset>
  );
}

// `id` is row identity: React keys and every state patch go through it, so adding or removing a row
// can never hand one row's state to another.
type FieldRow = {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  enumValues: string;
};

const newRow = (): FieldRow => ({
  id: randomUUID(),
  name: "",
  type: "string",
  required: false,
  enumValues: "",
});

// One field → its JSON Schema property. System fields (id/createdAt/updatedAt/version) are managed by
// the platform and never declared here.
function propFor(row: FieldRow): Record<string, unknown> {
  switch (row.type) {
    case "number":
      return { type: "number" };
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "enum":
      return {
        type: "string",
        enum: row.enumValues
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    default:
      return { type: "string" };
  }
}

export default function ResourceTypeNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<FieldRow[]>([newRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidName, setInvalidName] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  function setField(id: string, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInvalidName(false);
    if (!NAME_RE.test(name)) {
      setError(
        "Use lowercase letters, numbers and hyphens. Start with a letter, for example support-ticket."
      );
      setInvalidName(true);
      nameRef.current?.focus();
      return;
    }
    const named = fields.filter((f) => f.name.trim());
    if (named.length === 0) {
      setError("Add at least one field.");
      return;
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const f of named) {
      const fname = f.name.trim();
      properties[fname] = propFor(f);
      if (f.required) required.push(fname);
    }
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      ...(description.trim() ? { description: description.trim() } : {}),
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };

    setSubmitting(true);
    try {
      await createResourceType(name, JSON.stringify(schema, null, 2));
      navigate(`/resources/${encodeURIComponent(name)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to create resource type");
      setSubmitting(false);
    }
  }

  const crumbs = [{ label: "Resources", to: "/resources" }, { label: "New type" }];

  return (
    <PageShell crumbs={crumbs} title="New resource type">
      <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Choose the details each record will hold. You can also{" "}
          <Link
            to={`/?draft=${encodeURIComponent("Help me design a resource type. Ask what records I need to track and suggest its fields.")}`}
            className="text-brand underline underline-offset-2"
          >
            build a resource type in chat
          </Link>
          .
        </p>
        {error ? (
          <p id="type-create-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="type-name" className="text-sm font-medium">
            Resource type name
          </label>
          <Input
            ref={nameRef}
            id="type-name"
            aria-required="true"
            aria-invalid={invalidName}
            aria-describedby={`type-name-help${invalidName ? " type-create-error" : ""}`}
            autoComplete="off"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (invalidName) setError(null);
              setInvalidName(false);
            }}
            placeholder="support-ticket"
          />
          <p id="type-name-help" className="text-xs text-muted-foreground">
            Required. Use lowercase letters, numbers and hyphens, for example support-ticket. This
            name is used in the web address.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="type-desc" className="text-sm font-medium">
            Description
          </label>
          <Input
            id="type-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What these records help you track"
          />
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Fields</h2>
          <p className="text-xs text-muted-foreground">
            Each record gets its own ID, creation date and last-updated date automatically.
          </p>
          {fields.map((f, i) => (
            <fieldset
              key={f.id}
              className="grid min-w-0 gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
            >
              <legend className="sr-only">Field {i + 1}</legend>
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`field-${f.id}-name`} className="text-sm">
                  Name
                </label>
                <Input
                  id={`field-${f.id}-name`}
                  aria-label={`field ${i + 1} name`}
                  value={f.name}
                  onChange={(e) => setField(f.id, { name: e.target.value })}
                  placeholder="subject"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`field-${f.id}-type`} className="text-sm">
                  Type
                </label>
                <FieldTypePicker
                  id={`field-${f.id}-type`}
                  label={`field ${i + 1} type`}
                  type={f.type}
                  onChange={(type) => setField(f.id, { type })}
                />
              </div>
              {f.type === "enum" ? (
                <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
                  <label htmlFor={`field-${f.id}-choices`} className="text-sm">
                    Choices
                  </label>
                  <Input
                    id={`field-${f.id}-choices`}
                    aria-label={`field ${i + 1} choices`}
                    aria-describedby={`field-${f.id}-choices-help`}
                    value={f.enumValues}
                    onChange={(e) => setField(f.id, { enumValues: e.target.value })}
                    placeholder="open, closed, done"
                  />
                  <p id={`field-${f.id}-choices-help`} className="text-xs text-muted-foreground">
                    Separate choices with commas.
                  </p>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3 sm:col-span-2">
                <label className="flex min-h-7 items-center gap-2 text-sm pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    aria-label={`field ${i + 1} required`}
                    checked={f.required}
                    onChange={(e) => setField(f.id, { required: e.target.checked })}
                  />
                  Required
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`remove field ${i + 1}`}
                  onClick={() => setFields((prev) => prev.filter((row) => row.id !== f.id))}
                >
                  Remove
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setFields((prev) => [...prev, newRow()])}
          >
            <Plus className="size-4" aria-hidden />
            Add field
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create type"}
          </Button>
          <Button asChild variant="outline">
            <Link to="/resources">Cancel</Link>
          </Button>
        </div>
      </form>
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="resources" status={status} message={message} />;
}
