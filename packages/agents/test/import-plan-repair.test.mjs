import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { proposeTableSchema } from '@tulipfarm/tables/proposal-contracts';
import { repairImportPlans } from '../src/import-plan-repair.ts';

const tableId = randomUUID(),
  orderId = randomUUID(),
  customer = randomUUID(),
  amount = randomUUID();
const table = {
  id: tableId,
  revision: 'c'.repeat(40),
  definition: {
    label: 'Orders',
    fields: [
      { id: orderId, label: 'Order ID' },
      { id: customer, label: 'Customer' },
      { id: amount, label: 'Amount' },
    ],
    uniqueKeys: [{ id: randomUUID(), fieldIds: [orderId] }],
  },
};
const reference = { kind: 'file', attachmentId: randomUUID(), contentDigest: 'd'.repeat(64) };
const repair = {
  table: async hint => {
    return hint.id === tableId || hint.name?.toLowerCase() === 'orders' ? table : undefined;
  },
  columns: async () => ['Order ID', 'Customer', 'Amount'],
};

test('a loose import plan is rewritten into a strict plan that maps every file column', async () => {
  const outcome = await repairImportPlans(
    {
      plans: [
        {
          table: { tableId },
          reference,
          match: 'Order ID',
          mapping: { kind: 'byName' },
          label: 'Import orders.csv into Orders',
        },
      ],
    },
    repair,
  );
  assert.equal(outcome.repaired, true);
  assert.deepEqual(proposeTableSchema.parse(outcome.input), {
    label: 'Import orders.csv into Orders',
    plans: [
      {
        kind: 'import',
        tableId,
        dependsOn: [],
        expectedRevision: table.revision,
        reference,
        matchFieldIds: [orderId],
        mappings: [
          { sourceColumn: 'Order ID', fieldId: orderId },
          { sourceColumn: 'Customer', fieldId: customer },
          { sourceColumn: 'Amount', fieldId: amount },
        ],
      },
    ],
  });
});

test('a table named by label and fields named "<tableId>-Label" resolve to their IDs', async () => {
  const outcome = await repairImportPlans(
    {
      plans: [
        {
          kind: 'import',
          tableName: 'orders',
          expectedRevision: 'not-a-revision',
          reference,
          mappings: [
            { sourceColumn: 'Order ID', fieldId: `${tableId}-Order ID` },
            { sourceColumn: 'Customer', fieldId: `${tableId}-customer` },
          ],
        },
      ],
    },
    repair,
  );
  const [plan] = proposeTableSchema.parse(outcome.input).plans;
  assert.equal(plan.expectedRevision, table.revision);
  assert.deepEqual(plan.matchFieldIds, [orderId]);
  assert.deepEqual(plan.mappings, [
    { sourceColumn: 'Order ID', fieldId: orderId },
    { sourceColumn: 'Customer', fieldId: customer },
  ]);
});

test('an import plan without a usable reference returns a template with the real fields and columns', async () => {
  const outcome = await repairImportPlans({ plans: [{ kind: 'import', tableId, mappings: [] }] }, repair);
  assert.equal(proposeTableSchema.safeParse(outcome.input).success, false);
  assert.deepEqual(outcome.template.reference, {
    kind: 'file',
    attachmentId: '<attachmentId>',
    contentDigest: '<contentDigest>',
  });
  assert.equal(outcome.template.tableId, tableId);
  assert.deepEqual(
    outcome.fields.map(field => field.id),
    [orderId, customer, amount],
  );
});

test('a plan for an unknown table and a schema-only payload are left for the strict error', async () => {
  const unknown = { plans: [{ kind: 'import', tableId: randomUUID(), reference }] };
  const outcome = await repairImportPlans(unknown, repair);
  assert.equal(proposeTableSchema.safeParse(outcome.input).success, false);
  assert.equal(outcome.template, undefined);
  const schema = { plans: [{ kind: 'schema', tableId }] };
  assert.deepEqual(await repairImportPlans(schema, repair), { input: schema, repaired: false });
});
