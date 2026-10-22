import { randomUUID } from 'node:crypto';
import { createTableApprovalRequests, createTableApprovalResolver } from '../../tables/dist/conversation-approvals.js';
import { createConversationExecutor } from '../src/runtime.ts';
import { reverseReply } from './fixture.mjs';
import { createInternalConversations } from '../src/internal.ts';
import { requestFixture } from './request-fixture.mjs';

export async function approvalFixture(extend, prepareInitialAdmin) {
  const f = await requestFixture(extend, prepareInitialAdmin);
  try {
    const w = f.workspace,
      table = f.table;
    await f.db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1`, ['b'.repeat(40)]);
    const requests = createTableApprovalRequests(f.runtime);
    const options = { runtime: f.runtime, resolveConfirmationCredential: async () => f.db.login(w, 'confirmation') };
    const resolver = createTableApprovalResolver(options);
    const maintenance = {
      async execute(_workspaceId, migrationId) {
        const rows = (
          await f.db.platform.query(
            `SELECT (SELECT count(*) FROM ${table('tf_confirmations')} WHERE migration_id=$1)::int AS confirmed, (SELECT count(*) FROM ${table('tf_table_controls')} WHERE migration_id=$1 AND operation='reject')::int AS rejected`,
            [migrationId],
          )
        ).rows[0];
        const status = rows.confirmed ? 'applied' : rows.rejected ? 'rejected' : 'waiting_for_confirmation';
        if (status !== 'waiting_for_confirmation')
          await f.db.platform.query(`UPDATE ${table('tf_migration_jobs')} SET status=$2 WHERE id=$1`, [
            migrationId,
            status,
          ]);
        return { status };
      },
    };
    async function pending() {
      const tableId = randomUUID(),
        fieldId = randomUUID(),
        teamId = randomUUID();
      await f.db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,$2)`, [
        teamId,
        `Approvals ${teamId}`,
      ]);
      const revision = 'a'.repeat(40),
        targetRevision = 'c'.repeat(40),
        migrationId = randomUUID(),
        commandId = randomUUID(),
        planDigest = 'd'.repeat(64);
      await f.db.platform.query(
        `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision,applied_revision) VALUES ($1,$2,$3,'Approval records',$4,$5)`,
        [tableId, teamId, `r_${tableId.replaceAll('-', '')}`.slice(0, 40), targetRevision, revision],
      );
      await f.db.platform.query(
        `INSERT INTO ${table('tf_authoring_commands')} (id,membership_id,table_id,request_id,change,status) VALUES ($1,$2,$3,$4,'{}','accepted')`,
        [commandId, w.membershipId, tableId, randomUUID()],
      );
      const commonVersion = (
        await f.db.platform.query(`SELECT count(*)::int AS n FROM ${table('tf_common_migrations')}`)
      ).rows[0].n;
      const plan = {
        digest: planDigest,
        commonVersion,
        targetRevision,
        workspaceSchema: w.names.schema,
        impact: { rowCount: 1, fieldIds: [fieldId] },
      };
      await f.db.platform.query(
        `INSERT INTO ${table('tf_migration_jobs')} (id,table_id,command_id,membership_id,target_revision,expected_applied_revision,status,plan,plan_digest,planner_version,common_version) VALUES ($1,$2,$3,$4,$5,$6,'waiting_for_confirmation',$7,$8,1,$9)`,
        [migrationId, tableId, commandId, w.membershipId, targetRevision, revision, plan, planDigest, commonVersion],
      );
      const agentTeam = (
        await f.db.platform.query(`SELECT owning_team_id FROM ${table('tf_agents')} WHERE id=$1`, [f.agentId])
      ).rows[0].owning_team_id;
      const scope = [{ assetId: tableId, permissions: ['table.schema.manage'] }];
      await f.db.platform.query(
        `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.schema.manage')`,
        [agentTeam, tableId],
      );
      const version = (
        await f.db.platform.query(`SELECT policy_version FROM ${table('tf_agents')} WHERE id=$1`, [f.agentId])
      ).rows[0].policy_version;
      await f.executor.configure(w.id, f.actor, {
        agentId: f.agentId,
        version,
        enabled: true,
        teamIds: [agentTeam],
        limits: scope,
      });
      const { activationId } = await f.executor.activate(w.id, f.actor, {
        agentId: f.agentId,
        revision: 'a'.repeat(64),
        scope,
      });
      const { runId } = await f.executor.startDelegated(w.id, f.actor, { activationId, scope });
      const conversationId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId: conversationId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, conversationId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'Change the schema' }],
      });
      const reply = await createConversationExecutor(f.runtime, reverseReply).claim({
        workspaceId: w.id,
        conversationId,
        turnId: sent.turnId,
        generation: 0,
      });
      const fence = await createInternalConversations(f.runtime).claim({
        workspaceId: w.id,
        runId,
        ownerId: randomUUID(),
        origin: { kind: 'linked', conversationId, turnId: sent.turnId, generation: 0, epoch: reply.epoch },
      });
      const input = { producerId: randomUUID(), prompt: 'Remove this field?', migrationId, planDigest };
      const request = await requests.create(fence, input);
      return { ...request, fence, input, conversationId, migrationId, planDigest, tableId };
    }
    async function humanAuthority(tableId, granted) {
      await f.db.platform.query(`UPDATE ${table('tf_memberships')} SET role=$2 WHERE id=$1`, [
        w.membershipId,
        granted ? 'admin' : 'member',
      ]);
      if (granted)
        await f.db.platform.query(
          `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) SELECT owning_team_id,$1,'table.schema.manage' FROM ${table('tf_agents')} WHERE id=$2 ON CONFLICT DO NOTHING`,
          [tableId, f.agentId],
        );
      else
        await f.db.platform.query(
          `DELETE FROM ${table('tf_grants')} WHERE asset_id=$1 AND permission='table.schema.manage' AND team_id=(SELECT owning_team_id FROM ${table('tf_agents')} WHERE id=$2)`,
          [tableId, f.agentId],
        );
    }
    return { ...f, requests, resolver, options, maintenance, pending, humanAuthority };
  } catch (error) {
    await f.close();
    throw error;
  }
}
