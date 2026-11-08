import type { TableDefinition, TableField, TableValue, TableValues } from './definition.ts';
import type { ProposalPlan } from './proposal-contracts.ts';
import { evaluateExpression, mappedValueKey, transformLimits, type TransformExpression } from './transforms.ts';

type SchemaPlan = Extract<ProposalPlan, { kind: 'schema' }>;
type ConvertTarget = Extract<TransformExpression, { op: 'convert' }>['to'];
const convertible: readonly string[] = ['text', 'numeric', 'boolean', 'date', 'timestamp'] satisfies ConvertTarget[];

export type SchemaRevertField = {
  fieldId: string;
  label: string;
  /** Rows whose value from before the change comes back. */
  restored: number;
  /** Rows that keep their current value, converted back to the earlier kind when needed. */
  kept: number;
};

export type SchemaRevert = {
  plan: SchemaPlan;
  /** Fields whose values the revert recomputes. */
  fields: SchemaRevertField[];
  /** Fields the change removed. They return with their original identity and no values. */
  returned: { fieldId: string; label: string }[];
  /** Fields the change added. The revert removes them and their values. */
  removed: { fieldId: string; label: string }[];
};

function baseExpression(before: TableField, after: TableField): TransformExpression {
  const field: TransformExpression = { op: 'field', fieldId: before.id };
  if (before.kind === after.kind) return field;
  if (convertible.includes(before.kind) && convertible.includes(after.kind))
    return { op: 'convert', input: field, to: before.kind as ConvertTarget, timezone: 'UTC', onError: 'error' };
  if (after.kind === 'single-select' && before.kind === 'text')
    return {
      op: 'map',
      input: field,
      cases: after.options.map(option => ({
        from: { kind: 'single-select', optionId: option.id },
        to: { kind: 'text', value: option.label },
      })),
      unmatched: 'error',
    };
  // No fixed rule turns these values back. Only rows restored from retained values can satisfy the earlier kind.
  return field;
}

/**
 * Builds the reviewed revert of a completed schema change from the definitions on either side of it.
 * Feed every current row once through `add`, then call `finish`.
 */
export function schemaRevertBuilder(input: {
  before: TableDefinition;
  after: TableDefinition;
  /** Fields the change's transform computed. Their earlier values come back from retained history. */
  recomputed: readonly string[];
}) {
  const afterFields = new Map(input.after.fields.map(field => [field.id, field]));
  const targets = input.before.fields.flatMap(field => {
    const after = afterFields.get(field.id);
    if (!after || (after.kind === field.kind && !input.recomputed.includes(field.id))) return [];
    return [
      {
        field,
        base: baseExpression(field, after),
        cases: [] as { recordId: string; to: TableValue }[],
        restored: 0,
        kept: 0,
      },
    ];
  });
  /** Rows the revert can give their own earlier value, across all fields, so the proposal stays reviewable. */
  let budget = transformLimits.rows;
  return {
    /** Fields whose values the revert reads from retained history. */
    fieldIds: targets.map(target => target.field.id),
    /** Adds one current row and, when the change replaced its values and nobody has written them since, those earlier values. */
    add(recordId: string, values: TableValues, retained?: Readonly<Record<string, TableValue>>) {
      for (const target of targets) {
        if (!retained || !Object.hasOwn(retained, target.field.id)) {
          target.kept++;
          continue;
        }
        const wanted = retained[target.field.id] ?? null;
        const base = evaluateExpression(target.base, values, recordId);
        if (base.ok && mappedValueKey(base.value) === mappedValueKey(wanted)) target.restored++;
        // Several rows can share a current value but not an earlier one, such as texts a conversion cleared, so each row gets its own.
        else if (budget > 0) {
          budget--;
          target.cases.push({ recordId, to: wanted });
          target.restored++;
        } else target.kept++;
      }
    },
    finish(expectedRevision: string): SchemaRevert {
      const outputs = targets.map(target => ({
        fieldId: target.field.id,
        expression: target.cases.length
          ? ({ op: 'rows', input: target.base, cases: target.cases } satisfies TransformExpression)
          : target.base,
      }));
      const fields: SchemaRevertField[] = targets.map(target => ({
        fieldId: target.field.id,
        label: target.field.label,
        restored: target.restored,
        kept: target.kept,
      }));
      const beforeIds = new Set(input.before.fields.map(field => field.id));
      return {
        plan: {
          kind: 'schema',
          tableId: input.before.id,
          dependsOn: [],
          expectedRevision,
          target: input.before,
          transforms: { outputs: outputs.filter(output => output.expression.op !== 'field') },
        },
        fields,
        returned: input.before.fields
          .filter(field => !afterFields.has(field.id))
          .map(field => ({ fieldId: field.id, label: field.label })),
        removed: input.after.fields
          .filter(field => !beforeIds.has(field.id))
          .map(field => ({ fieldId: field.id, label: field.label })),
      };
    },
  };
}
