import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createTableService } from '../../../tables/dist/service.js';
import { parseRsql, TableQueryError } from '../../../tables/dist/query.js';
import { createTableWithRows, tableDefinition, textField } from '../fixture.mjs';

const option = label => ({ id: randomUUID(), label, retired: false });

// A reference evaluator for the documented semantics. SQL results must agree with it row for row.
function matches(definition, node, values) {
  if (node.kind === 'all') return node.nodes.every(child => matches(definition, child, values));
  if (node.kind === 'any') return node.nodes.some(child => matches(definition, child, values));
  const field = definition.fields.find(item => item.id === node.fieldId),
    value = values[field.id] ?? null;
  const ids =
    value === null
      ? []
      : value.kind === 'multi-select'
        ? value.optionIds
        : value.kind === 'relationship'
          ? value.recordIds
          : value.kind === 'file'
            ? value.fileIds
            : [];
  if (['multi-select', 'relationship', 'file'].includes(field.kind)) {
    if (node.op === 'empty') return ids.length === 0;
    if (node.op === 'not-empty') return ids.length > 0;
    if (node.op === 'in') return ids.some(id => node.values.includes(id));
    if (node.op === 'out') return !ids.some(id => node.values.includes(id));
  }
  if (node.op === 'empty') return value === null;
  if (node.op === 'not-empty') return value !== null;
  if (value === null) return false;
  const raw = value.kind === 'single-select' ? value.optionId : String(value.value);
  const compare = (a, b) =>
    field.kind === 'numeric'
      ? Number(a) - Number(b)
      : field.kind === 'timestamp'
        ? Date.parse(a) - Date.parse(b)
        : a < b
          ? -1
          : a > b
            ? 1
            : 0;
  const [first] = node.values;
  switch (node.op) {
    case 'eq':
      return compare(raw, first) === 0;
    case 'ne':
      return compare(raw, first) !== 0;
    case 'lt':
      return compare(raw, first) < 0;
    case 'lte':
      return compare(raw, first) <= 0;
    case 'gt':
      return compare(raw, first) > 0;
    case 'gte':
      return compare(raw, first) >= 0;
    case 'in':
      return node.values.some(item => compare(raw, item) === 0);
    case 'out':
      return node.values.every(item => compare(raw, item) !== 0);
    case 'contains':
      return raw.toLowerCase().includes(first.toLowerCase());
  }
  throw new Error(`unhandled ${node.op}`);
}

