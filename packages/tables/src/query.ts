import { z } from 'zod';
import { parse as parseRsqlText } from '@rsql/parser';
import { emit } from '@rsql/emitter';
import {
  createComparisonNode,
  createLogicNode,
  createSelectorNode,
  createValueNode,
  isComparisonNode,
  isLogicNode,
  type ExpressionNode,
} from '@rsql/ast';
import {
  cursorSchema,
  dateSchema,
  decimalSchema,
  sortDirectionSchema,
  timestampSchema,
  validateValue,
  valuesSchema,
  type TableDefinition,
  type TableField,
  type TableValue,
} from './definition.ts';
import { queryLimits } from './query-limits.ts';
import { workspaceMemberLabel } from './workspace-members.ts';

/** Browser-safe table query contract. SQL compilation lives in the server-only table service. */
export { queryLimits };

export const queryOps = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'out',
  'contains',
  'empty',
  'not-empty',
  'is-me',
] as const;
export type QueryOp = (typeof queryOps)[number];
const valuelessOps: readonly QueryOp[] = ['empty', 'not-empty', 'is-me'];
const listOps: readonly QueryOp[] = ['in', 'out'];

const ordered = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'out',
  'empty',
  'not-empty',
] as const satisfies readonly QueryOp[];
const equality = ['eq', 'ne', 'in', 'out', 'empty', 'not-empty'] as const satisfies readonly QueryOp[];
const membership = ['in', 'out', 'empty', 'not-empty'] as const satisfies readonly QueryOp[];
/** The published operator profile. Anything else, including syntactically valid custom RSQL operators, is rejected. */
export const kindQueryOps: Record<TableField['kind'], readonly QueryOp[]> = {
  text: ['eq', 'ne', 'in', 'out', 'contains', 'empty', 'not-empty'],
  numeric: ordered,
  date: ordered,
  timestamp: ordered,
  boolean: ['eq', 'ne', 'empty', 'not-empty'],
  'single-select': equality,
  'multi-select': membership,
  relationship: [...membership, 'is-me'],
  file: ['empty', 'not-empty'],
};
export const scalarQueryKinds: readonly TableField['kind'][] = [
  'text',
  'numeric',
  'boolean',
  'date',
  'timestamp',
  'single-select',
];
export const metricFunctions = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type MetricFunction = (typeof metricFunctions)[number];
const metricKinds: Record<Exclude<MetricFunction, 'count'>, readonly TableField['kind'][]> = {
  sum: ['numeric'],
  avg: ['numeric'],
  min: ['numeric', 'date', 'timestamp'],
  max: ['numeric', 'date', 'timestamp'],
};

const literalSchema = z.string().max(queryLimits.literalCharacters);
/** Query field IDs stay unbranded so browsers and tools can build queries; every ID is checked against the definition before use. */
const queryFieldIdSchema = z.uuid().toLowerCase();
export const queryRuleSchema = z.strictObject({
  kind: z.literal('rule'),
  fieldId: queryFieldIdSchema,
  op: z.enum(queryOps),
  values: z.array(literalSchema).max(queryLimits.values).default([]),
});
export type QueryRule = z.infer<typeof queryRuleSchema>;
export type QueryGroup = { kind: 'all' | 'any'; nodes: QueryNode[] };
export type QueryNode = QueryRule | QueryGroup;
export const queryNodeSchema: z.ZodType<QueryNode> = z.lazy(() =>
  z.union([
    queryRuleSchema,
    z.strictObject({ kind: z.enum(['all', 'any']), nodes: z.array(queryNodeSchema).max(queryLimits.nodes) }),
  ]),
);
export const querySortSchema = z.strictObject({
  fieldId: queryFieldIdSchema,
  direction: sortDirectionSchema.default('asc'),
});
export const queryMetricSchema = z.strictObject({
  fn: z.enum(metricFunctions),
  fieldId: queryFieldIdSchema.optional(),
});
export type QueryMetric = z.infer<typeof queryMetricSchema>;
const common = {
  version: z.literal(2),
  where: queryNodeSchema.nullable().default(null),
  search: z.string().trim().min(1).max(queryLimits.searchCharacters).optional(),
  after: cursorSchema.optional(),
};
export const tableRowsQuerySchema = z.strictObject({
  ...common,
  mode: z.literal('rows'),
  select: z.array(queryFieldIdSchema).min(1).max(64).optional(),
  sort: z.array(querySortSchema).max(queryLimits.sortKeys).default([]),
  limit: z.int().min(1).max(queryLimits.pageSize).default(50),
});
export const tableSummaryQuerySchema = z.strictObject({
  ...common,
  mode: z.literal('summary'),
  groupBy: z.array(queryFieldIdSchema).max(queryLimits.groupBy).default([]),
  metrics: z
    .array(queryMetricSchema)
    .min(1)
    .max(queryLimits.metrics)
    .default([{ fn: 'count' }]),
  order: z
    .strictObject({
      kind: z.enum(['group', 'metric']),
      index: z
        .int()
        .min(0)
        .max(queryLimits.metrics - 1),
      direction: sortDirectionSchema,
    })
    .optional(),
  limit: z.int().min(1).max(queryLimits.groupPage).default(50),
});
export const tableQuerySchema = z.discriminatedUnion('mode', [tableRowsQuerySchema, tableSummaryQuerySchema]);
export type TableQuery = z.infer<typeof tableQuerySchema>;
export type TableRowsQuery = z.infer<typeof tableRowsQuerySchema>;
export type TableSummaryQuery = z.infer<typeof tableSummaryQuerySchema>;

