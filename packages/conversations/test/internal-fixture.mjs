import { randomUUID } from 'node:crypto';
import { createAgentExecutor } from '../../agents/src/executor.ts';
import { createConversationExecutor } from '../src/runtime.ts';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { conversationFixture, reverseReply } from './fixture.mjs';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { activateGeneration, createGeneration } from '../../tables/src/store.ts';
import { connect } from '../../workspace-storage/test/integration/fixture.mjs';

export async function internalFixture(extend = async stream => stream, prepareInitialAdmin) {
  const f = await conversationFixture(extend, prepareInitialAdmin);
  try {
    const stream = await extend(await workspaceTableMigrations());
    const { table, workspace: w, db } = f;
    const agentId = randomUUID(),
      teamId = randomUUID(),
      tableId = randomUUID(),
      command = randomUUID();
    const revision = 'a'.repeat(64),
      soul = 'b'.repeat(40);
    const definition = {
      name: 'Internal inspector',
      instructions: 'Inspect bounded resource',
      tools: ['schema.inspect'],
    };
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Internal runtime')`, [teamId]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agents')} (id,owning_team_id,display_name) VALUES ($1,$2,'Internal inspector')`,
      [agentId, teamId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
      [agentId, revision, definition],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input,status) VALUES ($1,$2,$3,$4,$1,'{}','accepted')`,
      [command, agentId, w.membershipId, w.userId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'fixture', $3)`,
      [soul, command, 'c'.repeat(64)],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
      [agentId, soul, revision],
    );
    await db.platform.query(`UPDATE ${table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [agentId, soul]);
    await db.platform.query(
      `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,'internal_records','raw-secret-resource',$3)`,
      [tableId, teamId, soul],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [teamId, tableId],
    );
    // Since #405 deleted v1 resource code, schema.inspect reads only a resource with an active formatVersion 2 generation.
    if (
      (await db.platform.query('SELECT to_regclass($1) IS NOT NULL AS present', [table('tf_table_generations')]))
        .rows[0].present
    ) {
      const applied = {
        formatVersion: 2,
        id: tableId,
        owningTeamId: teamId,
        label: 'raw-secret-resource',
        fields: [{ id: randomUUID(), label: 'Name', kind: 'text', required: false, maxLength: 100 }],
        uniqueKeys: [],
      };
      const migration = await connect(db.login(w, 'migration'));
      try {
        await inTransaction(migration, async client => {
          await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
          const tx = { client, schema: w.names.schema };
          const generation = await createGeneration(tx, { definition: applied, revision: soul });
          await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
          await client.query(
            `UPDATE ${table('tf_table_catalog')} SET applied_revision=$2, applied_definition=$3, physical_table=$4 WHERE id=$1`,
            [tableId, soul, applied, generation.physical_table],
          );
        });
      } finally {
        await migration.end();
      }
    }
    const executor = createAgentExecutor({ runtime: f.runtime });
    const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
    // The fixture actor invokes and manages through explicit grants. Admin status grants no agent access.
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      w.membershipId,
      teamId,
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read'),($1,$2,'invoke')`,
      [agentId, teamId],
    );
    await db.platform.query(
      `UPDATE ${table('tf_member_teams')} SET role='manager' WHERE membership_id=$1 AND team_id=$2`,
      [w.membershipId, teamId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage')`,
      [agentId, w.membershipId],
    );
    await executor.configure(w.id, actor, { agentId, version: 0, enabled: true, teamIds: [teamId], limits: scope });
    const { activationId } = await executor.activate(w.id, actor, { agentId, revision, scope });
    async function run(kind = 'linked') {
      let runId, origin;
      if (kind === 'autonomous') {
        const { scheduleId } = await executor.authorizeSchedule(w.id, actor, { activationId, scope });
        ({ runId } = await executor.startScheduled(w.id, { scheduleId, runId: randomUUID() }));
        origin = { kind: 'autonomous' };
      } else {
        ({ runId } = await executor.startDelegated(w.id, actor, { activationId, scope }));
        const conversationId = randomUUID();
        await f.store.create(w.id, w.userId, { chatId: conversationId, commandId: randomUUID() });
        const sent = await f.store.send(w.id, w.userId, conversationId, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: 'Inspect this privately' }],
        });
        const fence = await createConversationExecutor(f.runtime, reverseReply).claim({
          workspaceId: w.id,
          conversationId,
          turnId: sent.turnId,
          generation: 0,
        });
        origin = { kind: 'linked', conversationId, turnId: sent.turnId, generation: 0, epoch: fence.epoch };
      }
      const callId = randomUUID();
      await executor.queueCall(w.id, actor, { runId, callId, sequence: 0, call: { tool: 'schema.inspect', tableId } });
      return { workspaceId: w.id, runId, ownerId: randomUUID(), origin, callId };
    }
    return { ...f, stream, actor, executor, agentId, activationId, tableId, run };
  } catch (error) {
    await f.close();
    throw error;
  }
}
