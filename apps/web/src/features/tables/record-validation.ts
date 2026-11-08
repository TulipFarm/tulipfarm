import { ZodError, email } from 'zod';
import { fieldSchema, TableValidationError, validateValue } from '@tulipfarm/tables/definition';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import type { TableDefinition, TableField, TableValue, TableValues } from './review-contracts';

export function fieldHint(field: TableField): string {
  switch (field.kind) {
    case 'text':
      return `Up to ${field.maxLength.toLocaleString()} characters.`;
    case 'numeric':
      return `Use up to ${field.precision - field.scale} whole-number digits and ${field.scale} decimal places.`;
    case 'date':
      return 'Choose a calendar date.';
    case 'timestamp':
      return 'Choose a date and time.';
    case 'boolean':
      return 'Choose Yes or No.';
    case 'single-select':
      return 'Choose an active option.';
    case 'multi-select':
      return 'Choose active options.';
    case 'relationship':
      return field.cardinality === 'one' ? 'Choose one linked row.' : 'Choose linked rows.';
    case 'file':
      return field.cardinality === 'one' ? 'Attach one available file.' : 'Attach available files.';
  }
}

const kindNames: Record<TableField['kind'], string> = {
  text: 'text',
  numeric: 'a number',
  boolean: 'yes or no',
  date: 'a date',
  timestamp: 'a date and time',
  'single-select': 'one option',
  'multi-select': 'a list of options',
  relationship: 'linked rows',
  file: 'files',
};

/** Asks for a missing required value the way the field takes it: typed, chosen or attached. */
function requiredMessage(field: TableField): string {
  const label = field.label.toLowerCase();
  switch (field.kind) {
    case 'text':
    case 'numeric':
      return `Enter ${label}.`;
    case 'boolean':
      return `Choose Yes or No for ${label}.`;
    case 'date':
      return `Choose a date for ${label}.`;
    case 'timestamp':
      return `Choose a date and time for ${label}.`;
    case 'single-select':
      return `Choose an option for ${label}.`;
    case 'multi-select':
      return `Choose at least one option for ${label}.`;
    case 'relationship':
      return `Choose a linked row for ${label}.`;
    case 'file':
      return `Attach a file for ${label}.`;
  }
}

/** Explains why the current field rejects a value, or returns null when the value fits. */
export function fieldValueIssue(field: TableField, value: TableValue | undefined): string | null {
  const saved = value ?? null;
  try {
    validateValue(fieldSchema.parse(field), saved);
    return null;
  } catch (error) {
    if (!(error instanceof ZodError || error instanceof TableValidationError)) throw error;
  }
  if (saved !== null && saved.kind !== field.kind)
    return `${field.label} holds ${kindNames[field.kind]} now, but this value is ${kindNames[saved.kind]}.`;
  if (saved === null) return `${field.label} is required now, but this value is empty.`;
  return `This ${field.label} value doesn't fit the field now. ${fieldHint(field)}`;
}

/** Lists each value the current fields would reject if these historical values were restored. */
export function restoreIssues(definition: TableDefinition, values: TableValues): { fieldId: string; reason: string }[] {
  const issues = Object.keys(values)
    .filter(id => !definition.fields.some(field => field.id === id))
    .map(fieldId => ({ fieldId, reason: 'A field in these values was removed, so its old value has nowhere to go.' }));
  for (const field of definition.fields) {
    const reason = fieldValueIssue(field, values[field.id]);
    if (reason) issues.push({ fieldId: field.id, reason });
  }
  return issues;
}

/** Names the field a confirmed write rejected and why, so the person knows what to change. */
export function rejectedFieldMessage(definition: TableDefinition, fieldId: string, value: TableValue | undefined) {
  const field = definition.fields.find(item => item.id === fieldId);
  const reason = field
    ? (fieldValueIssue(field, value) ?? `This ${field.label} value doesn't fit the field. ${fieldHint(field)}`)
    : 'A field in these values was removed.';
  return `Not saved. ${reason} Nothing was changed.`;
}

