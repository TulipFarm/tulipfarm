import { z } from 'zod';
import { definitionSchema, fieldSchema, tableIdSchema, type TableDefinition } from './definition.ts';

export const tableNameSchema = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:_[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u)
  .refine(
    value => value === value.normalize('NFKC').toLowerCase() && [...value].length <= 80,
    'Expected a normalized table name',
  );
export const tableNamesSchema = z
  .record(tableIdSchema, tableNameSchema)
  .refine(
    names =>
      Object.keys(names).length > 0 &&
      Object.keys(names).length <= 65 &&
      new Set(Object.values(names)).size === Object.keys(names).length,
    'Expected distinct table names for the definition and its relationships',
  );
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
export const tableDocumentSchema = z.strictObject({
  ...definitionSchema.shape,
  formatVersion: z.literal(3),
  id: tableNameSchema,
  fields: z.array(namedFieldSchema).max(64),
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
