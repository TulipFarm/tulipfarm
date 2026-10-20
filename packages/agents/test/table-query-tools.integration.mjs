import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createTableWithRows, tableDefinition, textField } from '../../tables/test/fixture.mjs';
import { toolCallSchema, toolResultSchema } from '../src/contracts.ts';
import { createChatTools } from '../src/tools.ts';

const option = label => ({ id: randomUUID(), label, retired: false });

async function ticketTables(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const ws = await db.create(await workspaceTableMigrations()),
    s = `"${ws.names.schema}"`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
    resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
  });
  const team = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);

  const name = textField('Name');
  const customers = tableDefinition({ owningTeamId: team, label: 'Customers', fields: [name] });
  const customerIds = Object.fromEntries(['Acme', 'Globex', 'Initech', 'acme'].map(label => [label, randomUUID()]));
  await createTableWithRows({
    db,
    workspace: ws,
    runtime,
    definition: customers,
    records: Object.entries(customerIds).map(([label, id]) => ({
      id,
      values: { [name.id]: { kind: 'text', value: label } },
    })),
  });

  const subject = textField('Subject');
  const status = {
    id: randomUUID(),
    label: 'Status',
    kind: 'single-select',
    required: false,
    options: ['Open', 'Pending', 'Closed'].map(option),
  };
  const customer = {
    id: randomUUID(),
    label: 'Customer',
    kind: 'relationship',
    required: false,
    targetTableId: customers.id,
    cardinality: 'one',
    inverseCardinality: 'many',
    reverse: null,
    onDelete: 'restrict',
  };
  const tickets = tableDefinition({ owningTeamId: team, label: 'Tickets', fields: [subject, status, customer] });
  const [open, pending, closed] = status.options.map(item => item.id);
  const rows = [
    ['Payment failed', open, 'Globex'],
    ['Login broken', open, 'Acme'],
    ['Refund', closed, 'Globex'],
    ['Invoice missing', pending, 'Initech'],
    ['Slow page', open, 'Globex'],
    ['Dark mode', closed, null],
    ['Coupon', pending, 'acme'],
  ].map(([text, optionId, linked]) => ({
    id: randomUUID(),
    text,
    optionId,
    linked,
    values: {
      [subject.id]: { kind: 'text', value: text },
      [status.id]: { kind: 'single-select', optionId },
      ...(linked
        ? { [customer.id]: { kind: 'relationship', tableId: customers.id, recordIds: [customerIds[linked]] } }
        : {}),
    },
  }));
  const table = await createTableWithRows({
    db,
    workspace: ws,
    runtime,
    definition: tickets,
    records: rows.map(({ id, values }) => ({ id, values })),
  });
  const human = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const chat = createChatTools(runtime);
  const call = async input => {
    const parsed = toolCallSchema.parse({
      tableId: tickets.id,
      ...(input.tool === 'schema.inspect' ? {} : { expectedAppliedRevision: table.revision }),
      ...input,
    });
    const output = await chat.invokeWithSources({ workspaceId: ws.id, actor: human, callId: randomUUID() }, parsed);
    toolResultSchema.parse(output.result);
    return output;
  };
  return {
    db,
    ws,
    s,
    team,
    customers,
    customerIds,
    tickets,
    subject,
    status,
    customer,
    open,
    pending,
    closed,
    rows,
    revision: table.revision,
    call,
  };
}

const sourceTables = sources =>
  sources
    .filter(source => source.kind === 'table-rows')
    .map(source => source.tableId)
    .sort();

