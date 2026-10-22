import { z } from 'zod';
import {
  TableValidationError,
  dateSchema,
  decimalSchema,
  definitionSchema,
  fieldIdSchema,
  timestampSchema,
  validateRecord,
  validateValue,
  valueSchema,
  valuesSchema,
  type TableValue,
  type TableValues,
} from './definition.ts';

export const transformLimits = Object.freeze({ depth: 16, expressions: 256, outputs: 64, cases: 256 });
const separatorSchema = z.string().max(100);
const boundedInputSchema = z.unknown().superRefine((input, context) => {
  const pending = [{ value: input, depth: 0, expressionDepth: 0 }];
  let visited = 0;
  let expressions = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    const { value, depth } = item;
    if (++visited > 100000 || depth > 64) {
      context.addIssue({ code: 'custom', message: 'Input exceeds structural bounds' });
      return;
    }
    if (typeof value !== 'object' || value === null) continue;
    const expressionDepth = item.expressionDepth + ('op' in value ? 1 : 0);
    if ('op' in value) expressions++;
    if (expressionDepth > transformLimits.depth || expressions > transformLimits.expressions) {
      context.addIssue({ code: 'custom', message: 'Transform exceeds expression bounds' });
      return;
    }
    const children: unknown[] = Object.values(value);
    if (children.length + pending.length > 100000) {
      context.addIssue({ code: 'custom', message: 'Input exceeds structural bounds' });
      return;
    }
    for (const child of children) pending.push({ value: child, depth: depth + 1, expressionDepth });
  }
});

const fieldExpression = z.strictObject({ op: z.literal('field'), fieldId: fieldIdSchema });
const literalExpression = z.strictObject({ op: z.literal('literal'), value: valueSchema });
const trimExpression = z.strictObject({
  op: z.literal('trim'),
  get input(): ExpressionSchema {
    return expressionNodeSchema;
  },
});
const splitExpression = z.strictObject({
  op: z.literal('split'),
  get input(): ExpressionSchema {
    return expressionNodeSchema;
  },
  separator: separatorSchema.min(1),
  index: z.int().min(0).max(255),
  missing: z.enum(['error', 'null']),
});
const joinExpression = z.strictObject({
  op: z.literal('join'),
  get inputs(): z.ZodArray<ExpressionSchema> {
    return z.array(expressionNodeSchema).min(1).max(64);
  },
  separator: separatorSchema,
});
const defaultExpression = z.strictObject({
  op: z.literal('default'),
  get input(): ExpressionSchema {
    return expressionNodeSchema;
  },
  get fallback(): ExpressionSchema {
    return expressionNodeSchema;
  },
});
const convertExpression = z.strictObject({
  op: z.literal('convert'),
  get input(): ExpressionSchema {
    return expressionNodeSchema;
  },
  to: z.enum(['text', 'numeric', 'boolean', 'date', 'timestamp']),
  timezone: z.literal('UTC'),
  onError: z.enum(['error', 'null']),
});
const mapExpression = z.strictObject({
  op: z.literal('map'),
  get input(): ExpressionSchema {
    return expressionNodeSchema;
  },
  cases: z
    .array(z.strictObject({ from: valueSchema, to: valueSchema }))
    .min(1)
    .max(transformLimits.cases)
    .refine(
      cases => new Set(cases.map(entry => valueKey(entry.from))).size === cases.length,
      'Duplicate mapping input',
    ),
  unmatched: z.enum(['error', 'null', 'preserve']),
});
type ExpressionSchema = z.ZodDiscriminatedUnion<
  [
    typeof fieldExpression,
    typeof literalExpression,
    typeof trimExpression,
    typeof splitExpression,
    typeof joinExpression,
    typeof defaultExpression,
    typeof convertExpression,
    typeof mapExpression,
  ],
  'op'
>;
const expressionNodeSchema: ExpressionSchema = z.discriminatedUnion('op', [
  fieldExpression,
  literalExpression,
  trimExpression,
  splitExpression,
  joinExpression,
  defaultExpression,
  convertExpression,
  mapExpression,
]);

