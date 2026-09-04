import { type MetaFunction, useNavigate, useRouteError } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ApiError, createResourceType } from "~/lib/api";
import { randomUUID } from "~/lib/uuid";

export const meta: MetaFunction = () => [{ title: "New type · Resources · tulipfarm" }];

const NAME_RE = /^[a-z][a-z0-9-]*$/;

type FieldType = "string" | "number" | "integer" | "boolean" | "date" | "datetime" | "enum";

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "string", label: "text" },
  { value: "number", label: "number" },
  { value: "integer", label: "integer" },
  { value: "boolean", label: "boolean" },
  { value: "date", label: "date" },
  { value: "datetime", label: "datetime" },
  { value: "enum", label: "enum (choices)" },
];

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

  const input =
    "w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

  function setField(id: string, patch: Partial<FieldRow>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!NAME_RE.test(name)) {
      setError("Type name must be lowercase kebab-case (e.g. support-ticket).");
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
        {error ? <p className="text-destructive">error: {error}</p> : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="type-name" className="text-xs text-muted-foreground">
            type name * <span className="opacity-60">(singular, kebab-case)</span>
          </label>
          <input
            id="type-name"
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="support-ticket"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="type-desc" className="text-xs text-muted-foreground">
            description
          </label>
          <input
            id="type-desc"
            className={input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this resource represents"
          />
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Fields</p>
          <p className="text-xs text-muted-foreground">
            id, createdAt, updatedAt and version are added automatically.
          </p>
          {fields.map((f, i) => (
            <div
              key={f.id}
              className="flex flex-wrap items-center gap-2 rounded-sm border border-border p-2"
            >
              <input
                aria-label={`field ${i + 1} name`}
                className={`${input} flex-1 min-w-[8rem]`}
                value={f.name}
                onChange={(e) => setField(f.id, { name: e.target.value })}
                placeholder="fieldName"
              />
              <select
                aria-label={`field ${i + 1} type`}
                className={`${input} w-32`}
                value={f.type}
                onChange={(e) => setField(f.id, { type: e.target.value as FieldType })}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {f.type === "enum" ? (
                <input
                  aria-label={`field ${i + 1} choices`}
                  className={`${input} flex-1 min-w-[10rem]`}
                  value={f.enumValues}
                  onChange={(e) => setField(f.id, { enumValues: e.target.value })}
                  placeholder="open, closed, done"
                />
              ) : null}
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label={`field ${i + 1} required`}
                  checked={f.required}
                  onChange={(e) => setField(f.id, { required: e.target.checked })}
                />
                required
              </label>
              <button
                type="button"
                aria-label={`remove field ${i + 1}`}
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={() => setFields((prev) => prev.filter((row) => row.id !== f.id))}
              >
                remove
              </button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setFields((prev) => [...prev, newRow()])}
          >
            + add field
          </Button>
        </div>

        <div className="flex items-center gap-2">
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
