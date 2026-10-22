import { z } from 'zod';

export const tableIdSchema = z.uuid().toLowerCase().brand<'TableId'>();
export const fieldIdSchema = z.uuid().toLowerCase().brand<'FieldId'>();
export const recordIdSchema = z.uuid().toLowerCase().brand<'RecordId'>();
export const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .brand<'TableRevision'>();
export class TableValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableValidationError';
  }
}
export const teamIdSchema = z.uuid().toLowerCase().brand<'TeamId'>();
export const optionIdSchema = z.uuid().toLowerCase().brand<'OptionId'>();
export const fileIdSchema = z.uuid().toLowerCase().brand<'FileId'>();
export const uniqueKeyIdSchema = z.uuid().toLowerCase().brand<'UniqueKeyId'>();
const textSchema = z
  .string()
  .max(10000)
  .refine(
    value => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value),
    'Expected well-formed Unicode without null bytes',
  );
const labelSchema = textSchema.trim().min(1).max(120);
const cardinalitySchema = z.enum(['one', 'many']);
export const decimalSchema = z.string().regex(/^-?(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,10})?$/);
export const dateSchema = z.iso
  .date()
  .refine(value => !value.startsWith('0000-'), 'Year must be between 0001 and 9999');
export const timestampSchema = z.iso
  .datetime({ offset: true })
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/)
  .refine(value => {
    const instant = new Date(value);
    return Number.isFinite(instant.valueOf()) && instant.getUTCFullYear() >= 1 && instant.getUTCFullYear() <= 9999;
  }, 'Timestamp must represent a supported UTC instant')
  .transform(value => new Date(value).toISOString());

export const optionSchema = z.strictObject({ id: optionIdSchema, label: labelSchema, retired: z.boolean() });
const optionsSchema = z
  .array(optionSchema)
  .min(1)
  .max(256)
  .refine(options => new Set(options.map(option => option.id)).size === options.length, 'Duplicate option identity');
const base = { id: fieldIdSchema, label: labelSchema, required: z.boolean() };
export const fieldSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('text'), maxLength: z.int().min(1).max(10000) }),
  z
    .strictObject({
      ...base,
      kind: z.literal('numeric'),
      precision: z.int().min(1).max(30),
      scale: z.int().min(0).max(10),
    })
    .refine(
      field => field.scale <= field.precision && field.precision - field.scale <= 20,
      'Invalid decimal precision or scale',
    ),
  z.strictObject({ ...base, kind: z.literal('boolean') }),
  z.strictObject({ ...base, kind: z.literal('date') }),
  z.strictObject({ ...base, kind: z.literal('timestamp'), timezone: z.literal('UTC') }),
  z.strictObject({ ...base, kind: z.literal('single-select'), options: optionsSchema }),
  z.strictObject({ ...base, kind: z.literal('multi-select'), options: optionsSchema }),
  z.strictObject({
    ...base,
    kind: z.literal('relationship'),
    targetTableId: tableIdSchema,
    cardinality: cardinalitySchema,
    inverseCardinality: cardinalitySchema,
    reverse: z.strictObject({ fieldId: fieldIdSchema, label: labelSchema }).nullable(),
    onDelete: z.literal('restrict'),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('file'),
    cardinality: cardinalitySchema,
    access: z.literal('independent'),
  }),
]);
export const uniqueKeySchema = z.strictObject({
  id: uniqueKeyIdSchema,
  fieldIds: z.array(fieldIdSchema).min(1).max(8),
  nulls: z.literal('distinct'),
});
export const definitionSchema = z
  .strictObject({
    formatVersion: z.literal(2),
    id: tableIdSchema,
    owningTeamId: teamIdSchema,
    label: labelSchema,
    fields: z.array(fieldSchema).max(64),
    uniqueKeys: z.array(uniqueKeySchema).max(64),
  })
  .superRefine((definition, context) => {
    const fields = new Map(definition.fields.map(field => [field.id, field]));
    if (fields.size !== definition.fields.length)
      context.addIssue({ code: 'custom', message: 'Duplicate field identity', path: ['fields'] });
    const keyIds = new Set<string>();
    const keyFields = new Set<string>();
    for (const [index, key] of definition.uniqueKeys.entries()) {
      const signature = [...key.fieldIds].sort().join(',');
      if (keyIds.has(key.id) || keyFields.has(signature) || new Set(key.fieldIds).size !== key.fieldIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate unique key identity or fields',
          path: ['uniqueKeys', index],
        });
      }
      keyIds.add(key.id);
      keyFields.add(signature);
      for (const id of key.fieldIds) {
        const field = fields.get(id);
        if (
          !field ||
          field.kind === 'multi-select' ||
          field.kind === 'file' ||
          (field.kind === 'relationship' && field.cardinality === 'many')
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Unique keys require existing scalar fields',
            path: ['uniqueKeys', index, 'fieldIds'],
          });
        }
      }
    }
    const reverseIds = new Set<string>();
    for (const [index, field] of definition.fields.entries()) {
      if (field.kind !== 'relationship' || field.reverse === null) continue;
      const reverseId = `${field.targetTableId}/${field.reverse.fieldId}`;
      if (reverseIds.has(reverseId) || (field.targetTableId === definition.id && fields.has(field.reverse.fieldId))) {
        context.addIssue({
          code: 'custom',
          message: 'Reverse field identity is already used',
          path: ['fields', index, 'reverse'],
        });
      }
      reverseIds.add(reverseId);
    }
  });

