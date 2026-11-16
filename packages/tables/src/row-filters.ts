import { TableValidationError, validateValue, type RecordFilter, type TableField } from './definition.ts';

export const scalarKinds: readonly string[] = ['text', 'numeric', 'boolean', 'date', 'timestamp', 'single-select'];
export const fieldColumn = (id: string) => `"f_${id.replaceAll('-', '')}"`;
const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

/** Compiles filters over `fields` to SQL conditions, appending their values to `parameters`. */
export function compileFilters(fields: readonly TableField[], filters: readonly RecordFilter[], parameters: unknown[]) {
  return filters.map(filter => {
    const field = fields.find(field => field.id === filter.fieldId);
    if (!field) throw new TableValidationError('Unknown filter field');
    const column = fieldColumn(field.id);
    if (filter.op === 'is-null' || filter.op === 'not-null')
      return `${column} IS ${filter.op === 'not-null' ? 'NOT ' : ''}NULL`;
    if (!('value' in filter) || !scalarKinds.includes(field.kind) || filter.value === null)
      throw new TableValidationError('Use scalar values or explicit null filters');
    if (field.kind === 'boolean' && filter.op !== 'eq' && filter.op !== 'ne')
      throw new TableValidationError('Boolean ordering is unsupported');
    if (field.kind === 'single-select' && filter.op !== 'eq' && filter.op !== 'ne')
      throw new TableValidationError('Single-choice ordering is unsupported');
    const value =
      field.kind === 'single-select'
        ? validateValue(field, { kind: field.kind, optionId: filter.value })
        : validateValue(field, { kind: field.kind, value: filter.value });
    if (!value || (!('value' in value) && !('optionId' in value)))
      throw new TableValidationError('Expected scalar filter');
    parameters.push('optionId' in value ? value.optionId : value.value);
    return `${column} ${operators[filter.op]} $${parameters.length}`;
  });
}
