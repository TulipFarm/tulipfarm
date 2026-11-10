import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { proposeTableSchema } from '@tulipfarm/tables/proposal-contracts';
import { deferNewTablePlans, repairImportPlans } from '../src/import-plan-repair.ts';

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

const other = {
  id: randomUUID(),
  revision: 'f'.repeat(40),
  definition: { label: 'Customers', fields: [{ id: randomUUID(), label: 'Customer' }], uniqueKeys: [] },
};

test('an import without a target can infer the one table that holds the file’s columns', async () => {
  const outcome = await repairImportPlans(
    { plans: [{ kind: 'import', reference, mappings: 'by name' }] },
    { ...repair, tables: async () => [other, table] },
  );
  const plan = proposeTableSchema.parse(outcome.input).plans[0];
  assert.equal(plan.tableId, tableId);
  assert.equal(plan.mappings.length, 3);
});

test('an explicit missing destination never falls back to a table with matching columns', async () => {
  const outcome = await repairImportPlans(
    { plans: [{ kind: 'import', tableName: 'Sales', reference, mappings: 'by name' }] },
    { ...repair, tables: async () => [other, table] },
  );
  assert.equal(outcome.missingTable.requested, 'Sales');
  assert.equal(outcome.template, undefined);
  assert.equal(proposeTableSchema.safeParse(outcome.input).success, false);
});

test('an import whose table cannot be found or inferred lists the readable tables instead', async () => {
  const outcome = await repairImportPlans(
    { plans: [{ kind: 'import', tableId: 'Sales', reference }] },
    { ...repair, columns: async () => ['SKU', 'Warehouse'], tables: async () => [other, table] },
  );
  assert.deepEqual(outcome.missingTable, {
    requested: 'Sales',
    tables: [
      { id: other.id, label: 'Customers' },
      { id: tableId, label: 'Orders' },
    ],
  });
});

test('rows and imports for a table the same proposal creates are deferred, by id or by name', () => {
  const created = randomUUID();
  const schema = {
    kind: 'schema',
    tableId: created,
    dependsOn: [],
    expectedRevision: null,
    target: { id: created, label: 'Leads', fields: [] },
  };
  const { input, deferred } = deferNewTablePlans({
    label: 'Leads',
    plans: [
      schema,
      { kind: 'records', tableId: created, changes: [] },
      { kind: 'import', tableName: 'leads table', reference },
      { kind: 'records', tableId, changes: [] },
    ],
  });
  assert.deepEqual(input.plans, [schema, { kind: 'records', tableId, changes: [] }]);
  assert.deepEqual(deferred, [
    { kind: 'records', table: 'Leads' },
    { kind: 'import', table: 'Leads' },
  ]);
});
