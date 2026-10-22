import { ZodError, email } from 'zod';
import { fieldSchema, TableValidationError, validateValue } from '@tulipfarm/tables/definition';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import type { TableDefinition, TableField, TableValues } from './review-contracts';

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
          ? `Enter ${field.label.toLowerCase()}.`
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
