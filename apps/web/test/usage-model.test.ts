import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageSearchSchema } from '../src/features/usage/search.ts';
import {
  earliestDay,
  encodeFilters,
  pivot,
  readExplorerState,
  reportQuery,
  searchRows,
  sortRows,
  totalOf,
  usageCsv,
} from '../src/features/usage/usage-model.ts';

const measures = (requests, totalTokens = requests * 10) => ({
  requests,
  inputTokens: totalTokens - requests,
  outputTokens: requests,
  totalTokens,
  credits: requests * 2,
  billedUsd: 0,
  planValueUsd: 0,
  fallbacks: 0,
});
const names = { 'gpt-sol': 'GPT-6 Sol', 'grok-4-6': 'Grok 4.6', credits: 'TulipFarm credits', plan: 'Member plan' };
const name = (_dimension, value) => names[value] ?? value;
const state = search => readExplorerState(usageSearchSchema.parse(search));

test('a shared link reopens the same breakdown, and anything malformed falls back to the view’s defaults', () => {
  const filters = { model: ['gpt-sol'], paidBy: ['plan', 'key'], member: [] };
  const view = state({
    view: 'custom',
    group: 'member,model,model,activity',
    cols: 'requests,nonsense,credits',
    sort: 'label:asc',
    filter: encodeFilters(filters),
    range: 'custom',
    from: '2000-01-01',
    to: '2999-01-01',
  });
  assert.equal(view.preset, 'custom');
  assert.deepEqual(view.groups, ['member', 'model'], 'at most two distinct levels');
  assert.deepEqual(view.cols, ['requests', 'credits']);
  assert.deepEqual(view.sorting, [{ id: 'label', desc: false }]);
  assert.deepEqual(view.filters, { model: ['gpt-sol'], paidBy: ['plan', 'key'] }, 'empty filters are dropped');
  assert.equal(view.from, earliestDay(), 'custom ranges stop a year back');
  assert.equal(view.to, state({}).to, 'and end today');

  const fallback = state({
    view: 'people',
    group: 'cost',
    sort: 'drop table:x',
    filter: '{"model":',
    range: '45',
    from: 'yesterday',
  });
  assert.deepEqual(fallback.groups, ['usedBy', 'model']);
  assert.deepEqual(fallback.filters, {});
  assert.equal(fallback.range, '30');
  assert.equal(fallback.sorting[0].id, fallback.chartMeasure);

  const query = reportQuery(state({ range: '7', filter: encodeFilters({ fallback: ['quota|x'] }) }));
  assert.equal((Date.parse(query.to) - Date.parse(query.from)) / 86_400_000, 7, 'seven whole local days');
  assert.deepEqual(query.filters, { fallback: ['quota|x'] });
});

test('report rows nest under their first group, sort, search and total', () => {
  const report = {
    rows: [
      { keys: ['gpt-sol', 'credits'], ...measures(2) },
      { keys: ['grok-4-6', 'credits'], ...measures(4) },
      { keys: ['gpt-sol', 'plan'], ...measures(3) },
    ],
  };
  const rows = pivot(report, ['model', 'paidBy'], name);
  assert.deepEqual(
    rows.map(row => [row.label, row.requests, row.subRows.map(sub => `${sub.label}:${sub.requests}`)]),
    [
      ['GPT-6 Sol', 5, ['TulipFarm credits:2', 'Member plan:3']],
      ['Grok 4.6', 4, ['TulipFarm credits:4']],
    ],
  );
  assert.deepEqual(
    sortRows(rows, [{ id: 'requests', desc: true }]).map(row => row.label),
    ['GPT-6 Sol', 'Grok 4.6'],
  );
  assert.deepEqual(
    sortRows(rows, [{ id: 'label', desc: true }]).map(row => row.label),
    ['Grok 4.6', 'GPT-6 Sol'],
  );
  const found = searchRows(rows, 'member');
  assert.deepEqual(
    found.map(row => [row.label, row.subRows.map(sub => sub.label)]),
    [['GPT-6 Sol', ['Member plan']]],
    'a search keeps a parent for its matching sub-rows',
  );
  assert.equal(totalOf(rows).requests, 9);
  assert.equal(totalOf(rows).credits, 18);
});

test('the CSV export has one column per group level and measure, and never runs a cell as a formula', () => {
  const view = state({ group: 'model,paidBy', cols: 'requests,credits' });
  const rows = pivot(
    {
      rows: [
        { keys: ['=HYPERLINK("x")', 'credits'], ...measures(2) },
        { keys: ['gpt-sol', 'plan'], ...measures(1) },
      ],
    },
    view.groups,
    name,
  );
  const labels = { model: 'Model', paidBy: 'Paid by' };
  assert.deepEqual(usageCsv(rows, view, dimension => labels[dimension]).split('\n'), [
    '"Model","Paid by","Requests","Credits"',
    `"'=HYPERLINK(""x"")","TulipFarm credits","2","4"`,
    '"GPT-6 Sol","Member plan","1","2"',
  ]);
});
