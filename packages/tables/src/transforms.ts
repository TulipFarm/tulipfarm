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

export const transformLimits = Object.freeze({ depth: 16, expressions: 256, outputs: 64, cases: 256, rows: 1000 });
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
const convertExpression = z
  .strictObject({
    op: z.literal('convert'),
    get input(): ExpressionSchema {
      return expressionNodeSchema;
    },
    to: z.enum(['text', 'numeric', 'boolean', 'date', 'timestamp']),
    timezone: z.literal('UTC'),
    onError: z.enum(['error', 'null']),
  })
  .meta({
    description:
      'Converts a value to another field kind, following fixed rules. To text: text, numeric, boolean, date and timestamp values; options and references need map. To numeric: numeric values, decimal text such as "100.50" or "-7.25", and booleans as "1" or "0". To boolean: booleans, the exact text "true" or "false", and numeric 0 or 1. To date: date text or the UTC date of a timestamp. A date converted to a timestamp becomes midnight UTC. Null stays null. Locale-specific dates and exponent notation such as "1e3" fail with conversion-failed; onError "null" turns failures into null instead.',
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
const rowsExpression = z
  .strictObject({
    op: z.literal('rows'),
    get input(): ExpressionSchema {
      return expressionNodeSchema;
    },
    cases: z
      .array(z.strictObject({ recordId: z.uuid(), to: valueSchema }))
      .min(1)
      .max(transformLimits.rows)
      .refine(cases => new Set(cases.map(entry => entry.recordId)).size === cases.length, 'Duplicate row'),
  })
  .meta({
    description:
      'Gives the listed rows, by row id, their own value; every other row gets the input value. Use it to restore earlier values of particular rows.',
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
    typeof rowsExpression,
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
  rowsExpression,
]);

export const expressionSchema = boundedInputSchema.pipe(expressionNodeSchema);
/** The transform structure without the raw-input bounds, so JSON Schema shows models its expressions. */
export const transformOutputsSchema = z
  .strictObject({
    outputs: z
      .array(z.strictObject({ fieldId: fieldIdSchema, expression: expressionNodeSchema }))
      .max(transformLimits.outputs)
      .refine(
        outputs => new Set(outputs.map(output => output.fieldId)).size === outputs.length,
        'Duplicate output field',
      ),
  })
  .meta({
    description:
      'Computes new values for every existing row during a schema change; each output reads the original row. A field without an output keeps its current value unchanged, so when an existing field changes kind, add an output for it, usually {"fieldId":F,"expression":{"op":"convert","input":{"op":"field","fieldId":F},"to":"numeric","timezone":"UTC","onError":"error"}}. Use {"outputs":[]} for a new table or when no existing value changes.',
  });
export const transformsSchema = boundedInputSchema.pipe(transformOutputsSchema);
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

type Row = { id: string | null; values: TableValues };
const rowCases = new WeakMap<readonly { recordId: string }[], Map<string, TableValue>>();

function evaluate(expression: TransformExpression, row: Row): TableValue {
  const result = valueSchema.safeParse(evaluateNode(expression, row));
  if (!result.success) throw new EvaluationError('invalid-output', 'Intermediate value exceeds supported bounds');
  return result.data;
}

function evaluateNode(expression: TransformExpression, row: Row): TableValue {
  switch (expression.op) {
    case 'field': {
      const value = row.values[expression.fieldId];
      if (value === undefined) throw new EvaluationError('missing-field', 'Source field is missing');
      return value;
    }
    case 'literal':
      return expression.value;
    case 'default': {
      const value = evaluate(expression.input, row);
      return value === null ? evaluate(expression.fallback, row) : value;
    }
    case 'trim': {
      const value = evaluate(expression.input, row);
      return value === null ? null : { kind: 'text', value: text(value).trim() };
    }
    case 'split': {
      const value = evaluate(expression.input, row);
      if (value === null) return null;
      const part = text(value).split(expression.separator, expression.index + 1)[expression.index];
      if (part !== undefined) return { kind: 'text', value: part };
      if (expression.missing === 'null') return null;
      throw new EvaluationError('split-index', 'Split part is missing');
    }
    case 'join': {
      const parts = expression.inputs.map(input => evaluate(input, row));
      const texts = parts.map(value => (value === null ? null : text(value)));
      return texts.includes(null) ? null : { kind: 'text', value: texts.join(expression.separator) };
    }
    case 'map': {
      const value = evaluate(expression.input, row);
      const mapped = expression.cases.find(entry => valueKey(entry.from) === valueKey(value));
      if (mapped) return mapped.to;
      if (expression.unmatched === 'null') return null;
      if (expression.unmatched === 'preserve') return value;
      throw new EvaluationError('unmapped-value', 'No mapping for source value');
    }
    case 'rows': {
      const cases =
        rowCases.get(expression.cases) ?? new Map(expression.cases.map(entry => [entry.recordId, entry.to]));
      rowCases.set(expression.cases, cases);
      const restored = row.id === null ? undefined : cases.get(row.id);
      return restored === undefined ? evaluate(expression.input, row) : restored;
    }
    case 'convert': {
      const value = evaluate(expression.input, row);
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

/** The value one expression produces for a row, or the evaluation error code. */
export function evaluateExpression(
  expression: TransformExpression,
  values: TableValues,
  recordId: string | null = null,
): { ok: true; value: TableValue } | { ok: false; code: TransformError['code'] } {
  try {
    return { ok: true, value: evaluate(expression, { id: recordId, values }) };
  } catch (error) {
    if (!(error instanceof EvaluationError)) throw error;
    return { ok: false, code: error.code };
  }
}

/** Values with the same key match the same map case. */
export function mappedValueKey(value: TableValue) {
  return valueKey(value);
}

const parsed = new WeakMap<object, ReturnType<typeof transformsSchema.safeParse>>();
/** Parses each transforms object once, since one schema change evaluates the same transforms for every row. */
function parsedTransforms(input: unknown) {
  if (typeof input !== 'object' || input === null) return transformsSchema.safeParse(input);
  const result = parsed.get(input) ?? transformsSchema.safeParse(input);
  parsed.set(input, result);
  return result;
}

// Every output reads the same source snapshot. Output order never creates dependencies.
// Unassigned fields carry through only when present in the target definition.
export function evaluateTransforms(input: {
  transforms: unknown;
  values: unknown;
  target: unknown;
  /** The row being transformed, for expressions that give particular rows their own value. */
  recordId?: string;
}): TransformResult {
  const transforms = parsedTransforms(input.transforms);
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
      values[output.fieldId] = evaluate(output.expression, { id: input.recordId ?? null, values: source.data });
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