/** A request carries typed RSQL or a structured filter tree, never both. Options are identical either way. */
export const tableQueryRequestSchema = z.union([
  z.strictObject({ query: tableQuerySchema }),
  z.strictObject({
    rsql: z.string().max(queryLimits.rsqlCharacters),
    options: z.union([tableRowsQuerySchema.omit({ where: true }), tableSummaryQuerySchema.omit({ where: true })]),
  }),
]);
export type TableQueryRequest = z.infer<typeof tableQueryRequestSchema>;

export type QueryIssueCode =
  | 'syntax'
  | 'too-large'
  | 'too-deep'
  | 'too-many-rules'
  | 'too-many-values'
  | 'unknown-field'
  | 'ambiguous-field'
  | 'unsupported-operator'
  | 'invalid-value'
  | 'unknown-option'
  | 'ambiguous-option'
  | 'unresolved-reference'
  | 'invalid-option'
  | 'human-context-required';
export type QueryIssue = {
  code: QueryIssueCode;
  message: string;
  selector?: string;
  value?: string;
  position?: number;
  fieldId?: string;
  choices?: { id: string; label: string }[];
};
export class TableQueryError extends Error {
  constructor(readonly issues: QueryIssue[]) {
    super(issues.map(issue => issue.message).join(' '));
    this.name = 'TableQueryError';
  }
}

export type FieldCapability = {
  fieldId: string;
  selector: string;
  alias: string | null;
  label: string;
  kind: TableField['kind'];
  ops: readonly QueryOp[];
  sortable: boolean;
  groupable: boolean;
  metrics: readonly Exclude<MetricFunction, 'count'>[];
  options?: { id: string; label: string; retired: boolean }[];
  targetTableId?: string;
  cardinality?: 'one' | 'many';
};
export type QueryCapabilities = {
  fields: FieldCapability[];
  limits: typeof queryLimits;
  rsqlOperators: Record<QueryOp, string>;
};

export const rsqlOperators: Record<QueryOp, string> = {
  eq: '==',
  ne: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  in: '=in=',
  out: '=out=',
  contains: '=contains=',
  empty: '=isnull=true',
  'not-empty': '=isnull=false',
  'is-me': '=isme=true',
};
const fromRsql: Record<string, QueryOp> = {
  '==': 'eq',
  '!=': 'ne',
  '<': 'lt',
  '=lt=': 'lt',
  '<=': 'lte',
  '=le=': 'lte',
  '>': 'gt',
  '=gt=': 'gt',
  '>=': 'gte',
  '=ge=': 'gte',
  '=in=': 'in',
  '=out=': 'out',
  '=contains=': 'contains',
};
const reserved = new Set(['and', 'or', 'true', 'false', 'null']);

