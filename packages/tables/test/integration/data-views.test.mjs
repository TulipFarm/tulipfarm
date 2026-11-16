import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { AccessDenied, canAccessAsset } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { createTableService } from '../../../tables/dist/service.js';
import {
  createGeneration,
  activateGeneration,
  readRecords,
  activeGeneration,
  writeGenerationRecord,
} from '../../../tables/dist/store.js';
import { approveDataView, createDataView, shareDataView } from '../../../tables/dist/data-view-store.js';

test('an app reaches rows only through a data view approved for its live release', { timeout: 120000 }, async t => {
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
  const compatibility = { minimum: migrations.length, maximum: migrations.length };
  const ws = await db.create(migrations),
    s = `"${ws.names.schema}"`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
    resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
  });
  migration = await connect(db.login(ws, 'migration'));
  const maintenance = action =>
    inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${ws.names.customOwner}"`);
      return action({ client, schema: ws.names.schema });
    });
  const as = (actor, action) => runtime.transaction(ws.id, compatibility, tx => action(tx, actor));

  const admin = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const approver = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  for (const [person, role] of [
    [approver, 'admin'],
    [member, 'member'],
  ])
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,$3)`, [
      person.membershipId,
      person.userId,
      role,
    ]);
  const team = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);

  const field = (label, extra = {}) => ({
    id: randomUUID(),
    label,
    required: false,
    kind: 'text',
    maxLength: 200,
    ...extra,
  });
  const fields = {
    title: field('Title'),
    owner: field('Owner'),
    secret: field('Secret'),
    published: { id: randomUUID(), label: 'Published', required: false, kind: 'boolean' },
  };
  const definition = {
    formatVersion: 2,
    id: randomUUID(),
    owningTeamId: team,
    label: 'Posts',
    fields: Object.values(fields),
    uniqueKeys: [],
  };
  const revision = 'a'.repeat(40);
  await maintenance(async tx => {
    const created = await createGeneration(tx, { definition, revision });
    await activateGeneration(tx, { generationId: created.id, expectedActiveGenerationId: null });
  });

  const service = createTableService(runtime, { readableFiles: async () => new Set() }, compatibility);
  const text = value => ({ kind: 'text', value });
  const rows = {};
  for (const [key, owner, published] of [
    ['adaPublic', 'ada', true],
    ['adaDraft', 'ada', false],
    ['bobPublic', 'bob', true],
  ]) {
    rows[key] = await service.mutate(ws.id, admin, {
      kind: 'create',
      tableId: definition.id,
      revision,
      recordId: randomUUID(),
      values: {
        [fields.title.id]: text(key),
        [fields.owner.id]: text(owner),
        [fields.secret.id]: text(`secret ${key}`),
        [fields.published.id]: { kind: 'boolean', value: published },
      },
    });
  }

  const appId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_apps(id,kind,slug,title,created_by,public_name,approval_state) VALUES($1,'public','blog','Blog',$2,'Blog','approved')`,
    [appId, ws.membershipId],
  );
  const release = async number => {
    const build = randomUUID().replaceAll('-', '').padEnd(64, '0');
    await db.platform.query(
      `INSERT INTO ${s}.tf_app_builds(id,app_id,commit,recipe,builder,status,manifest_digest,requested_by)
      VALUES($1,$2,$3,'{}','test','succeeded',$4,$5)`,
      [build, appId, 'c'.repeat(40), 'd'.repeat(64), ws.membershipId],
    );
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${s}.tf_app_releases(id,app_id,number,build_id,commit,manifest_digest,published_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, appId, number, build, 'c'.repeat(40), 'd'.repeat(64), ws.membershipId],
    );
    return id;
  };
  const live = await release(1),
    other = await release(2);
  await db.platform.query(`UPDATE ${s}.tf_apps SET live_release_id=$2 WHERE id=$1`, [appId, live]);
  const app = { kind: 'app', appId, releaseId: live };

  const view = await as(admin, tx =>
    createDataView(tx, admin, {
      appId,
      tableId: definition.id,
      fieldIds: [fields.title.id, fields.owner.id],
      predicate: {
        all: [
          { fieldId: fields.owner.id, op: 'eq', operand: { kind: 'parameter', name: 'owner' } },
          { fieldId: fields.published.id, op: 'eq', operand: { kind: 'value', value: true } },
        ],
      },
      actions: ['read', 'create', 'update'],
    }),
  );
  const ada = { viewId: view.id, parameters: { owner: 'ada' } };
  const list = (actor = app, request = ada) =>
    service.listThroughView(ws.id, actor, { ...request, query: { limit: 50 } });

  await t.test('a view serves nothing until it is shared and approved for the release', async () => {
    await assert.rejects(list(), AccessDenied);
    await assert.rejects(
      as(member, tx => shareDataView(tx, member, { releaseId: live, viewId: view.id })),
      AccessDenied,
    );
    await as(admin, tx => shareDataView(tx, admin, { releaseId: live, viewId: view.id }));
    await assert.rejects(list(), AccessDenied);
    await assert.rejects(
      as(member, tx => approveDataView(tx, member, { releaseId: live, viewId: view.id })),
      AccessDenied,
    );
    await as(approver, tx => approveDataView(tx, approver, { releaseId: live, viewId: view.id }));
    const grant = (
      await db.platform.query(`SELECT shared_by,approved_by,approved_at FROM ${s}.tf_app_data_view_grants`)
    ).rows;
    assert.deepEqual(
      grant.map(row => [row.shared_by, row.approved_by, row.approved_at instanceof Date]),
      [[ws.membershipId, approver.membershipId, true]],
    );
  });

  await t.test('the app reads only listed fields of rows its predicate reaches', async () => {
    const page = await list();
    assert.deepEqual(page.total, '1');
    assert.deepEqual(
      page.records.map(record => [record.id, record.values]),
      [[rows.adaPublic.id, { [fields.title.id]: text('adaPublic'), [fields.owner.id]: text('ada') }]],
    );
    assert.deepEqual(
      (await list(app, { viewId: view.id, parameters: { owner: 'bob' } })).records.map(record => record.id),
      [rows.bobPublic.id],
    );
    assert.equal(await service.readThroughView(ws.id, app, { ...ada, recordId: rows.adaDraft.id }), null);
    assert.deepEqual((await service.readThroughView(ws.id, app, { ...ada, recordId: rows.adaPublic.id })).values, {
      [fields.title.id]: text('adaPublic'),
      [fields.owner.id]: text('ada'),
    });
    await assert.rejects(list(app, { viewId: view.id, parameters: {} }), AccessDenied);
    await assert.rejects(
      service.listThroughView(ws.id, app, {
        ...ada,
        query: { filters: [{ fieldId: fields.secret.id, op: 'eq', value: 'secret adaPublic' }] },
      }),
      AccessDenied,
    );
    await assert.rejects(
      service.listThroughView(ws.id, app, { ...ada, query: { sort: { fieldId: fields.secret.id, direction: 'asc' } } }),
      AccessDenied,
    );
    assert.equal(
      (await service.listThroughView(ws.id, app, { ...ada, query: { search: 'secret' } })).records.length,
      0,
      'search covers view fields only',
    );
  });

  await t.test('a viewer adds no authority to the app', async () => {
    const page = await list({ ...app, viewer: admin });
    assert.deepEqual(
      page.records.map(record => Object.keys(record.values).sort()),
      [[fields.title.id, fields.owner.id].sort()],
    );
    await as({ ...app, viewer: admin }, async (tx, actor) => {
      assert.equal(await canAccessAsset(tx, actor, definition.id, 'table.row.read'), false);
    });
  });

  await t.test('another release and another view are denied', async () => {
    await assert.rejects(list({ ...app, releaseId: other }), AccessDenied);
    await as(admin, tx => shareDataView(tx, admin, { releaseId: other, viewId: view.id }));
    await as(approver, tx => approveDataView(tx, approver, { releaseId: other, viewId: view.id }));
    await assert.rejects(list({ ...app, releaseId: other }), AccessDenied, 'only the live release is served');
    await assert.rejects(list(app, { viewId: randomUUID(), parameters: {} }), AccessDenied);
    await assert.rejects(list({ ...app, appId: randomUUID() }), AccessDenied);
  });

  await t.test('a create the predicate does not reach is refused and rolled back', async () => {
    const recordId = randomUUID();
    await assert.rejects(
      service.mutateThroughView(ws.id, app, {
        ...ada,
        kind: 'create',
        recordId,
        values: { [fields.title.id]: text('new'), [fields.owner.id]: text('ada') },
      }),
      AccessDenied,
    );
    assert.equal(await service.read(ws.id, admin, { tableId: definition.id, revision, recordId }), null);
  });

  const editor = await as(admin, tx =>
    createDataView(tx, admin, {
      appId,
      tableId: definition.id,
      fieldIds: [fields.title.id, fields.owner.id, fields.published.id],
      predicate: { all: [{ fieldId: fields.owner.id, op: 'eq', operand: { kind: 'parameter', name: 'owner' } }] },
      actions: ['read', 'create', 'update'],
    }),
  );
  await as(admin, tx => shareDataView(tx, admin, { releaseId: live, viewId: editor.id }));
  await as(approver, tx => approveDataView(tx, approver, { releaseId: live, viewId: editor.id }));
  const edit = { viewId: editor.id, parameters: { owner: 'ada' } };

  await t.test('writes set only view fields and keep the row inside the predicate', async () => {
    const created = await service.mutateThroughView(ws.id, app, {
      ...edit,
      kind: 'create',
      recordId: randomUUID(),
      values: { [fields.title.id]: text('by app'), [fields.owner.id]: text('ada') },
    });
    assert.deepEqual(created.values, {
      [fields.title.id]: text('by app'),
      [fields.owner.id]: text('ada'),
      [fields.published.id]: null,
    });
    await assert.rejects(
      service.mutateThroughView(ws.id, app, {
        ...edit,
        kind: 'create',
        recordId: randomUUID(),
        values: { [fields.owner.id]: text('ada'), [fields.secret.id]: text('x') },
      }),
      AccessDenied,
    );
    const current = await service.read(ws.id, admin, { tableId: definition.id, revision, recordId: rows.adaDraft.id });
    await assert.rejects(
      service.mutateThroughView(ws.id, app, {
        ...edit,
        kind: 'update',
        recordId: rows.adaDraft.id,
        expectedToken: current.token,
        values: { [fields.owner.id]: text('bob') },
      }),
      AccessDenied,
      'moving a row outside the predicate is refused',
    );
    assert.deepEqual(
      (await service.read(ws.id, admin, { tableId: definition.id, revision, recordId: rows.adaDraft.id })).values[
        fields.owner.id
      ],
      text('ada'),
    );
    await assert.rejects(
      service.mutateThroughView(ws.id, app, {
        viewId: editor.id,
        parameters: { owner: 'ada' },
        kind: 'update',
        recordId: rows.bobPublic.id,
        expectedToken: rows.bobPublic.token,
        values: { [fields.title.id]: text('taken') },
      }),
      AccessDenied,
      'a row outside the predicate cannot be updated',
    );
    const updated = await service.mutateThroughView(ws.id, app, {
      ...edit,
      kind: 'update',
      recordId: rows.adaDraft.id,
      expectedToken: current.token,
      values: { [fields.published.id]: { kind: 'boolean', value: true } },
    });
    assert.equal(updated.values[fields.published.id].value, true);
    assert.deepEqual(
      (await service.read(ws.id, admin, { tableId: definition.id, revision, recordId: rows.adaDraft.id })).values[
        fields.secret.id
      ],
      text('secret adaDraft'),
      'fields outside the view are kept',
    );
    rows.adaDraft = updated;
    await assert.rejects(
      service.mutateThroughView(ws.id, app, {
        ...edit,
        kind: 'delete',
        recordId: rows.adaDraft.id,
        expectedToken: rows.adaDraft.token,
      }),
      AccessDenied,
      'delete is not among the actions',
    );
  });

  await t.test('a field added to the table later is excluded', async () => {
    const added = field('Added');
    const grown = { ...definition, fields: [...definition.fields, added] };
    const before = await maintenance(tx => activeGeneration(tx, definition.id));
    const records = await maintenance(tx => readRecords(tx, before, { after: null, limit: 100 }));
    const next = await maintenance(tx => createGeneration(tx, { definition: grown, revision: 'b'.repeat(40) }));
    for (const record of records)
      await maintenance(tx =>
        writeGenerationRecord(tx, {
          generationId: next.id,
          recordId: record.id,
          token: record.token,
          values: { ...record.values, [added.id]: text('new field') },
        }),
      );
    await maintenance(tx => activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: before.id }));
    const page = await list(app, edit);
    assert.ok(page.records.length > 0);
    assert.ok(page.records.every(record => !(added.id in record.values)));
    await assert.rejects(
      service.listThroughView(ws.id, app, { ...edit, query: { filters: [{ fieldId: added.id, op: 'not-null' }] } }),
      AccessDenied,
    );
  });

  await t.test('delete works only when allowed and only inside the predicate', async () => {
    const deleter = await as(admin, tx =>
      createDataView(tx, admin, {
        appId,
        tableId: definition.id,
        fieldIds: [fields.title.id],
        predicate: { all: [{ fieldId: fields.owner.id, op: 'eq', operand: { kind: 'value', value: 'bob' } }] },
        actions: ['read', 'delete'],
      }),
    );
    await as(admin, tx => shareDataView(tx, admin, { releaseId: live, viewId: deleter.id }));
    await as(approver, tx => approveDataView(tx, approver, { releaseId: live, viewId: deleter.id }));
    const remove = (record, viewId = deleter.id) =>
      service.mutateThroughView(ws.id, app, {
        viewId,
        kind: 'delete',
        recordId: record.id,
        expectedToken: record.token,
      });
    const [adaRow] = (await list(app, edit)).records;
    await assert.rejects(remove(adaRow), AccessDenied);
    const [bobRow] = (await service.listThroughView(ws.id, app, { viewId: deleter.id, query: {} })).records;
    assert.equal(await remove(bobRow), null);
    assert.equal((await service.listThroughView(ws.id, app, { viewId: deleter.id, query: {} })).records.length, 0);
  });

  await t.test('an archived table serves nothing', async () => {
    await db.platform.query(`UPDATE ${s}.tf_table_catalog SET archived_at=now() WHERE id=$1`, [definition.id]);
    await assert.rejects(list(app, edit), AccessDenied);
    await db.platform.query(`UPDATE ${s}.tf_table_catalog SET archived_at=NULL WHERE id=$1`, [definition.id]);
    assert.ok((await list(app, edit)).records.length > 0);
  });

  await t.test('an approval stops serving once the approver leaves', async () => {
    await db.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=now() WHERE id=$1`, [approver.membershipId]);
    await assert.rejects(list(), AccessDenied);
    assert.equal(
      (
        await db.platform.query(`SELECT count(*)::int AS n FROM ${s}.tf_app_data_view_grants WHERE approved_by=$1`, [
          approver.membershipId,
        ])
      ).rows[0].n,
      4,
      'the approval stays on record',
    );
  });

  await t.test('people keep their own access', async () => {
    const page = await service.listPage(ws.id, admin, {
      tableId: definition.id,
      revision: 'b'.repeat(40),
      query: { filters: [{ fieldId: fields.owner.id, op: 'eq', value: 'ada' }], limit: 50 },
    });
    assert.equal(page.total, '3');
    assert.ok(page.records.every(record => record.values[fields.owner.id].value === 'ada'));
    assert.ok(page.records.every(record => fields.secret.id in record.values));
    await assert.rejects(
      service.listPage(ws.id, member.userId, { tableId: definition.id, revision: 'b'.repeat(40), query: {} }),
      AccessDenied,
    );
    await assert.rejects(service.listPage(ws.id, app, { tableId: definition.id, revision: 'b'.repeat(40), query: {} }));
  });
});
