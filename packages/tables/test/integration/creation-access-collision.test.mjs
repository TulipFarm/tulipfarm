import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createGeneration } from '@tulipfarm/tables/store';
import { connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { creationAccessFixture, seedDestination } from './creation-access-fixture.mjs';
import { createTableWithRows, tableDefinition } from '../fixture.mjs';

let fixture;
before(async () => {
  fixture = await creationAccessFixture();
});

test(
  'table creation rejects owning-team and other non-table asset IDs before inserting a catalog entry',
  { timeout: 60000 },
  async () => {
    const { db, workspace, s, team, propose } = fixture;
    const other = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Other team')`, [other]);
    const destination = await seedDestination(fixture),
      nonTableGrant = randomUUID();
    await db.platform.query(
      `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'slack.message.send')`,
      [team, nonTableGrant],
    );
    for (const id of [team, other, destination, nonTableGrant]) {
      const definition = tableDefinition({ owningTeamId: team, id });
      await assert.rejects(propose(definition), error => error.code === 'proposal-conflict');
      await assert.rejects(
        withMaintenanceTransaction({
          workspaceId: workspace.id,
          connectionString: db.login(workspace, 'migration'),
          capability: 'migration',
          operation: tx => createGeneration(tx, { definition, revision: 'b'.repeat(40) }),
        }),
        error => error.code === 'invalid-generation',
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int n FROM ${s}.tf_table_catalog WHERE id=$1`, [id])).rows[0].n,
        0,
      );
    }
    const activation = await connect(db.login(workspace, 'migration'));
    try {
      await activation.query(`SET ROLE "${workspace.names.customOwner}"`);
      assert.equal(
        (await activation.query(`SELECT id FROM ${s}.tf_slack_destinations WHERE id=$1`, [destination])).rowCount,
        1,
      );
      await assert.rejects(
        activation.query(`SELECT name FROM ${s}.tf_slack_destinations WHERE id=$1`, [destination]),
        error => error.code === '42501',
      );
    } finally {
      await activation.end();
    }
  },
);

test(
  'the privileged activation helper independently refuses team and other non-table asset IDs',
  { timeout: 60000 },
  async () => {
    const { db, workspace, s, team, runtime, creator, teammate, propose, approve, advance, publish, permitted } =
      fixture;
    const existing = await createTableWithRows({
      db,
      workspace,
      runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'Existing records' }),
    });
    for (const kind of ['team', 'destination', 'grant']) {
      const definition = tableDefinition({ owningTeamId: team, label: `${kind} records` }),
        proposal = await propose(definition);
      await approve(proposal);
      assert.equal(await advance(workspace.id, proposal.id), 'publish');
      await publish(workspace.id, proposal.id);
      assert.equal(await advance(workspace.id, proposal.id), 'more');
      if (kind === 'team') {
        await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Colliding team')`, [definition.id]);
        await db.platform.query(`UPDATE ${s}.tf_table_catalog SET owning_team_id=$2 WHERE id=$1`, [
          existing.tableId,
          definition.id,
        ]);
      } else if (kind === 'destination') await seedDestination(fixture, definition.id);
      else
        await db.platform.query(
          `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'slack.message.send')`,
          [team, definition.id],
        );
      for (const actor of [creator, teammate]) assert.equal(await permitted(actor, existing.tableId), false);
      const job = (
        await db.platform.query(`SELECT id,target_generation FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [
          proposal.id,
        ])
      ).rows[0];
      const activation = await connect(db.login(workspace, 'migration'));
      try {
        await activation.query('BEGIN');
        await activation.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
        await activation.query(
          `UPDATE ${s}.tf_table_generations SET state='active',activated_at=clock_timestamp() WHERE id=$1`,
          [job.target_generation],
        );
        await activation.query(
          `UPDATE ${s}.tf_table_catalog c SET applied_revision=g.revision,applied_definition=g.definition,physical_table=g.physical_table
       FROM ${s}.tf_table_generations g WHERE c.id=g.table_id AND g.id=$1`,
          [job.target_generation],
        );
        await assert.rejects(
          activation.query(`SELECT ${s}.tf_table_creation_access($1)`, [job.id]),
          error => error.code === '42501',
        );
      } finally {
        await activation.query('ROLLBACK');
        await activation.end();
      }
      for (const actor of [creator, teammate])
        for (const permission of ['table.row.read', 'table.schema.manage'])
          assert.equal(await permitted(actor, existing.tableId, permission), false);
    }
  },
);
