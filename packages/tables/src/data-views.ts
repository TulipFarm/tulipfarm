import { z } from 'zod';
import { AccessDenied, uuidSchema } from '@tulipfarm/access';
import {
  fieldIdSchema,
  tableIdSchema,
  textSchema,
  TableValidationError,
  type RecordFilter,
  type RecordQuery,
  type TableDefinition,
  type TableField,
  type TableValues,
} from './definition.ts';
import { compileFilters, scalarKinds } from './row-filters.ts';

export const dataViewActionSchema = z.enum(['read', 'create', 'update', 'delete']);
export type DataViewAction = z.infer<typeof dataViewActionSchema>;

const parameterNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const literalSchema = z.union([textSchema, z.boolean()]);
const operandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('value'), value: literalSchema }),
  z.strictObject({ kind: z.literal('parameter'), name: parameterNameSchema }),
]);
const comparisonSchema = z.union([
  z.strictObject({
    fieldId: fieldIdSchema,
    op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
    operand: operandSchema,
  }),
  z.strictObject({ fieldId: fieldIdSchema, op: z.enum(['is-null', 'not-null']) }),
]);

/** Rows a view reaches: every comparison holds. An empty list reaches every row. */
export const rowPredicateSchema = z.strictObject({ all: z.array(comparisonSchema).max(16) });
export type RowPredicate = z.infer<typeof rowPredicateSchema>;

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

const dataViewObject = z.strictObject({
  id: uuidSchema,
  appId: uuidSchema,
  tableId: tableIdSchema,
  fieldIds: z.array(fieldIdSchema).min(1).max(64).refine(unique, 'Fields must be unique'),
  predicate: rowPredicateSchema,
  actions: z
    .array(dataViewActionSchema)
    .min(1)
    .max(4)
    .refine(unique, 'Actions must be unique')
    .refine(
      actions => actions.includes('read') || !actions.some(action => action === 'update' || action === 'delete'),
      'Updating or deleting rows needs read',
    ),
});

/** A view a member asks for, before it has an id. */
export const dataViewDraftSchema = dataViewObject.omit({ id: true });
export type DataViewDraft = z.infer<typeof dataViewDraftSchema>;

/**
 * A field the predicate compares with a parameter by anything but `eq` although the view does not list it. An app
 * could binary-search such a field's hidden values by varying the parameter.
 */
export function rangedHiddenField(view: Pick<DataViewDraft, 'fieldIds' | 'predicate'>) {
  return view.predicate.all.find(
    comparison =>
      'operand' in comparison &&
      comparison.operand.kind === 'parameter' &&
      comparison.op !== 'eq' &&
      !view.fieldIds.includes(comparison.fieldId),
  )?.fieldId;
}

/** What one app may do with one table: the listed fields, the rows `predicate` reaches, and `actions`. */
export const dataViewSchema = dataViewObject.refine(view => rangedHiddenField(view) === undefined, {
  message: 'A parameter may only test a field the view does not list for equality',
  path: ['predicate'],
});
export type DataView = z.infer<typeof dataViewSchema>;

/** Values an app supplies for the predicate's parameters. They narrow the view's rows and never widen them. */
export const dataViewParametersSchema = z
  .record(parameterNameSchema, literalSchema)
  .refine(parameters => Object.keys(parameters).length <= 16, 'Too many parameters');
export type DataViewParameters = z.infer<typeof dataViewParametersSchema>;

/** Field kinds a view may list. Relationship and file values reach other assets, which a view does not grant. */
const viewKinds: readonly string[] = [...scalarKinds, 'multi-select'];

/** One request's reach: the view's fields as the table defines them now, and its predicate as SQL. */
export type DataViewScope = { fields: TableField[]; predicates: string[]; parameters: unknown[] };

/** The first field of `view` that `definition` lacks or holds with a kind the view cannot use there. */
export function unresolvedDataViewField(
  view: Pick<DataViewDraft, 'fieldIds' | 'predicate'>,
  definition: TableDefinition,
) {
  const kinds = new Map(definition.fields.map(field => [field.id, field.kind]));
  return (
    view.fieldIds.find(id => !viewKinds.includes(kinds.get(id) ?? '')) ??
    view.predicate.all.find(comparison => !scalarKinds.includes(kinds.get(comparison.fieldId) ?? ''))?.fieldId
  );
}

function viewFields(view: DataView, definition: TableDefinition) {
  if (definition.id !== view.tableId || unresolvedDataViewField(view, definition) !== undefined)
    throw new AccessDenied();
  return view.fieldIds.map(id => definition.fields.find(field => field.id === id)!);
}

/** Resolves `view` for `action` against the table's current `definition`. Anything that does not resolve exactly denies. */
export function dataViewScope(
  view: DataView,
  definition: TableDefinition,
  action: DataViewAction,
  parameters: DataViewParameters,
): DataViewScope {
  if (!view.actions.includes(action)) throw new AccessDenied();
  const fields = viewFields(view, definition);
  const names = new Set(
    view.predicate.all.flatMap(comparison =>
      'operand' in comparison && comparison.operand.kind === 'parameter' ? [comparison.operand.name] : [],
    ),
  );
  const supplied = Object.keys(parameters);
  if (supplied.length !== names.size || supplied.some(name => !names.has(name))) throw new AccessDenied();
  const filters: RecordFilter[] = view.predicate.all.map(comparison =>
    'operand' in comparison
      ? {
          fieldId: comparison.fieldId,
          op: comparison.op,
          value: comparison.operand.kind === 'value' ? comparison.operand.value : parameters[comparison.operand.name]!,
        }
      : comparison,
  );
  const bound: unknown[] = [];
  try {
    return { fields, predicates: compileFilters(definition.fields, filters, bound), parameters: bound };
  } catch (error) {
    if (error instanceof TableValidationError || error instanceof z.ZodError) throw new AccessDenied();
    throw error;
  }
}

const listed = (scope: DataViewScope, fieldId: string) => scope.fields.some(field => field.id === fieldId);

/** Throws AccessDenied when a query filters or sorts on a field outside the view. Search covers only view text fields. */
export function requireViewQuery(scope: DataViewScope, query: RecordQuery) {
  if (query.filters.some(filter => !listed(scope, filter.fieldId))) throw new AccessDenied();
  if (query.sort && !listed(scope, query.sort.fieldId)) throw new AccessDenied();
}

/** Throws AccessDenied when a write sets a field outside the view. */
export function requireViewWrite(scope: DataViewScope, values: TableValues) {
  if (Object.keys(values).some(fieldId => !listed(scope, fieldId))) throw new AccessDenied();
}

/** The values a view shows: only its fields, whatever else the row holds. */
export function projectValues(scope: DataViewScope, values: TableValues): TableValues {
  return Object.fromEntries(scope.fields.flatMap(field => (field.id in values ? [[field.id, values[field.id]!]] : [])));
}
