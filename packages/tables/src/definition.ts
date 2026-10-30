import { z } from 'zod';

export const tableIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'TableId'>()
  .meta({ description: 'Stable UUID identifying a table; input is normalized to lowercase.' });
export const fieldIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'FieldId'>()
  .meta({ description: 'Stable UUID identifying a field; input is normalized to lowercase.' });
export const recordIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'RecordId'>()
  .meta({ description: 'Stable UUID identifying one row; input is normalized to lowercase.' });
export const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .brand<'TableRevision'>();
export class TableValidationError extends Error {
  readonly fieldId: string | undefined;
  constructor(message: string, fieldId?: string) {
    super(message);
    this.name = 'TableValidationError';
    this.fieldId = fieldId;
  }
}
export const tableDefinitionMessages = {
  wellFormedText: 'Expected well-formed Unicode without null bytes',
  duplicateOption: 'Duplicate option identity',
  decimalPrecisionScale: 'Invalid decimal precision or scale',
  duplicateField: 'Duplicate field identity',
  duplicateUniqueKey: 'Duplicate unique key identity or fields',
  uniqueKeyScalarFields: 'Unique keys require existing scalar fields',
  reverseFieldUsed: 'Reverse field identity is already used',
} as const;
export type TableRule = { message: string; rule: string };
export const tableDefinitionRules: readonly TableRule[] = [
  {
    message: tableDefinitionMessages.wellFormedText,
    rule: 'Text such as labels must be well-formed Unicode without null bytes.',
  },
  {
    message: tableDefinitionMessages.duplicateOption,
    rule: 'Option IDs must be unique within a select field.',
  },
  {
    message: tableDefinitionMessages.decimalPrecisionScale,
    rule: 'Numeric scale must not exceed precision, and precision minus scale must be at most 20.',
  },
  { message: tableDefinitionMessages.duplicateField, rule: 'Field IDs must be unique within a table.' },
  {
    message: tableDefinitionMessages.duplicateUniqueKey,
    rule: 'Unique-key IDs must be unique, no two unique keys may cover the same fields, and a unique key must not repeat a field.',
  },
  {
    message: tableDefinitionMessages.uniqueKeyScalarFields,
    rule: 'Unique keys may only use fields of the same table that are not multi-select, file, or many-cardinality relationship fields.',
  },
  {
    message: tableDefinitionMessages.reverseFieldUsed,
    rule: 'Relationship reverse field IDs must be unique per target table and must not reuse a field ID of a self-referencing table.',
  },
];
export const teamIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'TeamId'>()
  .meta({ description: 'UUID identifying the team that owns this table; input is normalized to lowercase.' });
export const optionIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'OptionId'>()
  .meta({ description: 'Stable UUID identifying a select option; input is normalized to lowercase.' });
export const fileIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'FileId'>()
  .meta({ description: 'Stable UUID identifying a file; input is normalized to lowercase.' });
export const uniqueKeyIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'UniqueKeyId'>()
  .meta({ description: 'Stable UUID identifying a unique key; input is normalized to lowercase.' });
const textSchema = z
  .string()
  .max(10000)
  .refine(value => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value), tableDefinitionMessages.wellFormedText)
  .meta({
    description: 'Text stored in one row. Use maxLength on the field to limit its value.',
  });
export const trimmedLabelSchema = textSchema.trim().min(1).max(120);
function label(description: string, example: string) {
  return trimmedLabelSchema.meta({
    description,
    examples: [example],
    'x-tulipfarm-trimmed-label': true,
  });
}
const cardinalitySchema = z.enum(['one', 'many']).meta({
  description: 'Whether a field refers to exactly one item or can contain multiple items.',
  examples: ['one', 'many'],
});
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

export const optionSchema = z
  .strictObject({
    id: optionIdSchema,
    label: label('Display text shown for this select option.', 'Open'),
    retired: z.boolean().meta({
      description: 'Whether this option is retired; retired options remain readable but cannot be newly selected.',
    }),
  })
  .meta({ description: 'One selectable option, with a stable identity and display text.' });
