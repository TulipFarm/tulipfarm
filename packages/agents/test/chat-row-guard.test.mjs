import assert from 'node:assert/strict';
import { test } from 'node:test';
import { earlierRowWrites, namesTable, waitingCardChange } from '../src/chat-row-guard.ts';

test('a chat names a table by its title, ignoring case, punctuation and a plural s', () => {
  assert.equal(namesTable(['Add these rows to qa-rv3-mig.'], 'qa-rv3-mig'), true);
  assert.equal(namesTable(['add five fake tickets'], 'Tickets'), true);
  assert.equal(namesTable(['Add a customer called Acme'], 'Customers'), true);
  assert.equal(namesTable(['Log it in customer_orders'], 'Customer orders'), true);
});

test('a similar or partial title does not name the table', () => {
  assert.equal(namesTable(['Add these rows to qa-rv3-mig.'], 'qa-schema-mig'), false);
  assert.equal(namesTable(['Add a row to orderbook'], 'Order'), false);
  assert.equal(namesTable([], 'Tickets'), false);
});

test('earlier direct writes in a reply count their rows, and any review keeps the rest in review', () => {
  const written = (tool, result) => ({ tool, call: {}, output: { result }, drafted: false });
  assert.deepEqual(
    earlierRowWrites([
      written('rows.create.batch', { records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
      written('rows.update', { id: 'd' }),
      written('rows.create', { error: 'record-invalid' }),
      { tool: 'rows.create', call: {}, output: null, drafted: false },
    ]),
    { rows: 4, reviewing: false, singleCreate: false, created: [] },
  );
  assert.equal(earlierRowWrites([written('rows.create', { id: 'e' })]).singleCreate, true);
  assert.equal(earlierRowWrites([written('rows.create.batch', { error: 'review-required' })]).reviewing, true);
  assert.equal(earlierRowWrites([{ ...written('rows.create', { draftId: 'x' }), drafted: true }]).reviewing, true);
});

test('earlier direct creates in the same table keep the values they sent, so the card can name them', () => {
  const table = '11111111-1111-4111-8111-111111111111',
    other = '22222222-2222-4222-8222-222222222222',
    field = '33333333-3333-4333-8333-333333333333';
  const value = name => ({ [field]: { kind: 'text', value: name } });
  const write = (tool, tableId, call, result) => ({
    tool,
    call: { tool, tableId, ...call },
    output: { result },
    drafted: false,
  });
  const earlier = earlierRowWrites(
    [
      write(
        'rows.create.batch',
        table,
        { rows: [{ values: value('Pear') }, { values: value('Plum') }] },
        {
          records: [{ id: 'p1' }, { id: 'p2' }],
        },
      ),
      write('rows.create', table, { values: value('Lime') }, { id: 'l1' }),
      write('rows.create', other, { values: value('Elsewhere') }, { id: 'o1' }),
    ],
    table,
  );
  assert.equal(earlier.rows, 4);
  assert.deepEqual(earlier.created, [
    { recordId: 'p1', values: value('Pear') },
    { recordId: 'p2', values: value('Plum') },
    { recordId: 'l1', values: value('Lime') },
  ]);
});

test('a waiting row card is described by the change its saved call holds', () => {
  const field = '00000000-0000-4000-8000-000000000001';
  const row = value => ({ values: { [field]: { kind: 'text', value } } });
  assert.deepEqual(
    waitingCardChange({ tool: 'rows.create.batch', rows: ['Apple 1', 'Banana 2', 'Cherry 3', 'Date 4'].map(row) }),
    {
      tool: 'rows.create.batch',
      rows: 4,
      sample: ['Apple 1', 'Banana 2', 'Cherry 3'],
      summary: 'add 4 rows (Apple 1, Banana 2, Cherry 3, …) to',
    },
  );
  assert.equal(
    waitingCardChange({ tool: 'rows.create', values: row('Lime 10').values }).summary,
    'add 1 row (Lime 10) to',
  );
  assert.equal(
    waitingCardChange({ tool: 'rows.update', values: row('Kiwi 4').values }).summary,
    'change 1 row (Kiwi 4) in',
  );
  assert.equal(waitingCardChange({ tool: 'rows.delete' }).summary, 'delete 1 row from');
  assert.equal(waitingCardChange({ tool: 'rows.create', values: { name: 'not a field id' } }).summary, 'add 1 row to');
});
