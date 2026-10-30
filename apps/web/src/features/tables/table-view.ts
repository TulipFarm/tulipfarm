import {
  kindQueryOps,
  metricFunctions,
  parseRsql,
  printRsql,
  scalarQueryKinds,
  TableQueryError,
  validateWhere,
  type MetricFunction,
  type QueryIssue,
  type QueryMetric,
  type QueryNode,
  type QueryOp,
  type QueryRule,
  type TableQueryRequest,
} from '@tulipfarm/tables/query';
import type { TableDefinition as CoreDefinition } from '@tulipfarm/tables/definition';
import type { TableDefinition } from './api';
import type { legacyOps, TableRowsSearch } from './table-search.ts';
export {
  linkQueryCharacters,
  tableListSearchSchema,
  tableRowsSearchSchema,
  type TableListSearch,
  type TableRowsSearch,
} from './table-search.ts';

/** The table package's view of a definition. It differs from the web schema only by branded IDs. */
export type QueryDefinition = Pick<CoreDefinition, 'fields'>;
export const queryDefinition = (definition: TableDefinition['definition']) => definition as unknown as QueryDefinition;
type Definition = QueryDefinition;
type Field = Definition['fields'][number];

export type ViewSort = { fieldId: string; direction: 'asc' | 'desc' };
/** The applied, shareable query state of a table page. Drafts in the editors are separate. */
export type TableView = {
  where: string;
  search?: string | undefined;
  sort: ViewSort[];
  groupBy: string[];
  metrics: QueryMetric[];
  select?: string[] | undefined;
};

export const sortable = (field: Field) => scalarQueryKinds.includes(field.kind);
export const metricKinds: Record<Exclude<MetricFunction, 'count'>, readonly Field['kind'][]> = {
  sum: ['numeric'],
  avg: ['numeric'],
  min: ['numeric', 'date', 'timestamp'],
  max: ['numeric', 'date', 'timestamp'],
};
export const metricLabels: Record<MetricFunction, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
};
const legacyOp: Record<(typeof legacyOps)[number], QueryOp> = {
  eq: 'eq',
  ne: 'ne',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  'is-null': 'empty',
  'not-null': 'not-empty',
};

function legacyWhere(search: TableRowsSearch, definition: Definition) {
  const field = definition.fields.find(item => item.id === search.field);
  if (!field || !sortable(field)) return '';
  const op = legacyOp[search.op ?? 'eq'];
  if (!kindQueryOps[field.kind].includes(op)) return '';
  const valueless = op === 'empty' || op === 'not-empty';
  if (!valueless && !search.value) return '';
  try {
    return printRsql(
      definition,
      validateWhere(definition, { kind: 'rule', fieldId: field.id, op, values: valueless ? [] : [search.value ?? ''] }),
    );
  } catch {
    return '';
  }
}

/** The applied view for a URL. Old single sort/filter links are migrated; fields this table cannot use are left out. */
export function tableView(search: TableRowsSearch, definition: Definition): TableView {
  const field = (id: string) => definition.fields.find(item => item.id === id);
  const ids = (text: string | undefined) => (text ? text.toLowerCase().split(',') : []);
  const legacy = !search.where && !search.order && !search.group && !search.calc;
  const sort =
    legacy && search.sort
      ? [{ fieldId: search.sort, direction: search.dir ?? 'asc' } as const]
      : ids(search.order).map(item =>
          item.startsWith('-')
            ? { fieldId: item.slice(1), direction: 'desc' as const }
            : { fieldId: item, direction: 'asc' as const },
        );
  const metrics = ids(search.calc)
    .map((item): QueryMetric =>
      item === 'count'
        ? { fn: 'count' }
        : { fn: item.slice(0, item.indexOf('.')) as MetricFunction, fieldId: item.slice(item.indexOf('.') + 1) },
    )
    .filter(
      metric =>
        metric.fn === 'count' ||
        (metric.fieldId &&
          metricKinds[metric.fn as Exclude<MetricFunction, 'count'>].includes(field(metric.fieldId)?.kind ?? 'file')),
    );
  const groupBy = ids(search.group).filter(id => {
    const target = field(id);
    return !!target && sortable(target);
  });
  const select = ids(search.cols).filter(id => field(id));
  const text = search.q?.trim();
  return {
    where: legacy && search.field ? legacyWhere(search, definition) : (search.where ?? ''),
    ...(text && definition.fields.some(item => item.kind === 'text') ? { search: text } : {}),
    sort: sort.filter(item => {
      const target = field(item.fieldId);
      return !!target && sortable(target);
    }),
    groupBy,
    metrics: metrics.length || !groupBy.length ? metrics : [{ fn: 'count' }],
    ...(select.length ? { select } : {}),
  };
}