test('v2 queries compile to correct, bounded, permission-checked SQL', { timeout: 180000 }, async t => {
  const setup = await fixture();
  t.after(() => setup.close());
  await setup.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const workspace = await setup.create(await workspaceTableMigrations());
  const runtime = createWorkspaceRuntime({
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: setup.login(workspace) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  t.after(() => runtime.close());
  const s = `"${workspace.names.schema}"`,
    team = randomUUID();
  await setup.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
  const service = createTableService(
    runtime,
    { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
    commonCompatibility,
  );

  const customerName = textField('Name');
  const customers = tableDefinition({ owningTeamId: team, label: 'Customers', fields: [customerName] });
  const customerIds = ['Acme', 'Globex', 'Initech', 'Acme'].map(() => randomUUID());
  await createTableWithRows({
    db: setup,
    workspace,
    runtime,
    definition: customers,
    records: ['Acme', 'Globex', 'Initech', 'acme'].map((name, index) => ({
      id: customerIds[index],
      values: { [customerName.id]: { kind: 'text', value: name } },
    })),
  });

  const status = {
    id: randomUUID(),
    label: 'Status',
    kind: 'single-select',
    required: false,
    options: ['Open', 'Pending', 'Closed'].map(option),
  };
  const priority = {
    id: randomUUID(),
    label: 'Priority',
    kind: 'single-select',
    required: false,
    options: ['Low', 'High', 'Urgent'].map(option),
  };
  const subject = textField('Subject');
  const amount = { id: randomUUID(), label: 'Amount', kind: 'numeric', required: false, precision: 12, scale: 2 };
  const due = { id: randomUUID(), label: 'Due date', kind: 'date', required: false };
  const created = { id: randomUUID(), label: 'Created at', kind: 'timestamp', required: false, timezone: 'UTC' };
  const vip = { id: randomUUID(), label: 'VIP', kind: 'boolean', required: false };
  const tags = {
    id: randomUUID(),
    label: 'Tags',
    kind: 'multi-select',
    required: false,
    options: ['Billing', 'Bug', 'Feature'].map(option),
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
  const watchers = {
    id: randomUUID(),
    label: 'Watchers',
    kind: 'relationship',
    required: false,
    targetTableId: customers.id,
    cardinality: 'many',
    inverseCardinality: 'many',
    reverse: null,
    onDelete: 'restrict',
  };
  const tickets = tableDefinition({
    owningTeamId: team,
    label: 'Tickets',
    fields: [subject, status, priority, amount, due, created, vip, tags, customer, watchers],
  });
  const subjects = [
    'Payment failed',
    'Login broken',
    'payment FAILED twice',
    'Feature: dark mode',
    '50%_off coupon',
    'Refund',
    'null',
    'Café order',
    'Invoice missing',
    'Slow page',
  ];
  const records = Array.from({ length: 40 }, (_, i) => {
    const pick = (list, n) => list[n % list.length];
    const values = {
      [subject.id]: i % 11 === 10 ? null : { kind: 'text', value: `${pick(subjects, i)} ${i % 3 ? '' : '#'}`.trim() },
      [status.id]: i % 9 === 8 ? null : { kind: 'single-select', optionId: pick(status.options, i).id },
      [priority.id]: i % 7 === 6 ? null : { kind: 'single-select', optionId: pick(priority.options, i * 5).id },
      [amount.id]:
        i % 8 === 7 ? null : { kind: 'numeric', value: `${(i * 37) % 500}.${String(i % 100).padStart(2, '0')}` },
      [due.id]:
        i % 6 === 5
          ? null
          : {
              kind: 'date',
              value: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
            },
      [created.id]:
        i % 10 === 9
          ? null
          : { kind: 'timestamp', value: new Date(Date.UTC(2026, 8, 1 + (i % 30), i % 24)).toISOString() },
      [vip.id]: i % 5 === 4 ? null : { kind: 'boolean', value: i % 2 === 0 },
      [tags.id]:
        i % 4 === 3
          ? null
          : {
              kind: 'multi-select',
              optionIds: i % 4 === 2 ? [] : tags.options.filter((_, n) => (i + n) % 3 === 0).map(item => item.id),
            },
      [customer.id]:
        i % 5 === 3 ? null : { kind: 'relationship', tableId: customers.id, recordIds: [customerIds[i % 4]] },
      [watchers.id]:
        i % 3 === 1
          ? null
          : {
              kind: 'relationship',
              tableId: customers.id,
              recordIds: i % 3 === 2 ? [] : customerIds.filter((_, n) => (i + n) % 2 === 0),
            },
    };
    return {
      id: randomUUID(),
      values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
    };
  });
  const table = await createTableWithRows({ db: setup, workspace, runtime, definition: tickets, records });
  const base = { tableId: tickets.id, revision: table.revision };
  const all = async (request, limit = 7) => {
    const ids = [];
    let after,
      pages = 0,
      total;
    do {
      const page = await service.query(workspace.id, workspace.userId, {
        ...base,
        request: {
          ...request,
          ...('query' in request
            ? { query: { ...request.query, limit, ...(after ? { after } : {}) } }
            : { options: { ...request.options, limit, ...(after ? { after } : {}) } }),
        },
      });
      if (!after) total = page.total;
      ids.push(...page.records.map(record => record.id));
      after = page.nextCursor ?? undefined;
      pages += 1;
    } while (after && pages < 50);
    return { ids, total };
  };
  const expected = rsql => {
    const where = parseRsql(tickets, rsql, { [customer.id]: { globex: customerIds[1] } });
    return records.filter(record => !where || matches(tickets, where, record.values)).map(record => record.id);
  };

  await t.test('every operator agrees with the reference semantics, across pages', async () => {
    const cases = [
      'status==Open',
      'status!=Open',
      'status=in=(Open,Pending)',
      'status=out=(Closed)',
      'status=isnull=true',
      'priority==Urgent or priority==High',
      'status==Open and (priority==High or priority==Urgent)',
      'subject=="Payment failed"',
      'subject=contains="payment failed"',
      'subject=contains="50%_"',
      'subject=contains=%',
      'subject==null',
      'subject=isnull=true',
      'subject=out=(Refund,"Refund #")',
      'amount>100',
      'amount<=37.01',
      'amount=in=(0.00,37.01)',
      'amount!=0.00',
      'amount=isnull=false',
      'due_date>=2026-06-01',
      'due_date<2026-03-15;vip==true',
      'created_at>=2026-09-15T00:00:00Z',
      'created_at<2026-09-10T12:00:00+02:00',
      'vip==false',
      'vip!=true',
      'vip=isnull=true',
      'tags=in=(Billing)',
      'tags=in=(Billing,Bug)',
      'tags=out=(Bug)',
      'tags=isnull=true',
      'tags=isnull=false',
      `customer=in=(${customerIds[0]})`,
      `customer=out=(${customerIds[0]})`,
      'customer=isnull=true',
      'customer=in=(Globex)',
      `watchers=in=(${customerIds[1]})`,
      `watchers=out=(${customerIds[1]})`,
      'watchers=isnull=true',
      '(status==Open,status==Pending);(tags=in=(Bug),vip==true);amount>=10',
    ];
    for (const rsql of cases) {
      const { ids, total } = await all({ rsql, options: { version: 2, mode: 'rows' } });
      assert.deepEqual([...ids].sort(), [...expected(rsql)].sort(), rsql);
      assert.equal(total, String(ids.length), `${rsql} count`);
      assert.equal(new Set(ids).size, ids.length, `${rsql} pages without duplicates`);
    }
  });

  await t.test('multi-key sorting with nulls last pages exactly once through ties', async () => {
    for (const sort of [
      [
        { fieldId: priority.id, direction: 'desc' },
        { fieldId: created.id, direction: 'asc' },
      ],
      [
        { fieldId: vip.id, direction: 'asc' },
        { fieldId: amount.id, direction: 'desc' },
        { fieldId: subject.id, direction: 'asc' },
      ],
      [{ fieldId: due.id, direction: 'desc' }],
    ]) {
      const { ids } = await all({ query: { version: 2, mode: 'rows', sort } }, 3);
      const single = await service.query(workspace.id, workspace.userId, {
        ...base,
        request: { query: { version: 2, mode: 'rows', sort, limit: 100 } },
      });
      assert.deepEqual(
        ids,
        single.records.map(record => record.id),
      );
      assert.equal(ids.length, records.length);
    }
    const byPriority = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: { query: { version: 2, mode: 'rows', sort: [{ fieldId: priority.id, direction: 'asc' }], limit: 100 } },
    });
    const order = byPriority.records.map(record => record.values[priority.id]?.optionId ?? null);
    const rank = id => (id === null ? 99 : priority.options.findIndex(item => item.id === id));
    assert.deepEqual(
      order.map(rank),
      order.map(rank).sort((a, b) => a - b),
      'single choices sort by option order with empty last',
    );
  });

  await t.test('cursors are bound to their query and revision', async () => {
    const page = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: { rsql: 'status==Open', options: { version: 2, mode: 'rows', limit: 2 } },
    });
    assert.ok(page.nextCursor);
    await assert.rejects(
      service.query(workspace.id, workspace.userId, {
        ...base,
        request: { rsql: 'status==Closed', options: { version: 2, mode: 'rows', limit: 2, after: page.nextCursor } },
      }),
      /Cursor does not match/,
    );
    await assert.rejects(
      service.query(workspace.id, workspace.userId, {
        ...base,
        request: { rsql: 'status==Open', options: { version: 2, mode: 'rows', limit: 2, after: 'garbage' } },
      }),
      /Malformed cursor/,
    );
    await assert.rejects(
      service.query(workspace.id, workspace.userId, {
        tableId: tickets.id,
        revision: 'f'.repeat(40),
        request: { rsql: '', options: { version: 2, mode: 'rows' } },
      }),
      /stale-generation/,
    );
  });

  await t.test('projection returns only selected fields', async () => {
    const page = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: { rsql: 'subject=isnull=false', options: { version: 2, mode: 'rows', select: [subject.id], limit: 3 } },
    });
    for (const record of page.records) assert.deepEqual(Object.keys(record.values), [subject.id]);
  });

  await t.test('summaries group with exact counts, decimals, and an Empty group', async () => {
    const result = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: {
        rsql: 'vip==true or vip==false or vip=isnull=true',
        options: {
          version: 2,
          mode: 'summary',
          groupBy: [status.id],
          metrics: [{ fn: 'count' }, { fn: 'sum', fieldId: amount.id }, { fn: 'max', fieldId: created.id }],
        },
      },
    });
    assert.equal(result.groupCount, '4');
    const keyed = new Map(result.groups.map(group => [group.keys[0], group.values]));
    for (const key of [...status.options.map(item => item.id), null]) {
      const rows = records.filter(record => (record.values[status.id]?.optionId ?? null) === key);
      const sum = rows.reduce(
        (total, record) =>
          total + (record.values[amount.id] ? Math.round(Number(record.values[amount.id].value) * 100) : 0),
        0,
      );
      const max =
        rows
          .map(record => record.values[created.id]?.value)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null;
      assert.deepEqual(keyed.get(key), [String(rows.length), (sum / 100).toFixed(2), max], `group ${key}`);
    }
    assert.deepEqual(result.groups.at(-1).keys, [null], 'empty group sorts last');
    const empty = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: {
        rsql: 'subject=="no such subject"',
        options: { version: 2, mode: 'summary', metrics: [{ fn: 'count' }, { fn: 'avg', fieldId: amount.id }] },
      },
    });
    assert.deepEqual(empty.groups, [{ keys: [], values: ['0', null] }]);
    const two = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: {
        rsql: '',
        options: {
          version: 2,
          mode: 'summary',
          groupBy: [status.id, vip.id],
          metrics: [{ fn: 'count' }],
          order: { kind: 'metric', index: 0, direction: 'desc' },
          limit: 2,
        },
      },
    });
    assert.equal(two.groups.length, 2);
    assert.ok(Number(two.groups[0].values[0]) >= Number(two.groups[1].values[0]));
    const next = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: {
        rsql: '',
        options: {
          version: 2,
          mode: 'summary',
          groupBy: [status.id, vip.id],
          metrics: [{ fn: 'count' }],
          order: { kind: 'metric', index: 0, direction: 'desc' },
          limit: 2,
          after: two.nextCursor,
        },
      },
    });
    assert.notDeepEqual(next.groups[0], two.groups[0]);
  });

  await t.test('linked-row names resolve or return choices; labels come back for display', async () => {
    const resolved = await service.validateQuery(workspace.id, workspace.userId, {
      ...base,
      request: { rsql: 'customer=in=(Globex)', options: { version: 2, mode: 'rows' } },
    });
    assert.equal(resolved.rsql, `customer=in=(${customerIds[1]})`);
    assert.equal(resolved.references[customerIds[1]], 'Globex');
    await assert.rejects(
      service.validateQuery(workspace.id, workspace.userId, {
        ...base,
        request: { rsql: 'customer=in=(acme)', options: { version: 2, mode: 'rows' } },
      }),
      error => {
        assert.ok(error instanceof TableQueryError);
        assert.deepEqual(
          error.issues[0].choices.map(choice => choice.id).sort(),
          [customerIds[0], customerIds[3]].sort(),
        );
        return true;
      },
    );
    await assert.rejects(
      service.validateQuery(workspace.id, workspace.userId, {
        ...base,
        request: { rsql: 'customer=in=(Umbrella)', options: { version: 2, mode: 'rows' } },
      }),
      error => error instanceof TableQueryError && error.issues[0].choices.length === 0,
    );
    const lookup = await service.references(workspace.id, workspace.userId, {
      tableId: tickets.id,
      fieldId: customer.id,
      search: 'ac',
    });
    assert.deepEqual(lookup.choices.map(choice => choice.label).sort(), ['Acme', 'acme']);
    await assert.rejects(
      service.references(workspace.id, workspace.userId, { tableId: tickets.id, fieldId: subject.id, search: 'a' }),
      TableQueryError,
    );
  });

  await t.test('capabilities expose selectors and operators for this table only', async () => {
    const capabilities = await service.capabilities(workspace.id, workspace.userId, { tableId: tickets.id });
    assert.equal(capabilities.revision, table.revision);
    assert.equal(capabilities.fields.find(field => field.fieldId === created.id).selector, 'created_at');
  });

  await t.test('forged and unsupported input never broadens results', async () => {
    for (const request of [
      { rsql: 'subject=like=x', options: { version: 2, mode: 'rows' } },
      { rsql: `f_${customerName.id.replaceAll('-', '')}==Acme`, options: { version: 2, mode: 'rows' } },
      {
        query: {
          version: 2,
          mode: 'rows',
          where: { kind: 'rule', fieldId: customerName.id, op: 'eq', values: ['Acme'] },
        },
      },
      {
        query: {
          version: 2,
          mode: 'rows',
          where: { kind: 'rule', fieldId: subject.id, op: 'eq', values: ["x' OR 1=1 --"] },
        },
        sql: 'SELECT 1',
      },
    ])
      await assert.rejects(service.query(workspace.id, workspace.userId, { ...base, request }));
    const literal = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: {
        query: {
          version: 2,
          mode: 'rows',
          where: { kind: 'rule', fieldId: subject.id, op: 'eq', values: ["x' OR 1=1 --"] },
        },
      },
    });
    assert.equal(literal.records.length, 0);
  });

  await t.test('a member needs read access to the table and to linked tables used in filters', async () => {
    await setup.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [workspace.membershipId]);
    await setup.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
      workspace.membershipId,
      team,
    ]);
    await setup.platform.query(
      `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [team, tickets.id],
    );
    const plain = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: { rsql: 'status==Open', options: { version: 2, mode: 'rows' } },
    });
    assert.ok(plain.records.length > 0);
    await assert.rejects(
      service.query(workspace.id, workspace.userId, {
        ...base,
        request: { rsql: `customer=in=(${customerIds[0]})`, options: { version: 2, mode: 'rows' } },
      }),
      AccessDenied,
    );
    await assert.rejects(
      service.references(workspace.id, workspace.userId, { tableId: tickets.id, fieldId: customer.id, search: 'a' }),
      AccessDenied,
    );
    await assert.rejects(
      service.query(workspace.id, workspace.userId, {
        tableId: customers.id,
        revision: table.revision,
        request: { rsql: '', options: { version: 2, mode: 'rows' } },
      }),
      AccessDenied,
    );
    const summary = await service.query(workspace.id, workspace.userId, {
      ...base,
      request: { rsql: '', options: { version: 2, mode: 'summary', groupBy: [status.id] } },
    });
    assert.equal(
      summary.groups.reduce((total, group) => total + Number(group.values[0]), 0),
      records.length,
    );
  });
});
