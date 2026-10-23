import { z } from 'zod';
import { definitionSchema, fieldSchema, tableIdSchema, type TableDefinition } from './definition.ts';

export const tableNameSchema = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:_[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u)
  .refine(
    value => value === value.normalize('NFKC').toLowerCase() && [...value].length <= 80,
    'Expected a normalized table name',
  )
  .meta({
    description:
      'Readable table identity used in Soul format 3 instead of a table UUID; normalized to lowercase NFKC and at most 80 code points.',
    examples: ['customer_orders'],
  });
export const tableNamesSchema = z
  .record(tableIdSchema, tableNameSchema)
  .refine(
    names =>
      Object.keys(names).length > 0 &&
      Object.keys(names).length <= 65 &&
      new Set(Object.values(names)).size === Object.keys(names).length,
    'Expected distinct table names for the definition and its relationships',
  )
  .meta({ description: 'Trusted mapping from table UUIDs to distinct readable table names.' });
export type TableNames = z.infer<typeof tableNamesSchema>;

export function tableName(title: string, ordinal = 1) {
  definitionSchema.shape.label.parse(title);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(ordinal);
  const words = title
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu);
  const base = words?.join('_') ?? 'table';
  const suffix = ordinal === 1 ? '' : `_${ordinal}`;
  return tableNameSchema.parse(
    [...base]
      .slice(0, 80 - suffix.length)
      .join('')
      .replace(/_+$/, '') + suffix,
  );
}

const namedFieldSchema = z.union([
  ...fieldSchema.options.filter(field => field.shape.kind.value !== 'relationship'),
  fieldSchema.options[7].extend({ targetTableId: tableNameSchema }),
]);
export const tableDocumentSchema = z
  .strictObject({
    ...definitionSchema.shape,
    formatVersion: z.literal(3).meta({ description: 'Soul table document format version; exactly 3.' }),
    id: tableNameSchema.meta({
      description: 'Readable identity of this table, not its UUID.',
      examples: ['customer_orders'],
    }),
    fields: z.array(namedFieldSchema).max(64).meta({
      description: 'The fields that define each row; relationship targets use readable table names.',
    }),
  })
  .meta({
    description:
      'A version-3 Soul table document describes the shape of its rows with readable table names. Zod enforces on the Soul conversion path: names are lowercase NFKC and at most 80 code points; labels trim to 1–120 characters and use well-formed Unicode; field IDs are unique after lowercase normalization; option IDs within each select field and unique-key IDs are unique; unique-key field IDs and field sets are distinct; unique keys reference existing scalar fields; and reverse relationship field identities do not collide.',
  });

function nameFor(names: TableNames, id: string) {
  const name = names[tableIdSchema.parse(id)];
  if (!name) throw new Error('Missing trusted table name');
  return name;
}

export function tableDocument(input: TableDefinition, inputNames: TableNames) {
  const definition = definitionSchema.parse(input);
  const names = tableNamesSchema.parse(inputNames);
  return tableDocumentSchema.parse({
    ...definition,
    formatVersion: 3,
    id: nameFor(names, definition.id),
    fields: definition.fields.map(field =>
      field.kind === 'relationship' ? { ...field, targetTableId: nameFor(names, field.targetTableId) } : field,
    ),
  });
}

export function readTableDocument(input: unknown, id: string, inputNames: TableNames) {
  const document = tableDocumentSchema.parse(input);
  const names = tableNamesSchema.parse(inputNames);
  if (document.id !== nameFor(names, id)) throw new Error('Soul definition identity mismatch');
  const ids = new Map(Object.entries(names).map(([key, name]) => [name, key]));
  return definitionSchema.parse({
    ...document,
    formatVersion: 2,
    id,
    fields: document.fields.map(field => {
      if (field.kind !== 'relationship') return field;
      const targetTableId = ids.get(field.targetTableId);
      if (!targetTableId) throw new Error('Missing trusted relationship identity');
      return { ...field, targetTableId };
    }),
  });
}