export const fieldSelector = (id: string) => `f_${id.replaceAll('-', '')}`;
const slug = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Readable aliases are offered only when unique, safe in RSQL, and not mistakable for a stable selector. */
export function queryCapabilities(
  definition: Pick<TableDefinition, 'fields'>,
  memberTableId?: string,
): QueryCapabilities {
  const slugs = definition.fields.map(field => slug(field.label));
  const counts = new Map<string, number>();
  for (const value of slugs) counts.set(value, (counts.get(value) ?? 0) + 1);
  const fields = definition.fields.map((field, index): FieldCapability => {
    const candidate = slugs[index] ?? '';
    const alias =
      candidate &&
      !/^[0-9]/.test(candidate) &&
      !/^f_[0-9a-f]{32}$/.test(candidate) &&
      !reserved.has(candidate) &&
      counts.get(candidate) === 1
        ? candidate
        : null;
    const scalar = scalarQueryKinds.includes(field.kind);
    return {
      fieldId: field.id,
      selector: alias ?? fieldSelector(field.id),
      alias,
      label: field.label,
      kind: field.kind,
      ops: kindQueryOps[field.kind].filter(
        op => op !== 'is-me' || (field.kind === 'relationship' && field.targetTableId === memberTableId),
      ),
      sortable: scalar,
      groupable: scalar,
      metrics: (Object.keys(metricKinds) as (keyof typeof metricKinds)[]).filter(fn =>
        metricKinds[fn].includes(field.kind),
      ),
      ...(field.kind === 'single-select' || field.kind === 'multi-select'
        ? { options: field.options.map(option => ({ id: option.id, label: option.label, retired: option.retired })) }
        : {}),
      ...(field.kind === 'relationship' ? { targetTableId: field.targetTableId, cardinality: field.cardinality } : {}),
    };
  });
  return { fields, limits: queryLimits, rsqlOperators };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveSelector(
  definition: Pick<TableDefinition, 'fields'>,
  capabilities: QueryCapabilities,
  selector: string,
) {
  const lowered = selector.toLowerCase();
  const matches = capabilities.fields.filter(
    field => field.alias === lowered || fieldSelector(field.fieldId) === lowered,
  );
  if (matches.length > 1)
    throw new TableQueryError([
      { code: 'ambiguous-field', selector, message: `"${selector}" matches more than one field. Use its f_ selector.` },
    ]);
  const match = matches[0];
  const field = match && definition.fields.find(item => item.id === match.fieldId);
  if (!field)
    throw new TableQueryError([
      { code: 'unknown-field', selector, message: `There is no field called "${selector}".` },
    ]);
  return field;
}

/** Converts one authored literal to its stored representation. Option labels resolve to IDs; links must already be IDs. */
/** Field ID -> lower-cased linked-row name -> record ID, produced by the server's authorized name lookup. */
export type ReferenceNames = Record<string, Record<string, string>>;
export function normalizeLiteral(
  field: TableField,
  raw: string,
  issues: QueryIssue[],
  selector = field.label,
  references: ReferenceNames = {},
): string | null {
  const invalid = (message: string, code: QueryIssueCode = 'invalid-value') => {
    issues.push({ code, selector, value: raw, message });
    return null;
  };
  if (raw.length > queryLimits.literalCharacters)
    return invalid(`Values are limited to ${queryLimits.literalCharacters} characters.`);
  switch (field.kind) {
    case 'text':
      return raw;
    case 'numeric': {
      if (!decimalSchema.safeParse(raw).success) return invalid(`"${raw}" is not a number for ${field.label}.`);
      try {
        validateValue(field, { kind: 'numeric', value: raw });
      } catch {
        return invalid(
          `${field.label} allows ${field.precision - field.scale} whole digits and ${field.scale} decimal places.`,
        );
      }
      return raw;
    }
    case 'date':
      return dateSchema.safeParse(raw).success
        ? raw
        : invalid(`"${raw}" is not a date (YYYY-MM-DD) for ${field.label}.`);
    case 'timestamp': {
      const parsed = timestampSchema.safeParse(raw);
      return parsed.success
        ? parsed.data
        : invalid(`"${raw}" is not a timestamp with a timezone, such as 2026-10-01T09:00:00Z.`);
    }
    case 'boolean': {
      const lowered = raw.toLowerCase();
      return lowered === 'true' || lowered === 'false' ? lowered : invalid(`${field.label} accepts true or false.`);
    }
    case 'single-select':
    case 'multi-select': {
      const byId = field.options.filter(option => option.id === raw.toLowerCase());
      const byLabel = field.options.filter(option => option.label.toLowerCase() === raw.toLowerCase());
      if (byId.length && byLabel.length && byId[0] !== byLabel[0])
        return invalid(`"${raw}" is both an option label and another option's ID.`, 'ambiguous-option');
      const matches = byId.length ? byId : byLabel;
      if (matches.length > 1)
        return invalid(
          `More than one ${field.label} option is called "${raw}". Use its option ID.`,
          'ambiguous-option',
        );
      return matches[0]?.id ?? invalid(`${field.label} has no option "${raw}".`, 'unknown-option');
    }
    case 'relationship':
      return uuidPattern.test(raw)
        ? raw.toLowerCase()
        : (references[field.id]?.[raw.toLowerCase()] ??
            (issues.push({
              code: 'unresolved-reference',
              selector,
              fieldId: field.id,
              value: raw,
              message: `Choose which linked row "${raw}" means.`,
            }),
            null));
    case 'file':
      return invalid(`${field.label} can only be checked for being empty.`);
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

type Budget = { comparisons: number };
function fromAst(
  node: ExpressionNode,
  definition: Pick<TableDefinition, 'fields'>,
  capabilities: QueryCapabilities,
  issues: QueryIssue[],
  budget: Budget,
  references: ReferenceNames,
): QueryNode | null {
  if (isLogicNode(node)) {
    const kind = node.operator === 'and' || node.operator === ';' ? 'all' : 'any';
    const nodes: QueryNode[] = [];
    // Iterative left-spine flattening keeps long `a;b;c;...` chains shallow and avoids recursion depth on the parser's binary tree.
    const pending: ExpressionNode[] = [node];
    while (pending.length) {
      const current = pending.pop()!;
      const sameKind =
        isLogicNode(current) && (current.operator === 'and' || current.operator === ';' ? 'all' : 'any') === kind;
      if (sameKind && isLogicNode(current)) {
        pending.push(current.right, current.left);
        continue;
      }
      const child = fromAst(current, definition, capabilities, issues, budget, references);
      if (child) nodes.push(child);
    }
    return { kind, nodes };
  }
  if (!isComparisonNode(node)) {
    issues.push({ code: 'syntax', message: 'Expected a comparison.' });
    return null;
  }
  budget.comparisons += 1;
  const selector = node.left.selector;
  let field: TableField;
  try {
    field = resolveSelector(definition, capabilities, selector);
  } catch (error) {
    if (error instanceof TableQueryError) {
      issues.push(...error.issues);
      return null;
    }
    throw error;
  }
  const raw = node.right.value;
  let op: QueryOp | undefined = fromRsql[node.operator];
  let literals = Array.isArray(raw) ? raw : [raw];
  if (node.operator === '=isnull=') {
    const flag = Array.isArray(raw) ? undefined : raw.toLowerCase();
    if (flag !== 'true' && flag !== 'false') {
      issues.push({ code: 'invalid-value', selector, message: '=isnull= accepts true or false.' });
      return null;
    }
    op = flag === 'true' ? 'empty' : 'not-empty';
    literals = [];
  }
  if (node.operator === '=isme=') {
    if (Array.isArray(raw) || raw.toLowerCase() !== 'true') {
      issues.push({ code: 'invalid-value', selector, message: '=isme= accepts true and takes no member ID.' });
      return null;
    }
    op = 'is-me';
    literals = [];
  }
  if (!op || !kindQueryOps[field.kind].includes(op)) {
    issues.push({
      code: 'unsupported-operator',
      selector,
      message: `${field.label} does not support ${node.operator}. Use ${kindQueryOps[field.kind].map(item => rsqlOperators[item]).join(', ')}.`,
    });
    return null;
  }
  if (Array.isArray(raw) && !listOps.includes(op)) {
    issues.push({ code: 'invalid-value', selector, message: `${node.operator} takes one value, not a list.` });
    return null;
  }
  if (literals.length > queryLimits.values) {
    issues.push({ code: 'too-many-values', selector, message: `Lists are limited to ${queryLimits.values} values.` });
    return null;
  }
  const values = literals.map(literal => normalizeLiteral(field, literal, issues, selector, references));
  return { kind: 'rule', fieldId: field.id, op, values: values.filter((value): value is string => value !== null) };
}

function measure(node: QueryNode, depth = 1): { depth: number; comparisons: number; nodes: number } {
  if (node.kind === 'rule') return { depth, comparisons: 1, nodes: 1 };
  return node.nodes
    .map(child => measure(child, depth + 1))
    .reduce(
      (sum, item) => ({
        depth: Math.max(sum.depth, item.depth),
        comparisons: sum.comparisons + item.comparisons,
        nodes: sum.nodes + item.nodes,
      }),
      { depth, comparisons: 0, nodes: 1 },
    );
}

/** Removes empty groups and collapses one-child groups so equivalent filters print and digest identically. */
export function simplifyWhere(node: QueryNode | null): QueryNode | null {
  if (!node || node.kind === 'rule') return node;
  const nodes = node.nodes
    .map(simplifyWhere)
    .filter((child): child is QueryNode => child !== null)
    .flatMap(child => (child.kind === node.kind ? child.nodes : [child]));
  if (!nodes.length) return null;
  return nodes.length === 1 ? nodes[0]! : { kind: node.kind, nodes };
}

/** Validates a structured filter tree against a table: fields, operators, value types, list sizes, and limits. */
export function validateWhere(
  definition: Pick<TableDefinition, 'fields'>,
  where: QueryNode | null,
  references: ReferenceNames = {},
): QueryNode | null {
  const simplified = simplifyWhere(where);
  if (!simplified) return null;
  const size = measure(simplified),
    issues: QueryIssue[] = [];
  if (size.depth > queryLimits.depth)
    issues.push({ code: 'too-deep', message: `Groups can be nested at most ${queryLimits.depth} levels deep.` });
  if (size.comparisons > queryLimits.comparisons)
    issues.push({
      code: 'too-many-rules',
      message: `A search can have at most ${queryLimits.comparisons} conditions.`,
    });
  if (size.nodes > queryLimits.nodes)
    issues.push({
      code: 'too-many-rules',
      message: `A search can have at most ${queryLimits.nodes} conditions and groups.`,
    });
  if (issues.length) throw new TableQueryError(issues);
  const visit = (node: QueryNode): QueryNode => {
    if (node.kind !== 'rule') return { kind: node.kind, nodes: node.nodes.map(visit) };
    const field = definition.fields.find(item => item.id === node.fieldId);
    if (!field) {
      issues.push({ code: 'unknown-field', message: 'A condition uses a field that is not in this table.' });
      return node;
    }
    if (!kindQueryOps[field.kind].includes(node.op)) {
      issues.push({
        code: 'unsupported-operator',
        selector: field.label,
        message: `${field.label} does not support this condition.`,
      });
      return node;
    }
    const expected = valuelessOps.includes(node.op) ? 0 : listOps.includes(node.op) ? -1 : 1;
    if (expected === 0 && node.values.length)
      issues.push({
        code: 'invalid-value',
        selector: field.label,
        message: `${field.label}: this condition takes no value.`,
      });
    if (expected === 1 && node.values.length !== 1)
      issues.push({ code: 'invalid-value', selector: field.label, message: `${field.label}: enter one value.` });
    if (expected === -1 && !node.values.length)
      issues.push({
        code: 'invalid-value',
        selector: field.label,
        message: `${field.label}: choose at least one value.`,
      });
    if (node.op === 'contains' && !node.values[0])
      issues.push({ code: 'invalid-value', selector: field.label, message: `${field.label}: enter text to look for.` });
    return {
      ...node,
      values: node.values.map(value => normalizeLiteral(field, value, issues, field.label, references) ?? value),
    };
  };
  const result = visit(simplified);
  if (issues.length) throw new TableQueryError(issues);
  return result;
}

/** Parses the published RSQL profile into a validated filter tree. Never evaluates or forwards the text. */
export function parseRsql(
  definition: Pick<TableDefinition, 'fields'>,
  text: string,
  references: ReferenceNames = {},
): QueryNode | null {
  if (text.length > queryLimits.rsqlCharacters)
    throw new TableQueryError([
      { code: 'too-large', message: `Queries are limited to ${queryLimits.rsqlCharacters} characters.` },
    ]);
  if (!text.trim()) return null;
  let ast: ExpressionNode;
  try {
    ast = parseRsqlText(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid query';
    const position = /at position (\d+)/.exec(message)?.[1];
    throw new TableQueryError([
      { code: 'syntax', message: friendlySyntax(message), ...(position ? { position: Number(position) } : {}) },
    ]);
  }
  const issues: QueryIssue[] = [],
    budget = { comparisons: 0 };
  const where = fromAst(ast, definition, queryCapabilities(definition), issues, budget, references);
  if (budget.comparisons > queryLimits.comparisons)
    issues.push({
      code: 'too-many-rules',
      message: `A search can have at most ${queryLimits.comparisons} conditions.`,
    });
  if (issues.length) throw new TableQueryError(issues);
  return validateWhere(definition, where, references);
}

function friendlySyntax(message: string) {
  if (/Unexpected end/.test(message))
    return 'The query ends too early. Finish the last condition, for example status==Open.';
  const token = /Unexpected (?:string|character|token) '?([^' ]*)'? at position (\d+)/.exec(message);
  return token
    ? `Unexpected "${token[1]}" at character ${Number(token[2]) + 1}. Conditions look like field==value, joined by and / or.`
    : 'This is not a valid query. Conditions look like field==value, joined by and / or.';
}

const labelFor = (field: TableField, value: string) =>
  field.kind === 'single-select' || field.kind === 'multi-select'
    ? field.options.find(option => option.id === value)
    : undefined;

/** Prints readable RSQL that parses back to the same tree. Option labels are used only when they round-trip unambiguously. */
export function printRsql(definition: Pick<TableDefinition, 'fields'>, where: QueryNode | null): string {
  if (!where) return '';
  const capabilities = queryCapabilities(definition);
  const toAst = (node: QueryNode): ExpressionNode => {
    if (node.kind !== 'rule') {
      const [first, ...rest] = node.nodes.map(toAst);
      if (!first) throw new TableQueryError([{ code: 'syntax', message: 'Empty group' }]);
      return rest.reduce((left, right) => createLogicNode(left, node.kind === 'all' ? 'and' : 'or', right), first);
    }
    const field = definition.fields.find(item => item.id === node.fieldId);
    const capability = capabilities.fields.find(item => item.fieldId === node.fieldId);
    if (!field || !capability)
      throw new TableQueryError([
        { code: 'unknown-field', message: 'A condition uses a field that is not in this table.' },
      ]);
    const selector = createSelectorNode(capability.selector, true);
    if (node.op === 'is-me') return createComparisonNode(selector, '=isme=', createValueNode('true', true));
    if (node.op === 'empty' || node.op === 'not-empty')
      return createComparisonNode(selector, '=isnull=', createValueNode(node.op === 'empty' ? 'true' : 'false', true));
    const values = node.values.map(value => {
      const option = labelFor(field, value);
      if (!option || (field.kind !== 'single-select' && field.kind !== 'multi-select')) return value;
      const unique =
        field.options.filter(item => item.label.toLowerCase() === option.label.toLowerCase()).length === 1 &&
        !uuidPattern.test(option.label);
      return unique ? option.label : option.id;
    });
    return createComparisonNode(
      selector,
      rsqlOperators[node.op],
      createValueNode(listOps.includes(node.op) ? values : (values[0] ?? ''), true),
    );
  };
  return emit(toAst(where), { preferredQuote: '"', optimizeQuotes: true });
}

/** Plain-language rendering for active-query summaries and tool explanations. */
export const opLabels: Record<QueryOp, string> = {
  eq: 'is',
  ne: 'is not',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is greater than',
  gte: 'is at least',
  in: 'is any of',
  out: 'is none of',
  contains: 'contains',
  empty: 'is empty',
  'not-empty': 'is not empty',
  'is-me': 'is me',
};
const timeLabels: Partial<Record<QueryOp, string>> = {
  lt: 'is before',
  lte: 'is on or before',
  gt: 'is after',
  gte: 'is on or after',
};
const memberLabels: Partial<Record<QueryOp, string>> = { in: 'includes any of', out: 'includes none of' };
/** The operator wording for one field, such as "is before" for dates and "includes any of" for fields holding several values. */
export function opLabel(field: TableField, op: QueryOp): string {
  if (field.kind === 'date' || field.kind === 'timestamp') return timeLabels[op] ?? opLabels[op];
  const many =
    field.kind === 'multi-select' ||
    ((field.kind === 'relationship' || field.kind === 'file') && field.cardinality === 'many');
  return many ? (memberLabels[op] ?? opLabels[op]) : opLabels[op];
}
export function describeWhere(
  definition: Pick<TableDefinition, 'fields'>,
  where: QueryNode | null,
  references: Record<string, string> = {},
): string {
  if (!where) return 'All rows';
  const visit = (node: QueryNode, nested: boolean): string => {
    if (node.kind !== 'rule') {
      const text = node.nodes.map(child => visit(child, true)).join(node.kind === 'all' ? ' and ' : ' or ');
      return nested ? `(${text})` : text;
    }
    const field = definition.fields.find(item => item.id === node.fieldId);
    if (!field) return 'Unknown field';
    const values = node.values.map(value => labelFor(field, value)?.label ?? references[value] ?? value);
    return `${field.label} ${opLabel(field, node.op)}${values.length ? ` ${values.join(', ')}` : ''}`;
  };
  return visit(where, false);
}

/** Normalizes either request form against one table definition. Returns the canonical query and its RSQL text. */
export function normalizeQueryRequest(
  definition: Pick<TableDefinition, 'fields'>,
  input: unknown,
  references: ReferenceNames = {},
): { query: TableQuery; rsql: string } {
  const request = tableQueryRequestSchema.parse(input);
  const where =
    'rsql' in request
      ? parseRsql(definition, request.rsql, references)
      : validateWhere(definition, request.query.where, references);
  const base = 'rsql' in request ? request.options : request.query;
  const query = tableQuerySchema.parse({ ...base, where });
  validateOptions(definition, query);
  return { query, rsql: printRsql(definition, where) };
}

function validateOptions(definition: Pick<TableDefinition, 'fields'>, query: TableQuery) {
  const issues: QueryIssue[] = [];
  const field = (id: string) => definition.fields.find(item => item.id === id);
  const unique = (ids: string[], what: string) => {
    if (new Set(ids).size !== ids.length)
      issues.push({ code: 'invalid-option', message: `${what} lists a field twice.` });
  };
  if (query.mode === 'rows') {
    for (const id of query.select ?? [])
      if (!field(id)) issues.push({ code: 'unknown-field', message: 'A selected column is not in this table.' });
    for (const sort of query.sort) {
      const target = field(sort.fieldId);
      if (!target) issues.push({ code: 'unknown-field', message: 'A sort field is not in this table.' });
      else if (!scalarQueryKinds.includes(target.kind))
        issues.push({ code: 'invalid-option', message: `${target.label} cannot be sorted.` });
    }
    unique(
      query.sort.map(sort => sort.fieldId),
      'Sort',
    );
    if (query.select) unique(query.select, 'Columns');
  } else {
    for (const id of query.groupBy) {
      const target = field(id);
      if (!target) issues.push({ code: 'unknown-field', message: 'A group field is not in this table.' });
      else if (!scalarQueryKinds.includes(target.kind))
        issues.push({ code: 'invalid-option', message: `${target.label} cannot be grouped.` });
    }
    unique(query.groupBy, 'Group by');
    for (const metric of query.metrics) {
      if (metric.fn === 'count') {
        if (metric.fieldId) issues.push({ code: 'invalid-option', message: 'Count counts rows and takes no field.' });
        continue;
      }
      const target = metric.fieldId ? field(metric.fieldId) : undefined;
      if (!target) issues.push({ code: 'unknown-field', message: `${metric.fn} needs a field from this table.` });
      else if (!metricKinds[metric.fn].includes(target.kind))
        issues.push({ code: 'invalid-option', message: `${metric.fn} is not available for ${target.label}.` });
    }
    if (query.order) {
      const size = query.order.kind === 'group' ? query.groupBy.length : query.metrics.length;
      if (query.order.index >= size)
        issues.push({ code: 'invalid-option', message: 'The summary order refers to a missing group or calculation.' });
    }
  }
  if (issues.length) throw new TableQueryError(issues);
}

/** Converts the legacy flat AND filter list into a v2 tree with the same meaning. */
export function legacyWhere(
  filters: readonly { fieldId: string; op: string; value?: string | boolean | null }[],
): QueryNode | null {
  const map: Record<string, QueryOp> = {
    eq: 'eq',
    ne: 'ne',
    lt: 'lt',
    lte: 'lte',
    gt: 'gt',
    gte: 'gte',
    'is-null': 'empty',
    'not-null': 'not-empty',
  };
  const nodes = filters.map((filter): QueryRule => ({
    kind: 'rule',
    fieldId: queryFieldIdSchema.parse(filter.fieldId),
    op: map[filter.op] ?? 'eq',
    values: filter.value === undefined || filter.value === null ? [] : [String(filter.value)],
  }));
  return nodes.length ? { kind: 'all', nodes } : null;
}

/** Collects relationship IDs in a tree so names can be resolved for display. */
export function referencedRecordIds(
  definition: Pick<TableDefinition, 'fields'>,
  where: QueryNode | null,
): { fieldId: string; recordId: string }[] {
  if (!where) return [];
  if (where.kind !== 'rule') return where.nodes.flatMap(node => referencedRecordIds(definition, node));
  return definition.fields.find(field => field.id === where.fieldId)?.kind === 'relationship'
    ? where.values.map(recordId => ({ fieldId: where.fieldId, recordId }))
    : [];
}

const labelKinds: readonly TableField['kind'][] = [
  'text',
  'numeric',
  'date',
  'timestamp',
  'boolean',
  'single-select',
  'multi-select',
];
/** Ordinary tables have no display field, so use their first two set non-reference values. */
export function recordLabel(
  definition: Pick<TableDefinition, 'fields'>,
  values: Record<string, TableValue | undefined>,
  systemKind?: 'workspace-members',
): string {
  if (systemKind === 'workspace-members') return workspaceMemberLabel(values);
  const format = (field: TableField, value: NonNullable<TableValue>) => {
    switch (value.kind) {
      case 'text':
      case 'numeric':
      case 'date':
      case 'timestamp':
        return value.value;
      case 'boolean':
        return value.value ? 'Yes' : 'No';
      case 'single-select':
        return labelFor(field, value.optionId)?.label ?? value.optionId;
      case 'multi-select':
        return value.optionIds.map(option => labelFor(field, option)?.label ?? option).join(', ');
      default:
        return '';
    }
  };
  return (
    definition.fields
      .filter(field => labelKinds.includes(field.kind) && values[field.id] != null)
      .slice(0, 2)
      .map(field => format(field, values[field.id]!))
      .join(' · ') || 'Untitled row'
  );
}
/** The field whose exact value names a linked row during reference resolution: the first text field. */
export const nameField = (definition: Pick<TableDefinition, 'fields'>) =>
  definition.fields.find(field => field.kind === 'text');

const choiceSchema = z.object({ id: z.uuid(), label: z.string() });
export const queryIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  selector: z.string().optional(),
  value: z.string().optional(),
  position: z.number().optional(),
  fieldId: z.uuid().optional(),
  choices: z.array(choiceSchema).optional(),
});
export const queryErrorSchema = z.object({ error: z.literal('invalid-query'), issues: z.array(queryIssueSchema) });
export const queryCapabilitiesSchema = z.object({
  tableId: z.uuid(),
  revision: z.string(),
  fields: z.array(
    z.object({
      fieldId: z.uuid(),
      selector: z.string(),
      alias: z.string().nullable(),
      label: z.string(),
      kind: z.string(),
      ops: z.array(z.enum(queryOps)),
      sortable: z.boolean(),
      groupable: z.boolean(),
      metrics: z.array(z.enum(metricFunctions)),
      options: z.array(z.object({ id: z.uuid(), label: z.string(), retired: z.boolean() })).optional(),
      targetTableId: z.uuid().optional(),
      cardinality: z.enum(['one', 'many']).optional(),
    }),
  ),
  limits: z.record(z.string(), z.number()),
  rsqlOperators: z.record(z.string(), z.string()),
});
export const queryValidationSchema = z.object({
  query: tableQuerySchema,
  rsql: z.string(),
  references: z.record(z.uuid(), z.string()),
});
const queryRecordSchema = z.object({
  id: z.uuid(),
  token: z.uuid(),
  values: valuesSchema,
  unavailableFileIds: z.array(z.uuid()).optional(),
});
export const queryResultSchema = z.discriminatedUnion('mode', [
  queryValidationSchema.extend({
    mode: z.literal('rows'),
    records: z.array(queryRecordSchema),
    total: z.string().nullable(),
    nextCursor: z.string().nullable(),
  }),
  queryValidationSchema.extend({
    mode: z.literal('summary'),
    groups: z.array(z.object({ keys: z.array(z.string().nullable()), values: z.array(z.string().nullable()) })),
    groupCount: z.string().nullable(),
    nextCursor: z.string().nullable(),
  }),
]);
export type TableQueryResult = z.infer<typeof queryResultSchema>;
export const referenceChoicesSchema = z.object({ choices: z.array(choiceSchema) });
