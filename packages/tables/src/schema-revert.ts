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

type Group = { value: TableValue; wants: Map<string, { value: TableValue; rows: number }> };

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
    return [{ field, base: baseExpression(field, after), groups: new Map<string, Group>(), failed: 0 }];
  });
  return {
    /** Fields whose values the revert reads from retained history. */
    fieldIds: targets.map(target => target.field.id),
    /** Adds one current row and, when the change replaced its values and nobody has written them since, those earlier values. */
    add(values: TableValues, retained?: Readonly<Record<string, TableValue>>) {
      for (const target of targets) {
        const base = evaluateExpression(target.base, values);
        if (!base.ok) {
          target.failed++;
          continue;
        }
        const key = mappedValueKey(base.value);
        const group = target.groups.get(key) ?? { value: base.value, wants: new Map() };
        target.groups.set(key, group);
        const wanted =
          retained && Object.hasOwn(retained, target.field.id) ? (retained[target.field.id] ?? null) : base.value;
        const want = group.wants.get(mappedValueKey(wanted));
        if (want) want.rows++;
        else group.wants.set(mappedValueKey(wanted), { value: wanted, rows: 1 });
      }
    },
    finish(expectedRevision: string): SchemaRevert {
      const outputs = [];
      const fields: SchemaRevertField[] = [];
      for (const target of targets) {
        const cases: { from: TableValue; to: TableValue }[] = [];
        let restored = 0;
        let kept = target.failed;
        for (const group of target.groups.values()) {
          const [only, ...others] = group.wants.values();
          const rows = [...group.wants.values()].reduce((total, entry) => total + entry.rows, 0);
          // A case changes every row with that value, so it is only safe when those rows all want the same earlier value.
          if (
            only &&
            !others.length &&
            mappedValueKey(only.value) !== mappedValueKey(group.value) &&
            cases.length < transformLimits.cases
          ) {
            cases.push({ from: group.value, to: only.value });
            restored += rows;
          } else kept += rows;
        }
        outputs.push({
          fieldId: target.field.id,
          expression: cases.length
            ? ({ op: 'map', input: target.base, cases, unmatched: 'preserve' } satisfies TransformExpression)
            : target.base,
        });
        fields.push({ fieldId: target.field.id, label: target.field.label, restored, kept });
      }
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