const optionIdsSchema = z
  .array(optionIdSchema)
  .max(256)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate option identity');
const recordIdsSchema = z
  .array(recordIdSchema)
  .max(256)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate record identity');
const fileIdsSchema = z
  .array(fileIdSchema)
  .max(256)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate file identity');
export const valueSchema = z.union([
  z.null(),
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), value: textSchema }),
    z.strictObject({ kind: z.literal('numeric'), value: decimalSchema }),
    z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
    z.strictObject({ kind: z.literal('date'), value: dateSchema }),
    z.strictObject({ kind: z.literal('timestamp'), value: timestampSchema }),
    z.strictObject({ kind: z.literal('single-select'), optionId: optionIdSchema }),
    z.strictObject({ kind: z.literal('multi-select'), optionIds: optionIdsSchema }),
    z.strictObject({ kind: z.literal('relationship'), tableId: tableIdSchema, recordIds: recordIdsSchema }),
    z.strictObject({ kind: z.literal('file'), fileIds: fileIdsSchema }),
  ]),
]);
export const valuesSchema = z
  .record(z.string(), z.unknown())
  .superRefine((values, context) => {
    const ids = Object.keys(values);
    if (ids.length > 64) context.addIssue({ code: 'custom', message: 'At most 64 input fields' });
    if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate normalized field identity' });
    }
  })
  .pipe(z.record(fieldIdSchema, valueSchema));
export type TableDefinition = z.infer<typeof definitionSchema>;
export type TableField = z.infer<typeof fieldSchema>;
export type TableValue = z.infer<typeof valueSchema>;
export type TableValues = z.infer<typeof valuesSchema>;

// This validates logical values only. Link existence, inverse uniqueness, file access,
// and cross-record unique keys must be checked by the permission-aware storage path.
export function validateValue(field: TableField, input: unknown): TableValue {
  const value = valueSchema.parse(input);
  if (value === null) {
    if (field.required) throw new TableValidationError('Required field cannot be null');
    return null;
  }
  if (field.kind !== value.kind) throw new TableValidationError('Value kind does not match field kind');
  if (field.kind === 'text' && value.kind === 'text' && value.value.length > field.maxLength)
    throw new TableValidationError('Text exceeds field length');
  if (field.kind === 'numeric' && value.kind === 'numeric') {
    const [integer = '', fraction = ''] = value.value.replace(/^-/, '').split('.');
    const integerDigits = integer === '0' ? 0 : integer.length;
    if (integerDigits > field.precision - field.scale || fraction.length > field.scale)
      throw new TableValidationError('Decimal exceeds field precision or scale');
  }
  if (
    (field.kind === 'single-select' || field.kind === 'multi-select') &&
    (value.kind === 'single-select' || value.kind === 'multi-select')
  ) {
    const ids = value.kind === 'single-select' ? [value.optionId] : value.optionIds;
    if (ids.some(id => !field.options.some(option => option.id === id && !option.retired)))
      throw new TableValidationError('Unknown or retired option');
    if (field.required && !ids.length) throw new TableValidationError('Required selection cannot be empty');
  }
  if (field.kind === 'relationship' && value.kind === 'relationship') {
    if (value.tableId !== field.targetTableId) throw new TableValidationError('Relationship target mismatch');
    validateCardinality(field, value.recordIds);
  }
  if (field.kind === 'file' && value.kind === 'file') validateCardinality(field, value.fileIds);
  return value;
}

function validateCardinality(field: { cardinality: 'one' | 'many'; required: boolean }, ids: string[]) {
  if (field.cardinality === 'one' && ids.length !== 1)
    throw new TableValidationError('Single reference requires exactly one identity or null');
  if (field.required && !ids.length) throw new TableValidationError('Required reference cannot be empty');
}

export function validateRecord(definition: TableDefinition, input: unknown): TableValues {
  const values = valuesSchema.parse(input);
  const fields = new Map(definition.fields.map(field => [String(field.id), field]));
  const result: TableValues = {};
  for (const [id, value] of Object.entries(values)) {
    const field = fields.get(id);
    if (!field) throw new TableValidationError('Unknown field identity');
    result[field.id] = validateValue(field, value);
  }
  for (const field of definition.fields) {
    if (!Object.hasOwn(result, field.id)) result[field.id] = validateValue(field, null);
  }
  return result;
}

const filterValueSchema = z.union([textSchema, z.boolean(), z.null()]);
const filterSchema = z.discriminatedUnion('op', [
  z
    .object({ fieldId: fieldIdSchema, op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']), value: filterValueSchema })
    .strict(),
  z.object({ fieldId: fieldIdSchema, op: z.enum(['is-null', 'not-null']) }).strict(),
]);
// A record id or an opaque sort cursor; listPage validates which. It has no pattern because the agent tool schema has a size budget.
// The bound fits the longest sort key: 10000 text characters JSON-escaped to at most 6 bytes each, then base64url.
export const cursorSchema = z.string().max(81000);
export const sortDirectionSchema = z.enum(['asc', 'desc']);
export const recordQuerySchema = z
  .object({
    filters: z.array(filterSchema).max(16).default([]),
    search: z.string().trim().min(1).max(255).optional(),
    sort: z
      .object({ fieldId: fieldIdSchema, direction: sortDirectionSchema.default('asc') })
      .strict()
      .optional(),
    after: cursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type RecordQuery = z.infer<typeof recordQuerySchema>;
