import { ValueCell } from "~/components/schema-table";
import type { ResourceRecord } from "~/lib/api";
import { type FieldDescriptor, renderValue } from "~/lib/schema";

/*
 * Schema-driven record detail. Renders a definition list of every field (`detailFields`), with the
 * system block (id/version/timestamps) visually separated under a `[system]` label. object/array
 * values fall to a mono <pre>. No per-resource code. `deletedAt` is shown only when present.
 */

function Row({
  field,
  record,
  linkLabels,
}: {
  field: FieldDescriptor;
  record: ResourceRecord;
  linkLabels?: Record<string, string>;
}) {
  const value = record[field.name];
  // deletedAt is part of the system block but only meaningful when the record is soft-deleted.
  if (field.name === "deletedAt" && (value === undefined || value === null)) return null;

  const cell = renderValue(field, value, linkLabels);
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 border-t border-border px-3 py-2">
      <dt className="text-muted-foreground">{field.name}</dt>
      <dd className="min-w-0 break-words">
        {cell.kind === "json" ? (
          <pre className="overflow-x-auto whitespace-pre-wrap text-foreground">{cell.text}</pre>
        ) : (
          <ValueCell cell={cell} />
        )}
      </dd>
    </div>
  );
}

export function DetailView({
  fields,
  record,
  linkLabels,
}: {
  fields: FieldDescriptor[];
  record: ResourceRecord;
  linkLabels?: Record<string, string>;
}) {
  const schemaFields = fields.filter((f) => !f.isSystem);
  const systemFields = fields.filter((f) => f.isSystem);

  return (
    <dl className="flex flex-col">
      {schemaFields.map((field) => (
        <Row key={field.name} field={field} record={record} linkLabels={linkLabels} />
      ))}
      {systemFields.length > 0 ? (
        <>
          <p className="mt-4 px-3 pb-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
            <span className="text-primary">[</span>system<span className="text-primary">]</span>
          </p>
          {systemFields.map((field) => (
            <Row key={field.name} field={field} record={record} linkLabels={linkLabels} />
          ))}
        </>
      ) : null}
    </dl>
  );
}
