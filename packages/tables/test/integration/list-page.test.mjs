import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createTableService } from '../../../tables/dist/service.js';
import { createGeneration, activateGeneration } from '../../../tables/dist/store.js';

const pageBudgetMs = 250;

test(
  'listPage on 100000 rows counts once, caps the count and checks a page of files in one call',
  { timeout: 300000 },
  async t => {
    const count = 100000;
    const db = await fixture();
    let runtime, migration;
    t.after(async () => {
      await migration?.end();
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    const ws = await db.create(migrations),
      s = `"${ws.names.schema}"`;
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    });
    migration = await connect(db.login(ws, 'migration'));
    const team = randomUUID(),
      revision = 'c'.repeat(40);
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    const title = { id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 1000 };
    const files = {
      id: randomUUID(),
      label: 'Files',
      kind: 'file',
      required: false,
      cardinality: 'many',
      access: 'independent',
    };
    const definition = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Tickets',
      fields: [title, files],
      uniqueKeys: [],
    };
    const generation = await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${ws.names.customOwner}"`);
      const created = await createGeneration({ client, schema: ws.names.schema }, { definition, revision });
      await activateGeneration(
        { client, schema: ws.names.schema },
        { generationId: created.id, expectedActiveGenerationId: null },
      );
      return created;
    });
    const column = field => `"f_${field.id.replaceAll('-', '')}"`;
    const fileId = i => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
    await db.platform.query(
      `INSERT INTO ${s}."${generation.physical_table}"(id,token,${column(title)},${column(files)})
    SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,gen_random_uuid(),CASE WHEN i%2=0 THEN 'even' ELSE 'odd' END,
      ARRAY[('00000000-0000-4000-9000-'||lpad(i::text,12,'0'))::uuid]
    FROM generate_series(1,$1) i`,
      [count],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_table_identities(table_id,row_id,token,incarnation,field_versions,live)
    SELECT $1,id,token,token,jsonb_build_object($2::text,token,$3::text,token),true FROM ${s}."${generation.physical_table}"`,
      [definition.id, title.id, files.id],
    );
    await db.platform.query(`ANALYZE ${s}."${generation.physical_table}"`);

    const calls = [];
    const service = createTableService(
      runtime,
      {
        readableFiles: async (_tx, _actor, ids) => {
          calls.push([...ids]);
          return new Set(ids.filter(id => id.endsWith('0')));
        },
      },
      { minimum: migrations.length, maximum: migrations.length },
    );
    const timed = async query => {
      calls.length = 0;
      const start = performance.now();
      const page = await service.listPage(ws.id, ws.userId, { tableId: definition.id, revision, query });
      return { page, ms: performance.now() - start, fileCalls: calls.length };
    };
    await timed({ limit: 1 });

    const first = await timed({ limit: 100 });
    assert.equal(first.page.total, '10000+', 'the first page reports a capped total');
    assert.equal(first.page.records.length, 100);
    assert.equal(first.fileCalls, 1, 'a page checks its files in one call');
    assert.deepEqual(
      calls[0],
      Array.from({ length: 100 }, (_, index) => fileId(index + 1)),
    );
    assert.deepEqual(
      first.page.records.slice(0, 10).map(record => record.unavailableFileIds ?? null),
      [...Array.from({ length: 9 }, (_, index) => [fileId(index + 1)]), null],
    );

    const later = await timed({ after: first.page.nextCursor, limit: 100 });
    assert.equal(later.page.total, null, 'a later page skips the count');
    assert.equal(later.page.records[0].id, '00000000-0000-4000-8000-000000000101');
    assert.equal(later.fileCalls, 1);

    const filtered = await timed({ filters: [{ fieldId: title.id, op: 'eq', value: 'odd' }], limit: 100 });
    assert.equal(filtered.page.total, '10000+');
    const narrow = await timed({ filters: [{ fieldId: title.id, op: 'eq', value: 'none' }], limit: 100 });
    assert.deepEqual([narrow.page.total, narrow.page.records, narrow.fileCalls], ['0', [], 0]);

    const deep = await timed({ after: '00000000-0000-4000-8000-000000099000', limit: 100 });
    assert.equal(deep.page.total, null);
    process.stdout.write(
      `${JSON.stringify({ event: 'list-page-latency', rows: count, budgetMs: pageBudgetMs, firstMs: Math.round(first.ms), laterMs: Math.round(later.ms), filteredMs: Math.round(filtered.ms), deepMs: Math.round(deep.ms) })}\n`,
    );
    for (const [name, result] of Object.entries({ first, later, filtered, deep }))
      assert.ok(result.ms < pageBudgetMs, `${name} page took ${Math.round(result.ms)}ms on ${count} rows`);
  },
);

test(
  'listPage searches text fields and pages a sort by value even after the anchor row is deleted',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime, migration;
    t.after(async () => {
      await migration?.end();
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const migrations = await workspaceTableMigrations();
    const ws = await db.create(migrations),
      s = `"${ws.names.schema}"`;
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    });
    migration = await connect(db.login(ws, 'migration'));
    const team = randomUUID(),
      revision = 'd'.repeat(40);
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    const name = { id: randomUUID(), label: 'Name', kind: 'text', required: false, maxLength: 100 };
    const amount = { id: randomUUID(), label: 'Amount', kind: 'numeric', required: false, precision: 10, scale: 2 };
    const at = { id: randomUUID(), label: 'At', kind: 'timestamp', required: false, timezone: 'UTC' };
    const files = {
      id: randomUUID(),
      label: 'Files',
      kind: 'file',
      required: false,
      cardinality: 'many',
      access: 'independent',
    };
    const definition = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: team,
      label: 'Ledger',
      fields: [name, amount, at, files],
      uniqueKeys: [],
    };
    const generation = await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${ws.names.customOwner}"`);
      const created = await createGeneration({ client, schema: ws.names.schema }, { definition, revision });
      await activateGeneration(
        { client, schema: ws.names.schema },
        { generationId: created.id, expectedActiveGenerationId: null },
      );
      return created;
    });
    const column = field => `"f_${field.id.replaceAll('-', '')}"`,
      physical = `${s}."${generation.physical_table}"`;
    const id = n => `00000000-0000-4000-8000-00000000000${n}`;
    const rows = [
      [1, 'Alpha', '5.00', '2024-01-01T00:00:00.123Z'],
      [2, 'beta 50%', null, '2024-01-01T00:00:00.123Z'],
      [3, 'Gamma_x', '2.00', '2024-01-01T00:00:00.124Z'],
      [4, 'ALPHA two', '5.00', null],
      [5, null, '9.00', '2023-12-31T23:59:59.999Z'],
      [6, 'delta', null, null],
      [7, 'alphabet', '2.00', '2024-01-01T00:00:00.122Z'],
    ];
    for (const [n, text, value, instant] of rows)
      await db.platform.query(
        `INSERT INTO ${physical}(id,token,${column(name)},${column(amount)},${column(at)}) VALUES($1,gen_random_uuid(),$2,$3,$4)`,
        [id(n), text, value, instant],
      );
    const service = createTableService(
      runtime,
      { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
      { minimum: migrations.length, maximum: migrations.length },
    );
    const list = query => service.listPage(ws.id, ws.userId, { tableId: definition.id, revision, query });
    const ids = page => page.records.map(record => record.id);
    const paged = async query => {
      const seen = [];
      for (let after; ;) {
        const page = await list({ ...query, limit: 2, ...(after ? { after } : {}) });
        seen.push(...ids(page));
        if (!page.nextCursor) return seen;
        after = page.nextCursor;
      }
    };

    const alpha = await list({ search: '  ALPHA ' });
    assert.deepEqual(
      [ids(alpha), alpha.total],
      [[id(1), id(4), id(7)], '3'],
      'search ignores case and counts only matches',
    );
    assert.deepEqual(ids(await list({ search: '%' })), [id(2)], '% matches literally');
    assert.deepEqual(ids(await list({ search: '_' })), [id(3)], '_ matches literally');
    const both = await list({
      search: 'alpha',
      filters: [{ fieldId: amount.id, op: 'eq', value: '5' }],
      sort: { fieldId: amount.id, direction: 'desc' },
    });
    assert.deepEqual([ids(both), both.total], [[id(1), id(4)], '2'], 'search, filters, and sort combine');

    const orders = {
      'amount asc': [{ fieldId: amount.id }, [3, 7, 1, 4, 5, 2, 6]],
      'amount desc': [{ fieldId: amount.id, direction: 'desc' }, [5, 1, 4, 3, 7, 2, 6]],
      'name asc': [{ fieldId: name.id, direction: 'asc' }, [4, 1, 3, 7, 2, 6, 5]],
      'at desc': [{ fieldId: at.id, direction: 'desc' }, [3, 1, 2, 7, 5, 4, 6]],
    };
    for (const [label, [sort, expected]] of Object.entries(orders)) {
      const page = await list({ sort, limit: 100 });
      assert.deepEqual(
        [ids(page), page.total, page.nextCursor],
        [expected.map(id), '7', null],
        `${label} orders nulls last with id tiebreak`,
      );
      assert.deepEqual(await paged({ sort }), expected.map(id), `${label} pages without gaps or repeats`);
    }

    const sort = { fieldId: amount.id };
    const first = await list({ sort, limit: 2 });
    assert.deepEqual(ids(first), [id(3), id(7)]);
    await db.platform.query(`DELETE FROM ${physical} WHERE id=$1`, [id(7)]);
    const second = await list({ sort, after: first.nextCursor, limit: 2 });
    assert.deepEqual(
      [ids(second), second.total],
      [[id(1), id(4)], null],
      'paging continues after the anchor row is deleted',
    );

    await assert.rejects(list({ sort: { fieldId: amount.id, direction: 'desc' }, after: first.nextCursor }), {
      name: 'TableValidationError',
      message: 'Cursor does not match the sort',
    });
    await assert.rejects(list({ sort: { fieldId: name.id }, after: first.nextCursor }), {
      name: 'TableValidationError',
      message: 'Cursor does not match the sort',
    });
    await assert.rejects(
      list({ after: first.nextCursor }),
      { name: 'TableValidationError' },
      'a sort cursor needs its sort',
    );
    await assert.rejects(list({ sort, after: id(3) }), { name: 'TableValidationError', message: 'Malformed cursor' });
    await assert.rejects(list({ sort: { fieldId: files.id } }), {
      name: 'TableValidationError',
      message: 'Unsortable field',
    });
    await assert.rejects(list({ sort: { fieldId: randomUUID() } }), {
      name: 'TableValidationError',
      message: 'Unknown sort field',
    });
  },
);