/** URL changes for a new applied view. Old single sort/filter keys are always cleared once the user changes the view. */
export function viewSearch(view: TableView): Partial<TableRowsSearch> {
  return {
    where: view.where || undefined,
    q: view.search || undefined,
    order: view.sort.length
      ? view.sort.map(item => `${item.direction === 'desc' ? '-' : ''}${item.fieldId}`).join(',')
      : undefined,
    group: view.groupBy.length ? view.groupBy.join(',') : undefined,
    calc: view.metrics.length
      ? view.metrics.map(metric => (metric.fn === 'count' ? 'count' : `${metric.fn}.${metric.fieldId}`)).join(',')
      : undefined,
    cols: view.select?.length ? view.select.join(',') : undefined,
    sort: undefined,
    dir: undefined,
    field: undefined,
    op: undefined,
    value: undefined,
  };
}

export const summarized = (view: TableView) => view.groupBy.length > 0 || view.metrics.length > 0;
export const narrowed = (view: TableView) => !!view.where || !!view.search;

/** The server request for an applied view. Cursors travel unchanged inside the options. */
export function viewRequest(view: TableView, after?: string): TableQueryRequest {
  const common = { version: 2 as const, ...(view.search ? { search: view.search } : {}), ...(after ? { after } : {}) };
  return summarized(view)
    ? {
        rsql: view.where,
        options: {
          ...common,
          mode: 'summary',
          groupBy: view.groupBy,
          metrics: view.metrics.length ? view.metrics : [{ fn: 'count' }],
          limit: 50,
        },
      }
    : {
        rsql: view.where,
        options: {
          ...common,
          mode: 'rows',
          sort: view.sort,
          limit: 50,
          ...(view.select ? { select: view.select } : {}),
        },
      };
}

/** Builder state keeps unfinished conditions so switching modes never drops what a user typed. */
export type DraftRule = { key: string; kind: 'rule'; fieldId: string; op: QueryOp; values: string[] };
export type DraftGroup = { key: string; kind: 'all' | 'any'; nodes: DraftNode[] };
export type DraftNode = DraftRule | DraftGroup;
let keys = 0;
export const draftKey = () => `d${++keys}`;
export const emptyDraft = (): DraftGroup => ({ key: draftKey(), kind: 'all', nodes: [] });
export const valueless = (op: QueryOp) => op === 'empty' || op === 'not-empty' || op === 'is-me';
export const listOp = (op: QueryOp) => op === 'in' || op === 'out';

function toDraftNode(node: QueryNode): DraftNode {
  return node.kind === 'rule'
    ? { ...node, key: draftKey() }
    : { key: draftKey(), kind: node.kind, nodes: node.nodes.map(toDraftNode) };
}
export function toDraft(node: QueryNode | null): DraftGroup {
  if (!node) return emptyDraft();
  const draft = toDraftNode(node);
  return draft.kind === 'all' ? draft : { key: draftKey(), kind: 'all', nodes: [draft] };
}

/** Incomplete conditions become issues keyed by draft node, never silently removed. */
export function fromDraft(
  definition: Definition,
  root: DraftGroup,
): { where: QueryNode | null; problems: Record<string, string> } {
  const problems: Record<string, string> = {};
  const visit = (node: DraftNode): QueryNode | null => {
    if (node.kind !== 'rule') {
      const nodes = node.nodes.map(visit).filter((item): item is QueryNode => item !== null);
      if (!node.nodes.length && node !== root) problems[node.key] = 'Add a condition to this group or remove it.';
      return nodes.length ? { kind: node.kind, nodes } : null;
    }
    const field = definition.fields.find(item => item.id === node.fieldId);
    if (!field) {
      problems[node.key] = 'Choose a field.';
      return null;
    }
    const values = node.values.map(value => value.trim()).filter(Boolean);
    if (!valueless(node.op) && !values.length) {
      problems[node.key] = listOp(node.op) ? 'Choose at least one value.' : 'Enter a value.';
      return null;
    }
    return {
      kind: 'rule',
      fieldId: field.id,
      op: node.op,
      values: valueless(node.op) ? [] : listOp(node.op) ? values : values.slice(0, 1),
    };
  };
  const where = visit(root);
  if (Object.keys(problems).length) return { where: null, problems };
  try {
    return { where: validateWhere(definition, where), problems };
  } catch (error) {
    if (!(error instanceof TableQueryError)) throw error;
    const located = (issue: QueryIssue) => findRule(root, issue.fieldId)?.key ?? root.key;
    for (const issue of error.issues) problems[located(issue)] = issue.message;
    return { where: null, problems };
  }
}
function findRule(node: DraftNode, fieldId: string | undefined): DraftRule | null {
  if (!fieldId) return null;
  if (node.kind === 'rule') return node.fieldId === fieldId ? node : null;
  for (const child of node.nodes) {
    const found = findRule(child, fieldId);
    if (found) return found;
  }
  return null;
}
export const draftRules = (node: DraftNode): number =>
  node.kind === 'rule' ? 1 : node.nodes.reduce((total, child) => total + draftRules(child), 0);

