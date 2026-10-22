import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  draftToRsql,
  emptyDraft,
  fromDraft,
  linkQueryCharacters,
  boardColumnRequest,
  boardCountRequest,
  boardField,
  csvLine,
  filterChips,
  optionTone,
  rsqlToDraft,
  rulesWhere,
  tableRowsSearchSchema,
  tableView,
  viewRequest,
  viewSearch,
  type QueryDefinition,
} from '../src/features/tables/table-view.ts';
import {
  tableRowsSearchSchema as routeSearchSchema,
  tableListSearchSchema,
} from '../src/features/tables/table-search.ts';
import { queryLimits } from '@tulipfarm/tables/query-limits';
import { queryLimits as engineLimits } from '@tulipfarm/tables/query';
import { definitionSchema } from '@tulipfarm/tables/definition';

const title = '11111111-1111-4111-8111-111111111111';
const status = '22222222-2222-4222-8222-222222222222';
const points = '33333333-3333-4333-8333-333333333333';
const files = '44444444-4444-4444-8444-444444444444';
const open = '55555555-5555-4555-8555-555555555555';
const done = '66666666-6666-4666-8666-666666666666';
const definition = {
  fields: [
    { id: title, label: 'Title', required: true, kind: 'text', maxLength: 200 },
    {
      id: status,
      label: 'Status',
      required: false,
      kind: 'single-select',
      options: [
        { id: open, label: 'Open', retired: false },
        { id: done, label: 'Done', retired: false },
      ],
    },
    { id: points, label: 'Points', required: false, kind: 'numeric', precision: 6, scale: 0 },
    { id: files, label: 'Files', required: false, kind: 'file' },
  ],
} as unknown as QueryDefinition;
const parse = (search: Record<string, unknown>) => tableRowsSearchSchema.parse(search);

test('lightweight route schemas retain the same view schema and query-engine limits', () => {
  assert.equal(routeSearchSchema, tableRowsSearchSchema);
  assert.equal(queryLimits, engineLimits);
  assert.deepEqual(tableListSearchSchema.parse({ q: false, extra: 'ignored' }), { q: 'false' });
  assert.equal(parse({ value: 5 }).value, '5');
  assert.equal(parse({ where: 'x'.repeat(linkQueryCharacters) }).where?.length, linkQueryCharacters);
  assert.equal(parse({ where: 'x'.repeat(linkQueryCharacters + 1) }).where, undefined);
  for (const [key, item, max] of [
    ['order', title, queryLimits.sortKeys],
    ['group', title, queryLimits.groupBy],
    ['calc', 'count', queryLimits.metrics],
    ['cols', title, 64],
  ] as const) {
    const valid = Array(max).fill(item).join(',');
    assert.equal(parse({ [key]: valid })[key], valid);
    assert.equal(parse({ [key]: `${valid},${item}` })[key], undefined);
  }
});

test('old single sort and filter links become a typed view', () => {
  const view = tableView(
    parse({ sort: points, dir: 'desc', field: points, op: 'gte', value: 3, q: 'login' }),
    definition,
  );
  assert.deepEqual(view.sort, [{ fieldId: points, direction: 'desc' }]);
  assert.equal(view.where, 'points>=3');
  assert.equal(view.search, 'login');
  const next = viewSearch(view);
  assert.equal(next.field, undefined);
  assert.equal(next.sort, undefined);
  assert.equal(next.order, `-${points}`);
  assert.equal(next.where, 'points>=3');
});

test('old valueless and boolean-like filters keep their meaning, and unusable ones are dropped', () => {
  assert.equal(
    tableView(parse({ field: title, op: 'is-null', value: 'ignored' }), definition).where,
    'title=isnull=true',
  );
  assert.equal(tableView(parse({ field: points, op: 'lt' }), definition).where, '', 'An unfinished filter is left out');
  assert.equal(
    tableView(parse({ field: files, op: 'not-null' }), definition).where,
    '',
    'Files were never filterable by old links',
  );
  assert.equal(
    tableView(parse({ q: 'acme' }), { fields: [definition.fields[2]!] } as QueryDefinition).search,
    undefined,
    'A table without text fields has no search',
  );
});

test('URL views drop fields the table cannot use instead of failing', () => {
  const view = tableView(
    parse({
      order: `${files},-${points}`,
      group: `${status},${files}`,
      calc: `sum.${points},avg.${title}`,
      cols: `${title},${files}`,
    }),
    definition,
  );
  assert.deepEqual(view.sort, [{ fieldId: points, direction: 'desc' }]);
  assert.deepEqual(view.groupBy, [status]);
  assert.deepEqual(view.metrics, [{ fn: 'sum', fieldId: points }]);
  assert.deepEqual(view.select, [title, files]);
});

test('grouping without calculations counts rows, and summaries ignore columns', () => {
  const view = tableView(parse({ group: status, cols: title }), definition);
  assert.deepEqual(view.metrics, [{ fn: 'count' }]);
  const request = viewRequest(view, 'cursor');
  assert.ok('options' in request && request.options.mode === 'summary');
  assert.equal(request.options.after, 'cursor');
  assert.equal('select' in request.options, false);
});

test('malformed URL values are ignored and long filters are refused rather than truncated', () => {
  const view = tableView(
    parse({ order: 'not-a-field', calc: 'median.x', where: 'x'.repeat(linkQueryCharacters + 1) }),
    definition,
  );
  assert.deepEqual(view.sort, []);
  assert.deepEqual(view.metrics, []);
  assert.equal(view.where, '');
});