test(
  'agents search, summarize, and resolve linked rows with version 2 queries and record every table they read',
  { timeout: 180000 },
  async t => {
    const {
      s,
      db,
      ws,
      team,
      customers,
      customerIds,
      tickets,
      subject,
      status,
      customer,
      open,
      pending,
      closed,
      rows,
      call,
    } = await ticketTables(t);
    const ids = list => list.map(row => row.id).sort();

    await t.test('schema.inspect offers bounded query capabilities with stable selectors', async () => {
      const { result, sources } = await call({ tool: 'schema.inspect' });
      assert.deepEqual(
        result.query.fields.map(field => [field.fieldId, field.selector]),
        [
          [subject.id, 'subject'],
          [status.id, 'status'],
          [customer.id, 'customer'],
        ],
      );
      assert.deepEqual(
        result.query.fields.find(field => field.fieldId === customer.id),
        {
          fieldId: customer.id,
          selector: 'customer',
          ops: ['in', 'out', 'empty', 'not-empty'],
          sortable: false,
          groupable: false,
          metrics: [],
          targetTableId: customers.id,
        },
      );
      assert.equal(result.query.rsqlOperators.contains, '=contains=');
      assert.equal(result.query.limits.pageSize, 100);
      assert.deepEqual(sourceTables(sources), []);
    });

    await t.test(
      'rows.list accepts RSQL, returns canonical text and linked names, and records the linked table',
      async () => {
        const { result, sources } = await call({
          tool: 'rows.list',
          query: { version: 2, mode: 'rows', sort: [{ fieldId: subject.id }] },
          rsql: 'status==Open;customer=in=(Globex)',
        });
        const expected = rows.filter(row => row.optionId === open && row.linked === 'Globex');
        assert.deepEqual(
          result.records.map(record => record.values[subject.id].value),
          expected.map(row => row.text).sort(),
        );
        assert.ok(result.records.every(record => typeof record.token === 'string'));
        assert.deepEqual(
          [result.version, result.mode, result.total, result.nextCursor],
          [2, 'rows', String(expected.length), null],
        );
        assert.equal(result.rsql, `status==Open and customer=in=(${customerIds.Globex})`);
        assert.deepEqual(result.references, { [customerIds.Globex]: 'Globex' });
        assert.deepEqual(sourceTables(sources), [customers.id, tickets.id].sort());
      },
    );

    await t.test('rows.list accepts a structured OR group and pages with an unchanged cursor', async () => {
      const where = {
        kind: 'any',
        nodes: [
          { kind: 'rule', fieldId: status.id, op: 'eq', values: [pending] },
          { kind: 'rule', fieldId: status.id, op: 'eq', values: [closed] },
        ],
      };
      const first = await call({ tool: 'rows.list', query: { version: 2, mode: 'rows', where, limit: 2 } });
      const expected = rows.filter(row => row.optionId !== open);
      assert.deepEqual(
        [first.result.records.length, first.result.total, typeof first.result.nextCursor],
        [2, String(expected.length), 'string'],
      );
      assert.equal(first.result.rsql, 'status==Pending or status==Closed');
      assert.deepEqual(sourceTables(first.sources), [tickets.id]);
      const second = await call({
        tool: 'rows.list',
        query: { version: 2, mode: 'rows', limit: 2, after: first.result.nextCursor },
        rsql: first.result.rsql,
      });
      assert.deepEqual([second.result.total, second.result.nextCursor], [null, null]);
      assert.deepEqual(ids([...first.result.records, ...second.result.records]), ids(expected));
    });

    await t.test('the legacy rows.list request keeps its shape and result', async () => {
      const { result, sources } = await call({
        tool: 'rows.list',
        query: { filters: [{ fieldId: status.id, op: 'eq', value: open }] },
      });
      assert.deepEqual(Object.keys(result).sort(), ['nextCursor', 'records', 'total']);
      assert.deepEqual(ids(result.records), ids(rows.filter(row => row.optionId === open)));
      assert.deepEqual(sourceTables(sources), [tickets.id]);
    });

    await t.test('rows.summarize counts groups without reading rows', async () => {
      const { result, sources } = await call({
        tool: 'rows.summarize',
        query: {
          version: 2,
          mode: 'summary',
          groupBy: [status.id],
          order: { kind: 'group', index: 0, direction: 'asc' },
        },
      });
      const counts = Object.fromEntries(result.groups.map(group => [group.keys[0], group.values[0]]));
      assert.deepEqual(
        counts,
        Object.fromEntries(
          [open, pending, closed].map(id => [id, String(rows.filter(row => row.optionId === id).length)]),
        ),
      );
      assert.deepEqual([result.mode, result.groupCount, result.query.metrics], ['summary', '3', [{ fn: 'count' }]]);
      const linked = await call({
        tool: 'rows.summarize',
        query: { version: 2, mode: 'summary' },
        rsql: 'customer=in=(Globex)',
      });
      assert.deepEqual(linked.result.groups, [{ keys: [], values: ['3'] }]);
      assert.deepEqual(
        [sourceTables(sources), sourceTables(linked.sources)],
        [[tickets.id], [customers.id, tickets.id].sort()],
      );
    });

    await t.test('ambiguous linked names return choices instead of a guess', async () => {
      const lookup = await call({ tool: 'rows.resolveReference', fieldId: customer.id, search: 'acme' });
      assert.deepEqual(
        lookup.result.choices.map(choice => choice.id).sort(),
        [customerIds.Acme, customerIds.acme].sort(),
      );
      assert.deepEqual([lookup.result.more, lookup.result.targetTableId], [false, customers.id]);
      assert.deepEqual(sourceTables(lookup.sources), [customers.id, tickets.id].sort());
      const bounded = await call({ tool: 'rows.resolveReference', fieldId: customer.id, search: 'acme', limit: 1 });
      assert.deepEqual([bounded.result.choices.length, bounded.result.more], [1, true]);
      const ambiguous = await call({
        tool: 'rows.list',
        query: { version: 2, mode: 'rows' },
        rsql: 'customer=in=(acme)',
      });
      assert.equal(ambiguous.result.error, 'invalid-query');
      assert.deepEqual(
        ambiguous.result.issues[0].choices.map(choice => choice.id).sort(),
        [customerIds.Acme, customerIds.acme].sort(),
      );
      assert.deepEqual(sourceTables(ambiguous.sources), [customers.id, tickets.id].sort());
      const notLink = await call({ tool: 'rows.resolveReference', fieldId: status.id, search: 'Open' });
      assert.equal(notLink.result.error, 'invalid-query');
    });

    await t.test('stale revisions and wrong query modes are answers the agent can act on', async () => {
      const stale = await call({
        tool: 'rows.list',
        expectedAppliedRevision: 'c'.repeat(40),
        query: { version: 2, mode: 'rows' },
        rsql: '',
      });
      assert.deepEqual([stale.result.error, stale.sources], ['stale-revision', []]);
      const staleLookup = await call({
        tool: 'rows.resolveReference',
        expectedAppliedRevision: 'c'.repeat(40),
        fieldId: customer.id,
        search: 'acme',
      });
      assert.equal(staleLookup.result.error, 'stale-revision');
      const unknown = await call({ tool: 'rows.list', query: { version: 2, mode: 'rows' }, rsql: 'nonsense==1' });
      assert.deepEqual([unknown.result.error, unknown.result.issues[0].code], ['invalid-query', 'unknown-field']);
    });

    await t.test('a member without access to the linked table is denied every read that uses it', async () => {
      await db.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [ws.membershipId]);
      await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
        ws.membershipId,
        team,
      ]);
      await db.platform.query(
        `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
        [team, tickets.id],
      );
      const unlinked = await call({ tool: 'rows.summarize', query: { version: 2, mode: 'summary' } });
      assert.deepEqual(unlinked.result.groups, [{ keys: [], values: [String(rows.length)] }]);
      await assert.rejects(
        call({ tool: 'rows.list', query: { version: 2, mode: 'rows' }, rsql: `customer=in=(${customerIds.Globex})` }),
        AccessDenied,
      );
      await assert.rejects(
        call({
          tool: 'rows.list',
          query: {
            version: 2,
            mode: 'rows',
            where: { kind: 'rule', fieldId: customer.id, op: 'in', values: [customerIds.Globex] },
          },
        }),
        AccessDenied,
      );
      await assert.rejects(
        call({ tool: 'rows.summarize', query: { version: 2, mode: 'summary' }, rsql: 'customer=in=(Globex)' }),
        AccessDenied,
      );
      await assert.rejects(call({ tool: 'rows.resolveReference', fieldId: customer.id, search: 'acme' }), AccessDenied);
    });
  },
);
