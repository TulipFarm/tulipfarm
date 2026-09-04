import { ValueCell } from "~/components/schema-table";
import type { ResourceRecord } from "~/lib/api";
import { type FieldDescriptor, renderValue } from "~/lib/schema";

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
          <p className="mt-4 px-3 pb-1 text-xs text-muted-foreground">System</p>
          {systemFields.map((field) => (
            <Row key={field.name} field={field} record={record} linkLabels={linkLabels} />
          ))}
        </>
      ) : null}
    </dl>
  );
}
