import type { TableDefinition, TableField } from './definition.ts';

type Option = { id: string; label: string; retired: boolean };

const kindNames: Record<TableField['kind'], string> = {
  text: 'text',
  numeric: 'number',
  boolean: 'yes/no',
  date: 'date',
  timestamp: 'timestamp',
  'single-select': 'single select',
  'multi-select': 'multi select',
  relationship: 'link',
  file: 'file',
};

function options(field: TableField): Option[] {
  return field.kind === 'single-select' || field.kind === 'multi-select' ? field.options : [];
}

function fieldChanges(before: TableField, after: TableField): string[] {
  const lines: string[] = [];
  const name = after.label;
  if (before.label !== after.label) lines.push(`Renamed ${before.label} to ${after.label}`);
  if (before.kind !== after.kind) lines.push(`${name}: ${kindNames[before.kind]} to ${kindNames[after.kind]}`);
  if (before.required !== after.required)
    lines.push(`${name}: ${before.required ? 'required to optional' : 'optional to required'}`);
  if (before.kind === 'text' && after.kind === 'text' && before.maxLength !== after.maxLength)
    lines.push(`${name}: maximum length ${before.maxLength} to ${after.maxLength}`);
  if (
    before.kind === 'numeric' &&
    after.kind === 'numeric' &&
    (before.precision !== after.precision || before.scale !== after.scale)
  )
    lines.push(
      `${name}: ${before.precision} digits with ${before.scale} decimals to ${after.precision} digits with ${after.scale} decimals`,
    );
  const previous = new Map(options(before).map(option => [option.id, option]));
  const next = new Map(options(after).map(option => [option.id, option]));
  for (const option of next.values()) {
    const old = previous.get(option.id);
    if (!old) lines.push(`${name}: added option ${option.label}`);
    else {
      if (old.label !== option.label) lines.push(`${name}: renamed option ${old.label} to ${option.label}`);
      if (old.retired !== option.retired)
        lines.push(`${name}: ${option.retired ? 'retired' : 'restored'} option ${option.label}`);
    }
  }
  for (const option of previous.values())
    if (!next.has(option.id)) lines.push(`${name}: removed option ${option.label}`);
  if (before.kind === 'relationship' && after.kind === 'relationship') {
    if (before.targetTableId !== after.targetTableId) lines.push(`${name}: links to a different table`);
    if (before.cardinality !== after.cardinality || before.inverseCardinality !== after.inverseCardinality)
      lines.push(
        `${name}: ${before.cardinality}-to-${before.inverseCardinality} to ${after.cardinality}-to-${after.inverseCardinality} link`,
      );
    if (!before.reverse && after.reverse) lines.push(`${name}: added reverse field ${after.reverse.label}`);
    else if (before.reverse && !after.reverse) lines.push(`${name}: removed reverse field ${before.reverse.label}`);
    else if (before.reverse && after.reverse) {
      if (before.reverse.fieldId !== after.reverse.fieldId)
        lines.push(`${name}: replaced reverse field ${before.reverse.label} with ${after.reverse.label}`);
      else if (before.reverse.label !== after.reverse.label)
        lines.push(`${name}: renamed reverse field ${before.reverse.label} to ${after.reverse.label}`);
    }
  }
  if (before.kind === 'file' && after.kind === 'file' && before.cardinality !== after.cardinality)
    lines.push(`${name}: ${before.cardinality === 'one' ? 'one file to many files' : 'many files to one file'}`);
  return lines;
}

function keyLabel(definition: TableDefinition, fieldIds: readonly string[]) {
  const labels = new Map(definition.fields.map(field => [field.id as string, field.label]));
  return fieldIds.map(id => labels.get(id) ?? 'a removed field').join(', ');
}

/**
 * Describes a schema change in plain language, one line per difference. Fields, options, reverse fields and
 * unique keys are matched by identity, so a renamed field reads as a rename rather than a removal and an addition.
 */
export function summarizeSchemaChange(
  before: TableDefinition | null,
  after: TableDefinition,
  recomputedFieldIds: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  const previous = new Map((before?.fields ?? []).map(field => [field.id as string, field]));
  if (!before) lines.push(`Created table ${after.label}`);
  else if (before.label !== after.label) lines.push(`Renamed table ${before.label} to ${after.label}`);
  for (const field of after.fields) {
    const old = previous.get(field.id);
    if (!old) lines.push(`Added ${field.label} (${kindNames[field.kind]})`);
    else lines.push(...fieldChanges(old, field));
  }
  const next = new Set(after.fields.map(field => field.id as string));
  for (const field of before?.fields ?? []) if (!next.has(field.id)) lines.push(`Removed ${field.label}`);
  const previousKeys = new Map((before?.uniqueKeys ?? []).map(key => [key.id as string, key]));
  const nextKeys = new Map(after.uniqueKeys.map(key => [key.id as string, key]));
  for (const key of after.uniqueKeys)
    if (!previousKeys.has(key.id)) lines.push(`Added unique key on ${keyLabel(after, key.fieldIds)}`);
  for (const key of before?.uniqueKeys ?? [])
    if (!nextKeys.has(key.id)) lines.push(`Removed unique key on ${keyLabel(before!, key.fieldIds)}`);
  const labels = new Map(after.fields.map(field => [field.id as string, field.label]));
  for (const id of recomputedFieldIds) {
    const label = labels.get(id);
    if (label) lines.push(`Recomputed values of ${label}`);
  }
  return lines.length ? lines : ['No field changes'];
}