/** Parses RSQL locally for switching to Filters. Linked-row names need the server, so they are reported instead of guessed. */
export function rsqlToDraft(definition: Definition, text: string): { draft: DraftGroup } | { issues: QueryIssue[] } {
  try {
    return { draft: toDraft(parseRsql(definition, text)) };
  } catch (error) {
    if (error instanceof TableQueryError) return { issues: error.issues };
    throw error;
  }
}
export function draftToRsql(
  definition: Definition,
  draft: DraftGroup,
): { rsql: string } | { problems: Record<string, string> } {
  const { where, problems } = fromDraft(definition, draft);
  return Object.keys(problems).length ? { problems } : { rsql: printRsql(definition, where) };
}
export { metricFunctions };

/** Options have no stored color yet, so common workflow words choose a badge tone and other labels stay neutral. */
export type OptionTone = 'info' | 'warning' | 'success' | 'destructive' | 'outline' | 'ghost' | 'secondary';
const optionTones: [RegExp, OptionTone][] = [
  [/\b(urgent|critical|high|blocked|failed|overdue|rejected|cancell?ed)\b/, 'destructive'],
  [/\b(resolved|solved|done|closed|complete|completed|approved|paid|won)\b/, 'success'],
  [/\b(in progress|pending|waiting|in review|normal|medium)\b/, 'warning'],
  [/\b(open|new|to ?do|triage|low)\b/, 'info'],
];
export const optionTone = (label: string): OptionTone => {
  const words = label
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return optionTones.find(([pattern]) => pattern.test(words))?.[1] ?? 'secondary';
};

export const layoutIds = ['table', 'board', 'list', 'chart', 'timeline'] as const;
export type Layout = (typeof layoutIds)[number];
export type SearchMode = 'text' | 'ai' | 'rsql';
const layoutKey = (tableId: string) => `tulipfarm.tables.layout.${tableId}`;
/** A link's layout wins; otherwise the last layout chosen for this table on this browser. */
export function storedLayout(tableId: string): Layout | undefined {
  try {
    const value = window.localStorage.getItem(layoutKey(tableId));
    return layoutIds.find(id => id === value);
  } catch {
    return undefined;
  }
}
export function storeLayout(tableId: string, layout: Layout) {
  try {
    window.localStorage.setItem(layoutKey(tableId), layout);
  } catch {
    /* Storage can be disabled by the browser. */
  }
}

const openKey = (tableId: string) => `tulipfarm.tables.views.${tableId}`;
export const defaultOpenLayouts: Layout[] = ['table', 'list', 'board'];
export const openLayoutLimit = 3;
/** Puts the current view first and keeps the most recent views up to the limit. */
export const recentLayouts = (current: Layout, open: Layout[]): Layout[] =>
  [current, ...open.filter(id => id !== current)].slice(0, openLayoutLimit);
/** The views open as tabs for this table on this browser, most recently used first. */
export function storedOpenLayouts(tableId: string): Layout[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(openKey(tableId)) ?? 'null');
    if (!Array.isArray(value)) return defaultOpenLayouts;
    const open = value.filter((id, index): id is Layout => layoutIds.includes(id) && value.indexOf(id) === index);
    return open.length ? open.slice(0, openLayoutLimit) : defaultOpenLayouts;
  } catch {
    return defaultOpenLayouts;
  }
}
export function storeOpenLayouts(tableId: string, open: Layout[]) {
  try {
    window.localStorage.setItem(openKey(tableId), JSON.stringify(open));
  } catch {
    /* Storage can be disabled by the browser. */
  }
}