test('filter drafts keep unfinished conditions as problems instead of dropping them', () => {
  const draft = emptyDraft();
  draft.nodes.push({ key: 'a', kind: 'rule', fieldId: points, op: 'gt', values: [] });
  draft.nodes.push({ key: 'b', kind: 'any', nodes: [] });
  const result = fromDraft(definition, draft);
  assert.equal(result.where, null);
  assert.deepEqual(Object.keys(result.problems).sort(), ['a', 'b']);
});

test('filters and RSQL round-trip with nested any groups', () => {
  const parsed = rsqlToDraft(definition, 'status==Open;(points>5,title=contains=login)');
  assert.ok('draft' in parsed);
  const printed = draftToRsql(definition, parsed.draft);
  assert.ok('rsql' in printed);
  assert.equal(printed.rsql, 'status==Open and (points>5 or title=contains=login)');
  assert.ok('issues' in rsqlToDraft(definition, 'priority==High'));
});

test('personal filter drafts and shared URLs retain a valueless is me condition', () => {
  const members = definitionSchema.parse({
    formatVersion: 2,
    id: title,
    label: 'Tickets',
    owningTeamId: status,
    uniqueKeys: [],
    fields: [
      {
        id: points,
        label: 'Assignee',
        kind: 'relationship',
        required: false,
        targetTableId: files,
        cardinality: 'one',
        inverseCardinality: 'many',
        reverse: null,
        onDelete: 'restrict',
      },
    ],
  });
  const draft = emptyDraft();
  draft.nodes.push({ key: 'me', kind: 'rule', fieldId: points, op: 'is-me', values: [] });
  assert.deepEqual(draftToRsql(members, draft), { rsql: 'assignee=isme=true' });
  const roundTrip = rsqlToDraft(members, 'assignee=isme=true');
  assert.ok('draft' in roundTrip);
  assert.deepEqual(draftToRsql(members, roundTrip.draft), { rsql: 'assignee=isme=true' });
  const view = tableView(parse({ where: 'assignee=isme=true' }), members);
  assert.equal(viewSearch(view).where, 'assignee=isme=true');
  assert.deepEqual(viewRequest(view), {
    rsql: 'assignee=isme=true',
    options: { version: 2, mode: 'rows', sort: [], limit: 50 },
  });
});

test('option badges pick a tone from common workflow words', () => {
  assert.equal(optionTone('Open'), 'info');
  assert.equal(optionTone('In progress'), 'warning');
  assert.equal(optionTone('Resolved'), 'success');
  assert.equal(optionTone('Urgent'), 'destructive');
  assert.equal(optionTone('Low'), 'info');
  assert.equal(optionTone('Medium'), 'warning');
  assert.equal(optionTone('Normal'), 'warning');
  assert.equal(optionTone('High Priority'), 'destructive');
  for (const label of ['Medium Priority', 'MEDIUM_PRIORITY', 'mediumPriority', 'medium-priority'])
    assert.equal(optionTone(label), 'warning');
  for (const label of ['Low Priority', 'LOW_PRIORITY', 'lowPriority', 'low-priority'])
    assert.equal(optionTone(label), 'info');
  assert.equal(optionTone('Lowland'), 'secondary');
  assert.equal(optionTone('On hold'), 'secondary');
});

test('layout, board field, and search mode survive in links; bad values are dropped', () => {
  assert.deepEqual(parse({ view: 'board', board: status, find: 'rsql' }), {
    view: 'board',
    board: status,
    find: 'rsql',
  });
  const bad = parse({ view: 'grid', board: 'nope', find: 'sql' });
  assert.deepEqual([bad.view, bad.board, bad.find], [undefined, undefined, undefined]);
  assert.equal(viewSearch(tableView(parse({ where: 'points>3' }), definition)).view, undefined);
  assert.ok(!('view' in viewSearch(tableView(parse({}), definition))));
});

test('top-level AND rules become chips; OR and nested groups open Advanced', () => {
  const chips = filterChips(definition, 'points>=3;status==Open');
  assert.equal(chips.kind, 'chips');
  if (chips.kind !== 'chips') return;
  assert.equal(chips.rules.length, 2);
  assert.equal(rulesWhere(definition, chips.rules.slice(1)), 'status==Open');
  assert.equal(rulesWhere(definition, []), '');
  assert.deepEqual(filterChips(definition, ''), { kind: 'chips', rules: [] });
  assert.deepEqual(filterChips(definition, 'status==Open,points>3'), { kind: 'advanced', conditions: 2 });
  assert.deepEqual(filterChips(definition, 'points>3;(status==Open,status==Done)'), {
    kind: 'advanced',
    conditions: 3,
  });
});

test('board columns add their option to the applied search', () => {
  const view = tableView(parse({ where: 'points>=3 or points<1', q: 'login', order: `-${points}` }), definition);
  assert.equal(boardField(definition, undefined)?.id, status);
  assert.equal(boardField(definition, points)?.id, status);
  assert.deepEqual(boardColumnRequest(definition, view, status, open), {
    rsql: '(points>=3 or points<1) and status==Open',
    options: { version: 2, search: 'login', mode: 'rows', sort: [{ fieldId: points, direction: 'desc' }], limit: 20 },
  });
  assert.equal(
    boardColumnRequest(definition, view, status, null).rsql,
    '(points>=3 or points<1) and status=isnull=true',
  );
  assert.deepEqual(boardCountRequest(view, status).options, {
    version: 2,
    search: 'login',
    mode: 'summary',
    groupBy: [status],
    metrics: [{ fn: 'count' }],
    limit: 100,
  });
});

test('CSV cells are quoted and formulas are neutralized', () => {
  assert.equal(csvLine(['a', 'b,c', 'say "hi"', 'two\nlines']), 'a,"b,c","say ""hi""","two\nlines"');
  assert.equal(csvLine(['=SUM(A1)', '-5', '-2.5', '+1', '@x']), "'=SUM(A1),-5,-2.5,'+1,'@x");
});
