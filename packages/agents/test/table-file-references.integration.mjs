import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { humanReadableTableFiles } from '../src/table-sources.ts';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { savedTaskAgent, seedExecution } from './task-fixture.mjs';

async function fileTable(t) {
  const db = await fixture();
  let runtime, migration;
  t.after(async () => {
    await migration?.end();
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
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
    member = randomUUID(),
    reader = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
  await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [member, reader]);
  await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [member, team]);
  const ownFile = randomUUID(),
    trashedFile = randomUUID(),
    folder = randomUUID(),
    nestedFile = randomUUID(),
    othersFile = randomUUID();
  const insertFile = (id, creator, parent = null) =>
    db.platform.query(
      `INSERT INTO ${s}.tf_files(id,kind,name,parent_id,creator_membership_id,ready,object_key,size,media_type,sha256) VALUES($1,'file','File',$2,$3,true,$4,1,'text/plain',$5)`,
      [id, parent, creator, randomUUID(), 'a'.repeat(64)],
    );
  await db.platform.query(
    `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready) VALUES($1,'folder','Folder',$2,true)`,
    [folder, member],
  );
  await insertFile(ownFile, member);
  await insertFile(trashedFile, member);
  await insertFile(nestedFile, member, folder);
  await insertFile(othersFile, ws.membershipId);

  const revision = 'b'.repeat(40);
  const title = { id: randomUUID(), label: 'Title', kind: 'text', required: false, maxLength: 10000 };
  const files = {
    id: randomUUID(),
    label: 'Files',
    kind: 'file',
    required: false,
    cardinality: 'many',
    access: 'independent',
  };
  const extra = {
    id: randomUUID(),
    label: 'Extra',
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
    fields: [title, files, extra],
    uniqueKeys: [],
  };
  await inTransaction(migration, async client => {
    await client.query(`SET LOCAL ROLE "${ws.names.customOwner}"`);
    const generation = await createGeneration({ client, schema: ws.names.schema }, { definition, revision });
    await activateGeneration(
      { client, schema: ws.names.schema },
      { generationId: generation.id, expectedActiveGenerationId: null },
    );
    await client.query(
      `UPDATE ${s}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3,physical_table=$4 WHERE id=$1`,
      [definition.id, revision, definition, generation.physical_table],
    );
  });
  for (const permission of ['read', 'create', 'update'])
    await db.platform.query(`INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,$3)`, [
      team,
      definition.id,
      `table.row.${permission}`,
    ]);

  const seed = createTableService(
    runtime,
    { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
    executionCompatibility,
  );
  return {
    db,
    ws,
    s,
    runtime,
    seed,
    team,
    member,
    reader,
    revision,
    title,
    files,
    extra,
    tableId: definition.id,
    ownFile,
    trashedFile,
    folder,
    nestedFile,
    othersFile,
  };
}

test(
  'unavailable file references are marked on reads and only newly added references need file access',
  { timeout: 120000 },
  async t => {
    const {
      db,
      ws,
      s,
      runtime,
      seed,
      reader,
      revision,
      title,
      files,
      extra,
      tableId,
      ownFile,
      trashedFile,
      folder,
      nestedFile,
      othersFile,
    } = await fileTable(t);
    const service = createTableService(runtime, { readableFiles: humanReadableTableFiles }, executionCompatibility);
    const referenced = [ownFile, trashedFile, nestedFile, othersFile].sort();
    const brokenId = randomUUID(),
      healthyId = randomUUID();
    const [first, second] = [brokenId, healthyId].sort();
    const broken = await seed.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId,
      revision,
      recordId: brokenId,
      values: { [title.id]: { kind: 'text', value: 'Broken' }, [files.id]: { kind: 'file', fileIds: referenced } },
    });
    await seed.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId,
      revision,
      recordId: healthyId,
      values: { [title.id]: { kind: 'text', value: 'Healthy' }, [files.id]: { kind: 'file', fileIds: [ownFile] } },
    });
    await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=now() WHERE id=ANY($1::uuid[])`, [
      [trashedFile, folder],
    ]);

    const unavailable = [trashedFile, nestedFile, othersFile].sort();
    const markers = records =>
      Object.fromEntries(records.map(record => [record.id, record.unavailableFileIds ?? null]));
    const expectedMarkers = { [brokenId]: unavailable, [healthyId]: null };

    const listed = await service.list(ws.id, reader, { tableId, revision });
    assert.deepEqual(
      listed.map(record => record.id),
      [first, second],
    );
    assert.deepEqual(markers(listed), expectedMarkers);
    assert.deepEqual(listed.find(record => record.id === brokenId).values[files.id], {
      kind: 'file',
      fileIds: referenced,
    });
    const page = (await service.listPage(ws.id, reader, { tableId, revision, query: { filters: [], limit: 10 } }))
      .records;
    assert.deepEqual(markers(page), expectedMarkers);
    assert.deepEqual(
      page.map(record => record.token),
      listed.map(record => record.token),
    );
    const read = await service.read(ws.id, reader, { tableId, revision, recordId: brokenId });
    assert.deepEqual(read.unavailableFileIds, unavailable);
    assert.deepEqual(read.values[files.id], { kind: 'file', fileIds: referenced });
    const history = await service.history(ws.id, reader, { tableId, recordId: brokenId });
    assert.deepEqual(
      history.map(entry => [entry.operation, entry.unavailable_file_ids]),
      [['create', unavailable]],
    );

    const retitled = await service.mutate(ws.id, reader, {
      kind: 'update',
      tableId,
      revision,
      recordId: brokenId,
      expectedToken: broken.token,
      values: { [title.id]: { kind: 'text', value: 'Retitled' } },
    });
    assert.deepEqual((await service.read(ws.id, reader, { tableId, revision, recordId: brokenId })).values[title.id], {
      kind: 'text',
      value: 'Retitled',
    });
    await assert.rejects(
      service.mutate(ws.id, reader, {
        kind: 'update',
        tableId,
        revision,
        recordId: brokenId,
        expectedToken: retitled.token,
        values: { [extra.id]: { kind: 'file', fileIds: [othersFile] } },
      }),
      AccessDenied,
    );
    await assert.rejects(
      service.mutate(ws.id, reader, {
        kind: 'create',
        tableId,
        revision,
        recordId: randomUUID(),
        values: { [files.id]: { kind: 'file', fileIds: [trashedFile] } },
      }),
      AccessDenied,
    );

    const cleaned = await service.mutate(ws.id, reader, {
      kind: 'update',
      tableId,
      revision,
      recordId: brokenId,
      expectedToken: retitled.token,
      values: { [files.id]: { kind: 'file', fileIds: [ownFile] } },
    });
    const after = await service.read(ws.id, reader, { tableId, revision, recordId: brokenId });
    assert.deepEqual(
      [after.values[files.id], after.unavailableFileIds ?? null],
      [{ kind: 'file', fileIds: [ownFile] }, null],
    );
    const created = (await service.history(ws.id, reader, { tableId, recordId: brokenId })).find(
      entry => entry.operation === 'create',
    );
    await assert.rejects(
      service.mutate(ws.id, reader, {
        kind: 'restore',
        tableId,
        revision,
        recordId: brokenId,
        expectedToken: cleaned.token,
        historyId: created.id,
      }),
      AccessDenied,
    );
  },
);

test(
  'a page of rows checks its file references in one query and counts rows only on the first page',
  { timeout: 120000 },
  async t => {
    const { db, ws, s, runtime, seed, member, reader, revision, files, tableId } = await fileTable(t);
    const readable = [],
      hidden = [];
    for (let index = 0; index < 30; index++) {
      const id = randomUUID();
      await db.platform.query(
        `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready,object_key,size,media_type,sha256) VALUES($1,'file','File',$2,true,$3,1,'text/plain',$4)`,
        [id, index % 3 ? member : ws.membershipId, randomUUID(), 'a'.repeat(64)],
      );
      (index % 3 ? readable : hidden).push(id);
      await seed.mutate(ws.id, ws.userId, {
        kind: 'create',
        tableId,
        revision,
        recordId: randomUUID(),
        values: { [files.id]: { kind: 'file', fileIds: [id] } },
      });
    }
    const statements = [];
    const counted = {
      transaction: (id, range, operation) =>
        runtime.transaction(id, range, tx =>
          operation({
            ...tx,
            client: new Proxy(tx.client, {
              get: (target, key) =>
                key === 'query'
                  ? (...args) => {
                      statements.push(String(args[0]?.text ?? args[0]));
                      return target.query(...args);
                    }
                  : typeof target[key] === 'function'
                    ? target[key].bind(target)
                    : target[key],
            }),
          }),
        ),
    };
    const records = createAgentRecordTools(counted);
    const fileQueries = () => statements.filter(sql => sql.includes('tf_table_file_allowed')).length;
    const countQueries = () => statements.filter(sql => /count\(/.test(sql)).length;

    const first = await records.listRecords(ws.id, reader, tableId, revision, { limit: 20 });
    assert.deepEqual([first.records.length, first.total, fileQueries(), countQueries()], [20, '30', 1, 1]);
    statements.length = 0;
    const second = await records.listRecords(ws.id, reader, tableId, revision, { after: first.nextCursor, limit: 20 });
    assert.deepEqual(
      [second.records.length, second.total, second.nextCursor, fileQueries(), countQueries()],
      [10, null, null, 1, 0],
    );
    const marked = Object.fromEntries(
      [...first.records, ...second.records].map(record => [
        record.values[files.id].fileIds[0],
        record.unavailableFileIds ?? null,
      ]),
    );
    assert.deepEqual(marked, Object.fromEntries([...readable.map(id => [id, null]), ...hidden.map(id => [id, [id]])]));
  },
);

test(
  'scheduled agent runs mark file values their sponsor cannot open and fail closed without a sponsor',
  { timeout: 120000 },
  async t => {
    const { db, ws, s, runtime, seed, team, member, reader, revision, files, tableId, ownFile, othersFile } =
      await fileTable(t);
    const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
    const agent = await savedTaskAgent(db, ws, runtime, reader, member, [], ['rows.list']);
    await seedExecution(db, ws, agent.agentId, [team], scope);
    async function scheduledRun(sponsor) {
      const activationId = randomUUID(),
        scheduleId = randomUUID(),
        runId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${s}.tf_agent_activations(id,agent_id,definition_revision,scope) VALUES($1,$2,$3,$4)`,
        [activationId, agent.agentId, agent.revision, JSON.stringify(scope)],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_agent_schedules(id,activation_id,scope,sponsor_membership_id) VALUES($1,$2,$3,$4)`,
        [scheduleId, activationId, JSON.stringify(scope), sponsor],
      );
      await db.platform.query(
        `INSERT INTO ${s}.tf_agent_runs(id,agent_id,activation_id,definition_revision,kind,schedule_id,scope,sponsor_membership_id) VALUES($1,$2,$3,$4,'scheduled',$5,$6,$7)`,
        [runId, agent.agentId, activationId, agent.revision, scheduleId, JSON.stringify(scope), sponsor],
      );
      return { kind: 'agent', runId };
    }
    const visibleId = randomUUID(),
      hiddenId = randomUUID();
    await seed.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId,
      revision,
      recordId: visibleId,
      values: { [files.id]: { kind: 'file', fileIds: [ownFile] } },
    });
    await seed.mutate(ws.id, ws.userId, {
      kind: 'create',
      tableId,
      revision,
      recordId: hiddenId,
      values: { [files.id]: { kind: 'file', fileIds: [othersFile] } },
    });
    const records = createAgentRecordTools(runtime);

    const sponsored = await scheduledRun(member);
    assert.deepEqual((await records.getRecord(ws.id, sponsored, tableId, revision, visibleId)).values[files.id], {
      kind: 'file',
      fileIds: [ownFile],
    });
    const hidden = await records.getRecord(ws.id, sponsored, tableId, revision, hiddenId);
    assert.deepEqual(
      [hidden.values[files.id], hidden.unavailableFileIds],
      [{ kind: 'file', fileIds: [othersFile] }, [othersFile]],
    );
    const listed = (await records.listRecords(ws.id, sponsored, tableId, revision, {})).records;
    assert.deepEqual(Object.fromEntries(listed.map(record => [record.id, record.unavailableFileIds ?? null])), {
      [visibleId]: null,
      [hiddenId]: [othersFile],
    });
    const unsponsored = await scheduledRun(null);
    await assert.rejects(records.getRecord(ws.id, unsponsored, tableId, revision, visibleId), AccessDenied);
    await assert.rejects(records.listRecords(ws.id, unsponsored, tableId, revision, {}), AccessDenied);
  },
);
