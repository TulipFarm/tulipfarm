import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { proposeTableSchema } from '@tulipfarm/tables/proposal-contracts';
import { repairProposalShape } from '../src/proposal-repair.ts';

const tableId = randomUUID(),
  name = randomUUID(),
  stage = randomUUID(),
  open = randomUUID(),
  won = randomUUID(),
  existingId = randomUUID();
const table = {
  id: tableId,
  revision: 'e'.repeat(40),
  definition: {
    label: 'Deals',
    fields: [
      { id: name, label: 'Name', kind: 'text' },
      {
        id: stage,
        label: 'Stage',
        kind: 'single-select',
        options: [
          { id: open, label: 'Open' },
          { id: won, label: 'Won' },
        ],
      },
    ],
  },
};
const find = async hint => (hint.id === tableId || hint.name === 'Deals' ? table : undefined);

test('plan kinds written as other words resolve by their words or shape', async () => {
  for (const [kind, extra, expected] of [
    ['add_rows_to_table', { changes: [] }, 'records'],
    ['bulk-insert', {}, 'records'],
    ['importCsv', {}, 'import'],
    ['unarchive', {}, 'restore'],
    ['delete-table', {}, 'archive'],
    ['delete-rows', {}, 'records'],
    ['mystery', { changes: [] }, 'records'],
    ['mystery', { reference: {} }, 'import'],
    ['define-structure', {}, 'schema'],
  ]) {
    const out = await repairProposalShape({ plans: [{ kind, tableId, ...extra }] }, find);
    assert.equal(out.plans[0].kind, expected, kind);
  }
});

test('record changes in loose shapes become strict creates and updates with typed values', async () => {
  for (const changes of [
    { create: [{ Name: 'Acme', stage: 'won' }], update: [{ id: existingId, values: { Stage: 'Open' } }] },
    JSON.stringify([
      { action: 'insert', fields: { Name: 'Acme', Stage: 'Won' } },
      { kind: 'modify', recordId: existingId, data: { Stage: 'open' } },
    ]),
  ]) {
    const out = await repairProposalShape({ plans: [{ kind: 'records', tableId: 'Deals', changes, note: 'x' }] }, find);
    const parsed = proposeTableSchema.parse(out);
    const [created, updated] = parsed.plans[0].changes;
    assert.equal(parsed.plans[0].tableId, tableId);
    assert.equal(parsed.plans[0].expectedRevision, table.revision);
    assert.equal(created.kind, 'create');
    assert.deepEqual(created.values, {
      [name]: { kind: 'text', value: 'Acme' },
      [stage]: { kind: 'single-select', optionId: won },
    });
    assert.deepEqual(updated, {
      kind: 'update',
      recordId: existingId,
      values: { [stage]: { kind: 'single-select', optionId: open } },
    });
  }
});

test('one change object and rows under another key default to creates', async () => {
  const single = await repairProposalShape({ plans: [{ kind: 'records', tableId, changes: { Name: 'Acme' } }] }, find);
  assert.equal(proposeTableSchema.parse(single).plans[0].changes[0].kind, 'create');
  const rows = await repairProposalShape({ plans: [{ kind: 'rows', table: 'Deals', rows: [{ Name: 'B' }] }] }, find);
  assert.equal(proposeTableSchema.parse(rows).plans[0].changes[0].kind, 'create');
});

test('made-up ids in a new table are replaced with one fresh UUID each, everywhere they are used', async () => {
  const out = await repairProposalShape(
    {
      plans: [
        {
          kind: 'create_table',
          tableId: 'leads',
          expectedRevision: null,
          target: {
            label: 'Leads',
            fields: [
              { id: 'status', label: 'Status', kind: 'single-select', options: [{ id: 'new', label: 'New' }] },
              { id: 'email', label: 'Email', kind: 'text' },
            ],
            uniqueKeys: [{ id: 'by-email', fieldIds: ['email'] }],
          },
        },
      ],
    },
    find,
  );
  const plan = out.plans[0];
  assert.equal(plan.kind, 'schema');
  assert.equal(plan.target.id, plan.tableId);
  assert.equal(plan.target.uniqueKeys[0].fieldIds[0], plan.target.fields[1].id);
  for (const id of [plan.tableId, plan.target.fields[0].id, plan.target.fields[0].options[0].id])
    assert.match(id, /^[0-9a-f-]{36}$/);
});