export const expressionSchema = boundedInputSchema.pipe(expressionNodeSchema);
export const transformsSchema = boundedInputSchema.pipe(
  z.strictObject({
    outputs: z
      .array(z.strictObject({ fieldId: fieldIdSchema, expression: expressionNodeSchema }))
      .max(transformLimits.outputs)
      .refine(
        outputs => new Set(outputs.map(output => output.fieldId)).size === outputs.length,
        'Duplicate output field',
      ),
  }),
);
export type TransformExpression = z.infer<typeof expressionSchema>;
export type Transforms = z.infer<typeof transformsSchema>;
export const transformErrorSchema = z.strictObject({
  code: z.enum([
    'invalid-input',
    'missing-field',
    'type-mismatch',
    'unmapped-value',
    'conversion-failed',
    'split-index',
    'invalid-output',
  ]),
  message: z.string(),
  fieldId: fieldIdSchema.optional(),
});
export type TransformError = z.infer<typeof transformErrorSchema>;
export const transformResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), values: valuesSchema }),
  z.strictObject({ ok: z.literal(false), error: transformErrorSchema }),
]);
export type TransformResult = z.infer<typeof transformResultSchema>;

class EvaluationError extends Error {
  readonly code: TransformError['code'];
  constructor(code: TransformError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

function decimalKey(value: string): string {
  const normalized = value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return normalized === '-0' ? '0' : normalized;
}

function valueKey(value: TableValue): string {
  if (value === null) return 'null';
  switch (value.kind) {
    case 'numeric':
      return `numeric:${decimalKey(value.value)}`;
    case 'text':
    case 'boolean':
    case 'date':
    case 'timestamp':
      return `${value.kind}:${value.value}`;
    case 'single-select':
      return `single-select:${value.optionId}`;
    case 'multi-select':
      return `multi-select:${[...value.optionIds].sort().join(',')}`;
    case 'relationship':
      return `relationship:${value.tableId}:${[...value.recordIds].sort().join(',')}`;
    case 'file':
      return `file:${[...value.fileIds].sort().join(',')}`;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function text(value: Exclude<TableValue, null>): string {
  if (value.kind !== 'text') throw new EvaluationError('type-mismatch', 'Operation requires text');
  return value.value;
}

function convert(
  value: Exclude<TableValue, null>,
  to: Extract<TransformExpression, { op: 'convert' }>['to'],
): TableValue {
  if (!('value' in value))
    throw new EvaluationError('conversion-failed', 'Options and references require explicit mapping');
  switch (to) {
    case 'text':
      return { kind: 'text', value: String(value.value) };
    case 'numeric': {
      if (value.kind !== 'text' && value.kind !== 'numeric' && value.kind !== 'boolean')
        throw new EvaluationError('conversion-failed', 'Unsupported numeric conversion');
      const decimal = typeof value.value === 'boolean' ? (value.value ? '1' : '0') : value.value;
      return { kind: 'numeric', value: decimalSchema.parse(decimal) };
    }
    case 'boolean': {
      if (value.kind === 'boolean') return value;
      if (value.kind === 'text' && (value.value === 'true' || value.value === 'false'))
        return { kind: 'boolean', value: value.value === 'true' };
      if (value.kind === 'numeric' && ['0', '1'].includes(decimalKey(value.value)))
        return { kind: 'boolean', value: decimalKey(value.value) === '1' };
      throw new EvaluationError('conversion-failed', 'Boolean conversion requires true, false, or numeric zero or one');
    }
    case 'date': {
      if (value.kind !== 'text' && value.kind !== 'date' && value.kind !== 'timestamp')
        throw new EvaluationError('conversion-failed', 'Unsupported date conversion');
      return {
        kind: 'date',
        value: dateSchema.parse(value.kind === 'timestamp' ? value.value.slice(0, 10) : value.value),
      };
    }
    case 'timestamp': {
      if (value.kind !== 'text' && value.kind !== 'date' && value.kind !== 'timestamp')
        throw new EvaluationError('conversion-failed', 'Unsupported timestamp conversion');
      return {
        kind: 'timestamp',
        value: timestampSchema.parse(value.kind === 'date' ? `${value.value}T00:00:00.000Z` : value.value),
      };
    }
    default: {
      const exhaustive: never = to;
      return exhaustive;
    }
  }
}

function evaluate(expression: TransformExpression, values: TableValues): TableValue {
  const result = valueSchema.safeParse(evaluateNode(expression, values));
  if (!result.success) throw new EvaluationError('invalid-output', 'Intermediate value exceeds supported bounds');
  return result.data;
}

function evaluateNode(expression: TransformExpression, values: TableValues): TableValue {
  switch (expression.op) {
    case 'field': {
      const value = values[expression.fieldId];
      if (value === undefined) throw new EvaluationError('missing-field', 'Source field is missing');
      return value;
    }
    case 'literal':
      return expression.value;
    case 'default': {
      const value = evaluate(expression.input, values);
      return value === null ? evaluate(expression.fallback, values) : value;
    }
    case 'trim': {
      const value = evaluate(expression.input, values);
      return value === null ? null : { kind: 'text', value: text(value).trim() };
    }
    case 'split': {
      const value = evaluate(expression.input, values);
      if (value === null) return null;
      const part = text(value).split(expression.separator, expression.index + 1)[expression.index];
      if (part !== undefined) return { kind: 'text', value: part };
      if (expression.missing === 'null') return null;
      throw new EvaluationError('split-index', 'Split part is missing');
    }
    case 'join': {
      const parts = expression.inputs.map(input => evaluate(input, values));
      const texts = parts.map(value => (value === null ? null : text(value)));
      return texts.includes(null) ? null : { kind: 'text', value: texts.join(expression.separator) };
    }
    case 'map': {
      const value = evaluate(expression.input, values);
      const mapped = expression.cases.find(entry => valueKey(entry.from) === valueKey(value));
      if (mapped) return mapped.to;
      if (expression.unmatched === 'null') return null;
      if (expression.unmatched === 'preserve') return value;
      throw new EvaluationError('unmapped-value', 'No mapping for source value');
    }
    case 'convert': {
      const value = evaluate(expression.input, values);
      if (value === null) return null;
      try {
        return convert(value, expression.to);
      } catch (error) {
        if (!(error instanceof z.ZodError) && !(error instanceof EvaluationError)) throw error;
        if (expression.onError === 'null') return null;
        throw new EvaluationError('conversion-failed', 'Value cannot be converted by the selected rule');
      }
    }
    default: {
      const exhaustive: never = expression;
      return exhaustive;
    }
  }
}

// Every output reads the same source snapshot. Output order never creates dependencies.
// Unassigned fields carry through only when present in the target definition.
export function evaluateTransforms(input: { transforms: unknown; values: unknown; target: unknown }): TransformResult {
  const transforms = transformsSchema.safeParse(input.transforms);
  const source = boundedInputSchema.pipe(valuesSchema).safeParse(input.values);
  const target = boundedInputSchema.pipe(definitionSchema).safeParse(input.target);
  if (!transforms.success || !source.success || !target.success)
    return {
      ok: false,
      error: { code: 'invalid-input', message: 'Invalid transforms, source values, or target definition' },
    };
  const values: TableValues = {};
  for (const field of target.data.fields) {
    const value = source.data[field.id];
    if (value !== undefined) values[field.id] = value;
  }
  for (const output of transforms.data.outputs) {
    if (!target.data.fields.some(field => field.id === output.fieldId))
      return { ok: false, error: { code: 'invalid-output', message: 'Unknown target field', fieldId: output.fieldId } };
    try {
      values[output.fieldId] = evaluate(output.expression, source.data);
    } catch (error) {
      if (!(error instanceof EvaluationError)) throw error;
      return { ok: false, error: { code: error.code, message: error.message, fieldId: output.fieldId } };
    }
  }
  for (const field of target.data.fields) {
    try {
      validateValue(field, values[field.id] ?? null);
    } catch (error) {
      if (!(error instanceof z.ZodError) && !(error instanceof TableValidationError)) throw error;
      return {
        ok: false,
        error: {
          code: 'invalid-output',
          message: 'Transformed field does not satisfy the target definition',
          fieldId: field.id,
        },
      };
    }
  }
  try {
    return { ok: true, values: validateRecord(target.data, values) };
  } catch (error) {
    if (!(error instanceof z.ZodError) && !(error instanceof TableValidationError)) throw error;
    return {
      ok: false,
      error: { code: 'invalid-output', message: 'Transformed row does not satisfy the target definition' },
    };
  }
}
