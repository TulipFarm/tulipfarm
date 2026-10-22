import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { reserveTableIdentities, reserveDefinitionNames } from '../../src/identities.ts';
import { definitionSchema } from '../../src/definition.ts';

test(
  'permanent table names serialize collisions, survive retry and reject storage mutation',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const ws = await db.create(),
      s = `"${ws.names.schema}"`;
    runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const run = action => runtime.transaction(ws.id, commonCompatibility, action);
    const first = randomUUID(),
      second = randomUUID(),
      third = randomUUID(),
      team = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
    const reserve = (id, label = 'Tickets') => run(tx => reserveTableIdentities(tx, [{ id, label }]));
    assert.equal((await reserve(first)).get(first).name, 'tickets');
    assert.equal((await reserve(first)).get(first).name, 'tickets');
    await Promise.all([reserve(second), reserve(third)]);
    const saved = (await db.platform.query(`SELECT name FROM ${s}.tf_table_names ORDER BY name`)).rows.map(
      row => row.name,
    );
    assert.deepEqual(saved, ['tickets', 'tickets_2', 'tickets_3']);
    await assert.rejects(reserve(first, 'Changed'), error => error.code === 'table-title-immutable');
    await assert.rejects(
      db.platform.query(`UPDATE ${s}.tf_table_names SET name='changed' WHERE table_id=$1`, [first]),
      /table-identity-immutable/,
    );
    await assert.rejects(
      db.platform.query(`DELETE FROM ${s}.tf_table_names WHERE table_id=$1`, [first]),
      /table-identity-immutable/,
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_table_catalog(id,owning_team_id,physical_table,display_name,target_revision) VALUES($1,$2,'test_table','Tickets',$3)`,
      [first, team, 'a'.repeat(40)],
    );
    await assert.rejects(
      run(tx => tx.client.query(`UPDATE ${s}.tf_table_catalog SET display_name='Changed' WHERE id=$1`, [first])),
      /table-title-immutable/,
    );
    await db.platform.query(`UPDATE ${s}.tf_table_catalog SET archived_at=clock_timestamp() WHERE id=$1`, [first]);
    const fourth = randomUUID();
    assert.equal((await reserve(fourth)).get(fourth).name, 'tickets_4');
    const unicode = randomUUID();
    assert.equal((await reserve(unicode, 'Café 東京')).get(unicode).name, 'café_東京');
    const definition = definitionSchema.parse({
      formatVersion: 2,
      id: first,
      owningTeamId: team,
      label: 'Tickets',
      fields: [],
      uniqueKeys: [],
    });
    assert.deepEqual(await run(tx => reserveDefinitionNames(tx, definition)), { [first]: 'tickets' });
    await assert.rejects(
      run(tx => reserveDefinitionNames(tx, { ...definition, label: 'Changed' })),
      error => error.code === 'table-title-immutable',
    );
  },
);
