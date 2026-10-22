import assert from 'node:assert/strict';
import test from 'node:test';
import { rowViewForReceipt } from '../dist/row-view.js';
import { toolReceiptSchema } from '../dist/contracts.js';

const id = '11111111-1111-4111-8111-111111111111';
const tableId = '22222222-2222-4222-8222-222222222222';
const revision = 'a'.repeat(40);
const query = { version: 2, mode: 'rows', where: null, sort: [], limit: 9 };
const receipt = {
  id,
  tool: 'rows.list',
  status: 'completed',
  call: { tool: 'rows.list', tableId, expectedAppliedRevision: revision, query },
  output: {
    result: {
      version: 2,
      mode: 'rows',
      rsql: '',
      query,
      records: [{ private: 'Never publish this snapshot' }],
      nextCursor: null,
    },
    sources: [],
  },
};

test('durable row receipts project only validated identity and normalized query through history', () => {
  const rowView = rowViewForReceipt(receipt);
  const { where: _where, ...options } = query;
  assert.deepEqual(rowView, { callId: id, tableId, revision, query: { rsql: '', options } });
  const parsed = toolReceiptSchema.parse({ ...receipt, rowView });
  assert.deepEqual(parsed.rowView, rowView);
  assert.equal('call' in parsed, false);
  assert.equal('output' in parsed, false);
  assert.equal(JSON.stringify(parsed).includes('snapshot'), false);
});

test('projection preserves normalized filters, selected columns, sorting and the requested page', () => {
  const fieldId = '33333333-3333-4333-8333-333333333333';
  const normalized = {
    ...query,
    where: { kind: 'rule', fieldId, op: 'eq', values: ['Medium'] },
    search: 'ticket',
    sort: [{ fieldId, direction: 'desc' }],
    select: [fieldId],
  };
  const rsql = 'priority==Medium';
  const rowView = rowViewForReceipt({
    ...receipt,
    call: { ...receipt.call, query: { ...query, after: 'cursor' } },
    output: { result: { ...receipt.output.result, rsql, query: normalized }, sources: [] },
  });
  const { where: _where, ...options } = normalized;
  assert.deepEqual(rowView.query, { rsql, options: { ...options, after: 'cursor' } });
});

test('non-row, incomplete, invalid and failed receipts remain unchanged', () => {
  for (const change of [
    { tool: 'rows.get' },
    { status: 'running' },
    { status: 'failed' },
    { output: { error: 'denied' } },
    { call: {} },
    { output: { result: { ...receipt.output.result, query: { ...query, mode: 'summary' } } } },
  ]) {
    assert.equal(rowViewForReceipt({ ...receipt, ...change }), undefined);
  }
});

test('compact pages and single-row reads project identities without stored values', () => {
  const rowId = '44444444-4444-4444-8444-444444444444';
  const record = { id: rowId, values: { private: 'snapshot' } };
  const page = {
    id,
    tool: 'rows.page',
    status: 'completed',
    call: { tool: 'rows.page', tableId, revision, after: rowId, limit: 9 },
    output: { result: [record], sources: [] },
  };
  const view = rowViewForReceipt(page);
  assert.deepEqual(view.recordIds, [rowId]);
  assert.equal(view.revision, revision);
  assert.equal(JSON.stringify(view).includes('snapshot'), false);
  assert.deepEqual(rowViewForReceipt({ ...page, output: { result: [] } }).recordIds, []);
  const get = {
    id,
    tool: 'rows.get',
    status: 'completed',
    call: { tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: rowId },
    output: { result: record },
  };
  assert.deepEqual(rowViewForReceipt(get).recordIds, [rowId]);
  assert.deepEqual(rowViewForReceipt({ ...get, output: { result: null } }).recordIds, [rowId]);
  for (const invalid of [
    { ...page, status: 'running' },
    { ...page, status: 'blocked' },
    { ...page, output: { result: [{ id: 'bad' }] } },
    { ...get, output: { result: { id: tableId } } },
    { ...get, call: { ...get.call, tool: 'rows.page' } },
  ])
    assert.equal(rowViewForReceipt(invalid), undefined);
});

test('completed writes project only the table, revision and written row IDs', async () => {
  const { rowChangeForReceipt } = await import('../dist/row-view.js');
  const recordId = '44444444-4444-4444-8444-444444444444',
    other = '55555555-5555-4555-8555-555555555555';
  const write = { tableId, expectedAppliedRevision: revision, values: {} };
  const created = rowChangeForReceipt({
    id,
    tool: 'rows.create',
    status: 'completed',
    call: { tool: 'rows.create', ...write },
    output: { result: { id: recordId, values: { private: 'value' } }, sources: [] },
  });
  assert.deepEqual(created, { callId: id, tableId, revision, kind: 'created', recordIds: [recordId] });
  const batch = rowChangeForReceipt({
    id,
    tool: 'rows.create.batch',
    status: 'completed',
    call: { tool: 'rows.create.batch', tableId, expectedAppliedRevision: revision, rows: [] },
    output: { result: { records: [{ id: recordId }, { id: other }], total: '2', nextCursor: null }, sources: [] },
  });
  assert.deepEqual(batch.recordIds, [recordId, other]);
  const updated = rowChangeForReceipt({
    id,
    tool: 'rows.update',
    status: 'completed',
    call: { tool: 'rows.update', ...write, recordId },
    output: { result: { id: recordId }, sources: [] },
  });
  assert.equal(updated.kind, 'updated');
  const parsed = toolReceiptSchema.parse({ id, tool: 'rows.create', status: 'completed', rowChange: created });
  assert.equal(JSON.stringify(parsed).includes('private'), false);
  for (const row of [
    {
      id,
      tool: 'rows.create',
      status: 'failed',
      call: { tool: 'rows.create', ...write },
      output: { result: { id: recordId } },
    },
    {
      id,
      tool: 'rows.delete',
      status: 'completed',
      call: { tool: 'rows.delete', ...write, recordId },
      output: { result: true },
    },
    {
      id,
      tool: 'rows.update',
      status: 'completed',
      call: { tool: 'rows.create', ...write },
      output: { result: { id: recordId } },
    },
    {
      id,
      tool: 'rows.create',
      status: 'completed',
      call: { tool: 'rows.create', ...write },
      output: { error: 'denied' },
    },
  ])
    assert.equal(rowChangeForReceipt(row), undefined);
});
