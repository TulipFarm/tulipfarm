import { type MetaFunction, useNavigate } from "@remix-run/react";
import { type FormEvent, useRef, useState } from "react";
import { Plus } from "~/components/icons";
import { PageShell } from "~/components/page-shell";
import { ResourceRouteError } from "~/components/resources/resource-route-error";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { UnsavedChangesDialog, useUnsavedChangesGuard } from "~/components/unsaved-changes-guard";
import { ApiError, createResourceType } from "~/lib/api";
import { randomUUID } from "~/lib/uuid";

export const meta: MetaFunction = () => [{ title: "New type · Resources · tulipfarm" }];

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function resourceTypeName(value: string): string {
  const trimmed = value.trim();
  if (NAME_RE.test(trimmed)) return trimmed;
  return trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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

function draftSignature(name: string, description: string, fields: FieldRow[]): string {
  return JSON.stringify({
    name,
    description,
    fields: fields.map(({ name: fieldName, type, required, enumValues }) => ({
      name: fieldName,
      type,
      required,
      enumValues,
    })),
  });
}

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
  const [invalidFieldIds, setInvalidFieldIds] = useState<ReadonlySet<string>>(new Set());
  const nameRef = useRef<HTMLInputElement>(null);
  const fieldNameRefs = useRef(new Map<string, HTMLInputElement>());
  const savedName = resourceTypeName(name);
  const currentDraft = draftSignature(name, description, fields);
  const currentDraftRef = useRef(currentDraft);
  currentDraftRef.current = currentDraft;
  const [savedDraft, setSavedDraft] = useState(currentDraft);
  const unsavedChanges = useUnsavedChangesGuard(currentDraft !== savedDraft);

  function setField(id: string, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    if (patch.name !== undefined && invalidFieldIds.has(id)) {
      setInvalidFieldIds(new Set());
      setError(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInvalidName(false);
    setInvalidFieldIds(new Set());
    if (!NAME_RE.test(savedName)) {
      setError(
        "Enter a name such as Support tickets. Start with a letter from A to Z; spaces and capitals are fine."
      );
      setInvalidName(true);
      nameRef.current?.focus();
      return;
    }
    const normalizedFields = fields.map((field) => ({ ...field, name: field.name.trim() }));
    const unnamedFieldIds = normalizedFields
      .filter((field) => field.name.length === 0)
      .map((field) => field.id);
    if (unnamedFieldIds.length > 0) {
      setError("Every field needs a name. Name or remove the highlighted field.");
      setInvalidFieldIds(new Set(unnamedFieldIds));
      fieldNameRefs.current.get(unnamedFieldIds[0] ?? "")?.focus();
      return;
    }
    const fieldNameCounts = new Map<string, number>();
    for (const field of normalizedFields) {
      fieldNameCounts.set(field.name, (fieldNameCounts.get(field.name) ?? 0) + 1);
    }
    const duplicateFieldIds = normalizedFields
      .filter((field) => (fieldNameCounts.get(field.name) ?? 0) > 1)
      .map((field) => field.id);
    if (duplicateFieldIds.length > 0) {
      setError("Field names must be unique. Rename or remove duplicate fields.");
      setInvalidFieldIds(new Set(duplicateFieldIds));
      fieldNameRefs.current.get(duplicateFieldIds[0] ?? "")?.focus();
      return;
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of normalizedFields) {
      properties[field.name] = propFor(field);
      if (field.required) required.push(field.name);
    }
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      ...(description.trim() ? { description: description.trim() } : {}),
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };

    const submittedDraft = currentDraftRef.current;
    setSubmitting(true);
    try {
      await createResourceType(savedName, JSON.stringify(schema, null, 2));
      if (currentDraftRef.current === submittedDraft) {
        unsavedChanges.clear();
        setSavedDraft(submittedDraft);
        navigate(`/resources/${encodeURIComponent(savedName)}`);
      } else {
        setSubmitting(false);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(`The saved name "${savedName}" already exists. Choose a different name.`);
        setInvalidName(true);
        nameRef.current?.focus();
      } else {
        setError(err instanceof ApiError ? err.message : "failed to create resource type");
      }
      setSubmitting(false);
    }
  }

  const crumbs = [{ label: "Resources", to: "/resources" }, { label: "New type" }];

  return (
    <PageShell crumbs={crumbs} title="New resource type">
      <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
        <UnsavedChangesDialog {...unsavedChanges} />
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
            placeholder="Support tickets"
          />
          <p id="type-name-help" className="break-words text-xs text-muted-foreground">
            {NAME_RE.test(savedName)
              ? `Saved name: ${savedName}. Used in lists and web addresses.`
              : "For example, Support tickets. We create the saved name for you."}
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
                  ref={(node) => {
                    if (node) fieldNameRefs.current.set(f.id, node);
                    else fieldNameRefs.current.delete(f.id);
                  }}
                  id={`field-${f.id}-name`}
                  aria-label={`field ${i + 1} name`}
                  aria-invalid={invalidFieldIds.has(f.id) || undefined}
                  aria-describedby={invalidFieldIds.has(f.id) ? "type-create-error" : undefined}
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
  return <ResourceRouteError subject="catalog" />;
}