const topNodes = (node: QueryNode | null) => (!node ? [] : node.kind === 'all' ? node.nodes : [node]);
const countNodes = (node: QueryNode): number =>
  node.kind === 'rule' ? 1 : node.nodes.reduce((total, child) => total + countNodes(child), 0);
/** Top-level AND conditions become chips. OR and nested groups are only edited in Advanced, so they show as one summary chip. */
export type FilterChips = { kind: 'chips'; rules: QueryRule[] } | { kind: 'advanced'; conditions: number };
export function filterChips(definition: Definition, where: string): FilterChips {
  let node: QueryNode | null;
  try {
    node = parseRsql(definition, where);
  } catch (error) {
    if (error instanceof TableQueryError) return { kind: 'advanced', conditions: 1 };
    throw error;
  }
  const nodes = topNodes(node);
  return nodes.every(item => item.kind === 'rule')
    ? { kind: 'chips', rules: nodes as QueryRule[] }
    : { kind: 'advanced', conditions: node ? countNodes(node) : 0 };
}
export function rulesWhere(definition: Definition, rules: QueryRule[]): string {
  return printRsql(
    definition,
    rules.length ? validateWhere(definition, rules.length === 1 ? rules[0]! : { kind: 'all', nodes: rules }) : null,
  );
}

/** Boards group by one single-select field. Each column is the applied search plus that column's option. */
export const boardFields = (definition: Definition) =>
  definition.fields.filter(field => field.kind === 'single-select');
export const boardField = (definition: Definition, id: string | undefined) => {
  const fields = boardFields(definition);
  return fields.find(field => field.id === id) ?? fields[0];
};
/** Timelines place rows on a date or timestamp field. */
export const timelineFields = (definition: Definition) =>
  definition.fields.filter(field => field.kind === 'date' || field.kind === 'timestamp');

export function columnWhere(definition: Definition, where: string, fieldId: string, optionId: string | null): string {
  const rule = printRsql(definition, {
    kind: 'rule',
    fieldId,
    op: optionId ? 'eq' : 'empty',
    values: optionId ? [optionId] : [],
  });
  return where ? `(${where}) and ${rule}` : rule;
}
const optionRule = (fieldId: string, optionId: string | null): QueryRule => ({
  kind: 'rule',
  fieldId,
  op: optionId ? 'eq' : 'empty',
  values: optionId ? [optionId] : [],
});
const sameRule = (a: QueryRule, b: QueryRule) =>
  a.fieldId === b.fieldId && a.op === b.op && a.values.join() === b.values.join();
/** Whether the applied filter has this option of a choice field as one of its chips. */
export function optionFiltered(definition: Definition, where: string, fieldId: string, optionId: string | null) {
  const chips = filterChips(definition, where);
  const rule = optionRule(fieldId, optionId);
  return chips.kind === 'chips' && chips.rules.some(item => sameRule(item, rule));
}
/** Adds a chip for one option of a choice field, replacing the field's other option chip, or removes it when already applied. */
export function toggleOptionWhere(definition: Definition, where: string, fieldId: string, optionId: string | null) {
  const chips = filterChips(definition, where);
  if (chips.kind === 'advanced') return columnWhere(definition, where, fieldId, optionId);
  const rule = optionRule(fieldId, optionId);
  if (chips.rules.some(item => sameRule(item, rule)))
    return rulesWhere(
      definition,
      chips.rules.filter(item => !sameRule(item, rule)),
    );
  const others = chips.rules.filter(item => !(item.fieldId === fieldId && (item.op === 'eq' || item.op === 'empty')));
  return rulesWhere(definition, [...others, rule]);
}
export const boardCountRequest = (view: TableView, fieldId: string): TableQueryRequest => ({
  rsql: view.where,
  options: {
    version: 2,
    ...(view.search ? { search: view.search } : {}),
    mode: 'summary',
    groupBy: [fieldId],
    metrics: [{ fn: 'count' }],
    limit: 100,
  },
});
export const boardColumnRequest = (
  definition: Definition,
  view: TableView,
  fieldId: string,
  optionId: string | null,
): TableQueryRequest => ({
  rsql: columnWhere(definition, view.where, fieldId, optionId),
  options: { version: 2, ...(view.search ? { search: view.search } : {}), mode: 'rows', sort: view.sort, limit: 20 },
});

/** RFC 4180 quoting. Leading formula characters, other than in plain numbers, are prefixed so spreadsheets show the text instead of running it. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
export const csvLine = (values: string[]) => values.map(csvCell).join(',');