const optionsSchema = z
  .array(optionSchema)
  .min(1)
  .max(256)
  .refine(
    options => new Set(options.map(option => option.id)).size === options.length,
    tableDefinitionMessages.duplicateOption,
  )
  .meta({ description: 'The available choices for a select field; provide 1–256 options with distinct IDs.' });
const base = {
  id: fieldIdSchema,
  label: label('Human-readable name for this field; it is not a stable identifier.', 'Customer name'),
  required: z.boolean().meta({
    description: 'Whether every row must contain a non-null value for this field.',
  }),
};
const textFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('text').meta({ description: 'A field containing text.' }),
    maxLength: z
      .int()
      .min(1)
      .max(10000)
      .meta({
        description:
          'Maximum number of characters allowed in a text value. Use a title-sized limit such as 120–255 for short names.',
        examples: [255],
      }),
  })
  .meta({ description: 'A text field with a maximum value length.' });
const numericFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('numeric').meta({ description: 'A fixed-precision decimal field.' }),
    precision: z
      .int()
      .min(1)
      .max(30)
      .meta({
        description: 'Maximum total decimal digits, including digits before and after the decimal point.',
        examples: [12],
      }),
    scale: z
      .int()
      .min(0)
      .max(10)
      .meta({
        description:
          'Maximum digits after the decimal point; must not exceed precision, and precision minus scale is at most 20.',
        examples: [2],
      }),
  })
  .refine(
    field => field.scale <= field.precision && field.precision - field.scale <= 20,
    tableDefinitionMessages.decimalPrecisionScale,
  )
  .meta({ description: 'A fixed-precision decimal field, such as a currency amount with precision 12 and scale 2.' });
const booleanFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('boolean').meta({ description: 'A field containing true or false.' }),
  })
  .meta({ description: 'A true-or-false field, useful for a yes/no business fact.' });
const dateFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('date').meta({ description: 'A calendar date without a time of day.' }),
  })
  .meta({ description: 'A calendar-date field, such as an invoice due date.' });
const timestampFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('timestamp').meta({ description: 'A date and time represented as a UTC instant.' }),
    timezone: z.literal('UTC').meta({ description: 'The required timezone for this timestamp field: UTC.' }),
  })
  .meta({ description: 'A date-and-time field for an event that occurs at a specific instant.' });
const singleSelectFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('single-select').meta({ description: 'A field where a row chooses one option.' }),
    options: optionsSchema.meta({
      description: 'The one-of choices available to rows, such as a ticket status.',
      examples: [[{ id: '11111111-1111-4111-8111-111111111111', label: 'Open', retired: false }]],
    }),
  })
  .meta({ description: 'A controlled choice field where each row selects one option.' });
const multiSelectFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('multi-select').meta({ description: 'A field where a row can choose multiple options.' }),
    options: optionsSchema.meta({
      description: 'The choices available to rows, such as the tags that can be applied.',
    }),
  })
  .meta({ description: 'A controlled choice field where each row can select multiple options.' });
const relationshipFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('relationship').meta({ description: 'A field linking a row to rows in another table.' }),
    targetTableId: tableIdSchema.meta({
      description: 'UUID of the table whose rows this field links to.',
    }),
    cardinality: cardinalitySchema.meta({
      description: 'How many target rows one source row may reference.',
    }),
    inverseCardinality: cardinalitySchema.meta({
      description: 'How many source rows one target row may be referenced from.',
    }),
    reverse: z
      .strictObject({
        fieldId: fieldIdSchema,
        label: label('Display name for the corresponding field on the target table.', 'Related tickets'),
      })
      .nullable()
      .meta({
        description: 'Optional reverse field to expose this relationship on the target table; null means none.',
      }),
    onDelete: z.literal('restrict').meta({
      description:
        'Deletion behavior for a target row. The only supported value, restrict, prevents deleting a linked row.',
    }),
  })
  .meta({ description: 'A field that links rows to another table.' });
