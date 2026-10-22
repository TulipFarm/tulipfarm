import type { SchemaChange, SchemaField, SchemaLink, SchemaTable } from '@tulipfarm/sprout/schema-diagram';
import type { ReviewedPlan, TableDefinition, TableField } from './review-contracts';

// Exact optional fields keep the result assignable to callers still typed against the local schema diagram.
type ProposalField = SchemaField & { unique?: boolean; detail?: string; change?: SchemaChange };
type ProposalTable = SchemaTable & { fields: ProposalField[] };

const typeLabel = (field: TableField) => {
  switch (field.kind) {
    case 'numeric':
      return field.scale > 0 ? 'decimal' : 'number';
    case 'boolean':
      return 'yes/no';
    case 'timestamp':
      return 'date & time';
    case 'single-select':
      return 'select';
    case 'relationship':
      return field.cardinality === 'one' ? 'link' : 'links';
    case 'file':
      return field.cardinality === 'one' ? 'file' : 'files';
    default:
      return field.kind;
  }
};

const detail = (field: TableField) =>
  field.kind === 'single-select' || field.kind === 'multi-select'
    ? field.options
        .filter(option => !option.retired)
        .map(option => option.label)
        .join(' · ') || undefined
    : undefined;

function schemaField(field: TableField, definition: TableDefinition, change?: SchemaChange): ProposalField {
  const unique = definition.uniqueKeys.some(key => key.fieldIds.length === 1 && key.fieldIds[0] === field.id);
  const extra = detail(field);
  return {
    id: field.id,
    label: field.label,
    type: typeLabel(field),
    required: field.required,
    ...(unique && { unique }),
    ...(extra && { detail: extra }),
    ...(change && { change }),
  };
}

function diff(before: TableDefinition | null, after: TableDefinition) {
  if (!before) return after.fields.map(field => schemaField(field, after));
  const previous = new Map(before.fields.map(field => [field.id, field]));
  const kept = after.fields.map(field => {
    const old = previous.get(field.id);
    return schemaField(
      field,
      after,
      !old ? 'added' : JSON.stringify(old) !== JSON.stringify(field) ? 'changed' : undefined,
    );
  });
  const current = new Set(after.fields.map(field => field.id));
  return [
    ...kept,
    ...before.fields.filter(field => !current.has(field.id)).map(field => schemaField(field, before, 'removed')),
  ];
}

const side = (cardinality: 'one' | 'many') => (cardinality === 'one' ? '1' : 'N');

/** Tables in the proposal, plus existing tables they link to. `known` resolves linked tables the reader can list. */
export function proposalSchema(plans: readonly ReviewedPlan[], known: ReadonlyMap<string, TableDefinition>) {
  const definitions = new Map<string, TableDefinition>();
  const tables: ProposalTable[] = plans.map(plan => {
    definitions.set(plan.after.id, plan.after);
    const fields =
      plan.input.kind === 'schema'
        ? diff(plan.before, plan.after)
        : plan.after.fields.map(field => schemaField(field, plan.after));
    const state = !plan.before
      ? 'new'
      : fields.some(field => field.change) || plan.before.label !== plan.after.label
        ? 'changed'
        : 'unchanged';
    return { id: plan.after.id, label: plan.after.label, state, fields };
  });
  const targets = tables.flatMap(table =>
    definitions.get(table.id)!.fields.flatMap(field => (field.kind === 'relationship' ? [field.targetTableId] : [])),
  );
  for (const id of new Set(targets)) {
    if (definitions.has(id)) continue;
    const definition = known.get(id);
    if (definition) definitions.set(id, definition);
    tables.push({
      id,
      label: definition?.label ?? 'Linked table',
      state: 'linked',
      fields: definition?.fields.map(field => schemaField(field, definition)) ?? [],
    });
  }
  const links: SchemaLink[] = [];
  const seen = new Set<string>();
  for (const [tableId, definition] of definitions)
    for (const field of definition.fields) {
      if (field.kind !== 'relationship' || !definitions.has(field.targetTableId) || seen.has(field.id)) continue;
      seen.add(field.id);
      if (field.reverse) seen.add(field.reverse.fieldId);
      links.push({
        id: field.id,
        source: tableId,
        field: field.id,
        target: field.targetTableId,
        label: `${side(field.inverseCardinality)}:${side(field.cardinality)}`,
      });
    }
  return { tables, links };
}
