import { Disclosure } from '@/components/disclosure';
import { workspaceMemberLabel } from '@tulipfarm/tables/workspace-members';
import type { TableDefinition, TableField, TableValue, TableValues } from './review-contracts';

type LabeledFields = {
  fields: ReadonlyArray<{ id: string; options?: ReadonlyArray<{ id: string; label: string }> | undefined }>;
};

export function formatTableValue(value: TableValue | undefined, definition: LabeledFields, fieldId: string): string {
  if (value == null) return 'Not set';
  const options = definition.fields.find(item => item.id === fieldId)?.options;
  const option = (id: string) => options?.find(item => item.id === id)?.label ?? id;
  switch (value.kind) {
    case 'text':
    case 'numeric':
    case 'date':
    case 'timestamp':
      return value.value;
    case 'boolean':
      return value.value ? 'Yes' : 'No';
    case 'single-select':
      return option(value.optionId);
    case 'multi-select':
      return value.optionIds.map(option).join(', ') || 'None';
    case 'relationship':
      return value.recordIds.join(', ') || 'None';
    case 'file':
      return value.fileIds.join(', ') || 'None';
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

const labelKinds = new Set<TableField['kind']>([
  'text',
  'numeric',
  'date',
  'timestamp',
  'boolean',
  'single-select',
  'multi-select',
]);

/** Tables have no display field, so a row reads as its first two set values that are not references. */
export function rowLabel(definition: TableDefinition, values: TableValues, systemKind?: 'workspace-members'): string {
  if (systemKind === 'workspace-members') return workspaceMemberLabel(values);
  return (
    definition.fields
      .filter(field => labelKinds.has(field.kind) && values[field.id] != null)
      .slice(0, 2)
      .map(field => formatTableValue(values[field.id], definition, field.id))
      .join(' · ') || 'Untitled row'
  );
}

function FieldDetails({ field }: { field: TableField }) {
  switch (field.kind) {
    case 'text':
      return <>Up to {field.maxLength} characters</>;
    case 'numeric':
      return (
        <>
          {field.precision} digits, {field.scale} decimal places
        </>
      );
    case 'boolean':
      return <>Yes or no</>;
    case 'date':
      return <>Calendar date</>;
    case 'timestamp':
      return <>Date and time in UTC</>;
    case 'single-select':
    case 'multi-select':
      return (
        <ul>
          {field.options.map(option => (
            <li key={option.id}>
              {option.label}
              {option.retired ? ' (retired)' : ''}
              <span className="block break-all font-mono text-xs text-muted-foreground">{option.id}</span>
            </li>
          ))}
        </ul>
      );
    case 'file':
      return <>{field.cardinality === 'one' ? 'One file' : 'Multiple files'}. Independent file permission required.</>;
    case 'relationship':
      return (
        <div className="space-y-1">
          <p>
            {field.cardinality === 'one' ? 'One row' : 'Multiple rows'}; inverse{' '}
            {field.inverseCardinality === 'one' ? 'one row' : 'multiple rows'}. Linked deletion is blocked.
          </p>
          <p className="break-all">Target {field.targetTableId}</p>
          <p>
            {field.reverse ? `Reverse field ${field.reverse.label} (${field.reverse.fieldId})` : 'No reverse field'}
          </p>
        </div>
      );
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

export function DefinitionView({ definition, title }: { definition: TableDefinition | null; title: string }) {
  return (
    <section className="min-w-0 space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {!definition ? (
        <p className="text-sm text-muted-foreground">New table. No existing fields.</p>
      ) : (
        <>
          <p className="break-words text-base">{definition.label}</p>
          <p className="break-all text-xs text-muted-foreground">Owning team {definition.owningTeamId}</p>
          <dl className="divide-y divide-border">
            {definition.fields.map(field => (
              <div key={field.id} className="grid min-w-0 gap-2 py-3 sm:grid-cols-3">
                <dt className="min-w-0 break-words text-sm font-medium">
                  {field.label}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {field.required ? 'Required' : 'Optional'} · {field.kind}
                  </span>
                </dt>
                <dd className="min-w-0 break-all text-sm sm:col-span-2">
                  <FieldDetails field={field} />
                </dd>
              </div>
            ))}
          </dl>
          {definition.fields.length === 0 && <p className="text-sm text-muted-foreground">No fields.</p>}
          <p className="text-sm">
            Unique keys{' '}
            {definition.uniqueKeys.length
              ? definition.uniqueKeys
                  .map(key =>
                    key.fieldIds.map(id => definition.fields.find(field => field.id === id)?.label ?? id).join(' + '),
                  )
                  .join('; ')
              : 'None'}
            . Empty values are distinct.
          </p>
          <Disclosure title="Exact definition">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(definition, null, 2)}
            </pre>
          </Disclosure>
        </>
      )}
    </section>
  );
}