/** Names the fields of a unique key that another row already uses. */
export function uniqueConflictMessage(definition: TableDefinition, fieldIds: string[]): string | undefined {
  const labels = fieldIds.flatMap(id => definition.fields.find(field => field.id === id)?.label ?? []);
  if (!labels.length || labels.length !== fieldIds.length) return undefined;
  if (labels.length === 1) return `Not saved. Another row already has this ${labels[0]}.`;
  const list = `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  return `Not saved. Another row already has this combination of ${list}.`;
}

/** Explains a confirmed rejection that names fields, or returns undefined to keep the general message. */
export function rejectionMessage(
  definition: TableDefinition,
  rejection: { code: string; fieldId?: string | undefined; fieldIds?: string[] | undefined },
  values: TableValues,
): string | undefined {
  if (rejection.code === 'duplicate-key' && rejection.fieldIds?.length)
    return uniqueConflictMessage(definition, rejection.fieldIds);
  if (rejection.fieldId) return rejectedFieldMessage(definition, rejection.fieldId, values[rejection.fieldId]);
  return undefined;
}

export function changedValues(values: TableValues, initial: TableValues): TableValues {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([id, value]) => JSON.stringify(value ?? null) !== JSON.stringify(initial[id] ?? null),
    ),
  );
}

export function rowFieldsChanged(before: TableDefinition, after: TableDefinition): boolean {
  const shape = (definition: TableDefinition) =>
    JSON.stringify({
      fields: definition.fields.map(({ label: _label, ...field }) => field),
      uniqueKeys: definition.uniqueKeys,
    });
  return shape(before) !== shape(after);
}

export function compatibleRowValues(definition: TableDefinition, values: TableValues): TableValues {
  return Object.fromEntries(
    Object.entries(values).filter(([id, value]) => {
      const field = definition.fields.find(item => item.id === id);
      if (!field) return false;
      if (value === null) return true;
      if (value.kind !== field.kind) return false;
      if (value.kind === 'relationship' && field.kind === 'relationship')
        return value.tableId === field.targetTableId && (field.cardinality === 'many' || value.recordIds.length <= 1);
      if (value.kind === 'file' && field.kind === 'file')
        return field.cardinality === 'many' || value.fileIds.length <= 1;
      return true;
    }),
  );
}

export function validateRowDraft(
  definition: TableDefinition,
  values: TableValues,
  initial?: TableValues,
  systemKind?: 'workspace-members',
): Record<string, string> {
  const errors: Record<string, string> = {};
  const changed = initial ? changedValues(values, initial) : values;
  for (const field of definition.fields) {
    // Unchanged historical values, including retired options, are not part of an update.
    if (initial && !Object.hasOwn(changed, field.id)) continue;
    const value = values[field.id] ?? null;
    try {
      validateValue(fieldSchema.parse(field), value);
    } catch (error) {
      if (!(error instanceof ZodError || error instanceof TableValidationError)) throw error;
      const empty =
        value === null ||
        (value.kind === 'multi-select' && !value.optionIds.length) ||
        (value.kind === 'relationship' && !value.recordIds.length) ||
        (value.kind === 'file' && !value.fileIds.length);
      errors[field.id] =
        field.required && empty
          ? requiredMessage(field)
          : field.kind === 'numeric'
            ? `Enter a decimal number. ${fieldHint(field)}`
            : field.kind === 'text'
              ? `Enter valid text, up to ${field.maxLength.toLocaleString()} characters.`
              : fieldHint(field);
    }
  }
  if (systemKind === 'workspace-members') {
    const name = values[workspaceMemberFields.name],
      contact = values[workspaceMemberFields.contactEmail];
    if (
      (!initial || Object.hasOwn(changed, workspaceMemberFields.name)) &&
      (name?.kind !== 'text' || !name.value.trim())
    )
      errors[workspaceMemberFields.name] = 'Enter this member’s name.';
    if (
      (!initial || Object.hasOwn(changed, workspaceMemberFields.contactEmail)) &&
      contact !== null &&
      contact !== undefined &&
      (contact.kind !== 'text' || !email().max(320).safeParse(contact.value).success)
    )
      errors[workspaceMemberFields.contactEmail] = 'Enter a valid contact email, or leave it blank.';
  }
  return errors;
}