const fileFieldSchema = z
  .strictObject({
    ...base,
    kind: z.literal('file').meta({ description: 'A field containing references to attached files.' }),
    cardinality: cardinalitySchema.meta({
      description: 'Whether this row can contain one file or multiple files.',
    }),
    access: z.literal('independent').meta({
      description:
        'File access behavior. Independent means file authorization is checked separately from table access.',
    }),
  })
  .meta({ description: 'A field that stores one or more independently authorized file references.' });
export const fieldSchema = z
  .discriminatedUnion('kind', [
    textFieldSchema,
    numericFieldSchema,
    booleanFieldSchema,
    dateFieldSchema,
    timestampFieldSchema,
    singleSelectFieldSchema,
    multiSelectFieldSchema,
    relationshipFieldSchema,
    fileFieldSchema,
  ])
  .meta({
    description: 'One field in the table shape; kind selects the field-specific properties and row value type.',
  });
export const uniqueKeySchema = z
  .strictObject({
    id: uniqueKeyIdSchema,
    fieldIds: z.array(fieldIdSchema).min(1).max(8).meta({
      description: 'IDs of 1–8 existing scalar fields that together must be unique for each row.',
    }),
    nulls: z.literal('distinct').meta({
      description: 'Null handling for this key. Distinct means rows with null key values do not conflict.',
    }),
  })
  .meta({ description: 'A compound uniqueness rule for the selected fields.' });
const definitionOnlyRules =
  'Zod also checks rules this JSON Schema cannot express: labels trim to 1–120 characters and must be well-formed Unicode; field IDs are unique after lowercase normalization; option IDs within each select field and unique-key IDs are unique; unique-key field IDs and field sets are distinct; each unique key refers only to existing scalar fields; and reverse relationship field identities do not collide.';
export const definitionSchema = z
  .strictObject({
    formatVersion: z.literal(2).meta({ description: 'Table definition format version; exactly 2.' }),
    id: tableIdSchema,
    owningTeamId: teamIdSchema,
    label: label('Human-readable table title; it defines the shape shown to people.', 'Customer orders'),
    fields: z.array(fieldSchema).max(64).meta({
      description: 'The fields that define the shape of each row; a row is one instance of this table.',
    }),
    uniqueKeys: z.array(uniqueKeySchema).max(64).meta({
      description: 'Optional uniqueness rules across fields; use these when a business identifier must not repeat.',
    }),
  })
  .superRefine((definition, context) => {
    const fields = new Map(definition.fields.map(field => [field.id, field]));
    if (fields.size !== definition.fields.length)
      context.addIssue({ code: 'custom', message: tableDefinitionMessages.duplicateField, path: ['fields'] });
    const keyIds = new Set<string>();
    const keyFields = new Set<string>();
    for (const [index, key] of definition.uniqueKeys.entries()) {
      const signature = [...key.fieldIds].sort().join(',');
      if (keyIds.has(key.id) || keyFields.has(signature) || new Set(key.fieldIds).size !== key.fieldIds.length) {
        context.addIssue({
          code: 'custom',
          message: tableDefinitionMessages.duplicateUniqueKey,
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
            message: tableDefinitionMessages.uniqueKeyScalarFields,
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
          message: tableDefinitionMessages.reverseFieldUsed,
          path: ['fields', index, 'reverse'],
        });
      }
      reverseIds.add(reverseId);
    }
  })
  .meta({
    description: `A version-2 table definition describes the shape of its rows. ${definitionOnlyRules}`,
  });

const optionIdsSchema = z
  .array(optionIdSchema)
  .max(256)
  .refine(ids => new Set(ids).size === ids.length, tableDefinitionMessages.duplicateOption);
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
  const validateField = (field: TableField, value: unknown) => {
    try {
      return validateValue(field, value);
    } catch (error) {
      if (error instanceof TableValidationError && error.fieldId === undefined)
        throw new TableValidationError(error.message, field.id);
      throw error;
    }
  };
  for (const [id, value] of Object.entries(values)) {
    const field = fields.get(id);
    if (!field) throw new TableValidationError('Unknown field identity', id);
    result[field.id] = validateField(field, value);
  }
  for (const field of definition.fields) {
    if (!Object.hasOwn(result, field.id)) result[field.id] = validateField(field, null);
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
