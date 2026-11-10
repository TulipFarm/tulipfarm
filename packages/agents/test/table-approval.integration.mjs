import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { fixture, connect, denied, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { applyCommonMigrations, inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';
import { tableExecutionAccess } from '../../../apps/worker/src/table-access.ts';
import { createChatTools } from '../src/tools.ts';
import { createChatTableProposals, tableProposalOptions } from '../src/table-proposals.ts';
import { AccessDenied } from '@tulipfarm/access';
import { createConversationRequests } from '../../conversations/src/requests.ts';

test('chat table approvals recheck workspace skill access under storage roles', { timeout: 60000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const stream = await workspaceTableMigrations();
  const upgrade = stream.findIndex(item => item.name === '0058_table_skill_source_access.sql');
  assert.ok(upgrade > 0);
  const ws = await db.create(stream.slice(0, upgrade));
  const s = `"${ws.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const team = randomUUID(),
    conversationId = randomUUID(),
    turnId = randomUUID(),
    messageId = randomUUID(),
    skillId = randomUUID(),
    revision = 'b'.repeat(64);
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Operations')`, [team]);
  await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
  await db.platform.query(`INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`, [
    conversationId,
    actor.userId,
    actor.membershipId,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [messageId, conversationId, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turnId, conversationId, messageId],
  );
  await db.platform.query('BEGIN');
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skills(id,creator_id,saved_revision,active_revision,enabled) VALUES($1,$2,$3,$3,true)`,
    [skillId, actor.membershipId, revision],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skill_revisions(skill_id,revision,definition,author_id) VALUES($1,$2,$3,$4)`,
    [
      skillId,
      revision,
      { name: 'Table procedure', instructions: 'Create the requested table.', sources: [] },
      actor.membershipId,
    ],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skill_reviews(skill_id,revision,reviewer_id) VALUES($1,$2,$3)`,
    [skillId, revision, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read')`,
    [skillId, actor.membershipId],
  );
  await db.platform.query('COMMIT');
  const tools = createChatTools(runtime);
  const proposals = createChatTableProposals(runtime);
  const decisions = createTableProposalDecisions({
    ...tableProposalOptions(runtime),
    resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
  });
  const advance = createTableExecution({
    ...tableExecutionAccess,
    resolveMigrationCredential: async () => db.login(ws, 'migration'),
  });
  let publication = 0;
  const publish = createTablePublication({
    runtime,
    ...tableExecutionAccess,
    prepareRevision: async input => ({
      commit: (++publication).toString(16).padStart(40, '0'),
      parentCommit: input.expectedParentCommit,
      bundle: { key: `test/${input.commandId}`, sha256: 'c'.repeat(64) },
      projection: { definition: input.definition },
    }),
  });
  async function propose(sources = [], approve = true, tableId = randomUUID()) {
    const result = (
      await tools.invokeWithSources(
        { workspaceId: ws.id, actor, callId: randomUUID(), origin: { conversationId, turnId, sources } },
        {
          tool: 'tables.propose',
          input: JSON.stringify({
            plans: [
              {
                kind: 'schema',
                tableId,
                expectedRevision: null,
                dependsOn: [],
                target: {
                  formatVersion: 2,
                  id: tableId,
                  owningTeamId: team,
                  label: `Records ${tableId}`,
                  fields: [],
                  uniqueKeys: [],
                },
                transforms: { outputs: [] },
              },
            ],
          }),
        },
      )
    ).result;
    assert.equal(result.status, 'pending');
    if (approve)
      await decisions.decide(ws.id, actor, conversationId, result.id, {
        digest: result.digest,
        commandId: randomUUID(),
        decision: 'approve',
      });
    return { ...result, tableId };
  }
  async function finish(proposal) {
    for (let i = 0; i < 10; i++) {
      const state = await advance(ws.id, proposal.id);
      if (state === 'completed' || state === 'blocked') return state;
      if (state === 'publish') await publish(ws.id, proposal.id);
    }
    assert.fail('table execution did not finish');
  }
  async function expectCreated(proposal) {
    assert.equal(await finish(proposal), 'completed');
    assert.equal((await proposals.status(ws.id, actor.userId, conversationId, proposal.id)).status, 'completed');
    assert.ok(
      (await db.platform.query(`SELECT applied_revision FROM ${s}.tf_table_catalog WHERE id=$1`, [proposal.tableId]))
        .rows[0].applied_revision,
    );
  }
  async function expectBlocked(proposal, code = 'access-denied') {
    assert.equal(await finish(proposal), 'blocked');
    const status = await proposals.status(ws.id, actor.userId, conversationId, proposal.id);
    assert.equal(status.status, 'failed');
    assert.equal(status.plans[0].receipt.code, code);
    assert.equal(
      (await db.platform.query(`SELECT 1 FROM ${s}.tf_table_catalog WHERE id=$1`, [proposal.tableId])).rowCount,
      0,
    );
  }
  const skill = { kind: 'workspace-skill', skillId, revision };
  await t.test('existing workspaces gain only the skill-check columns on upgrade', async () => {
    const previous = ws;
    const schema = `"${previous.names.schema}"`;
    const client = await connect(db.login(previous, 'migration'));
    try {
      await denied(client, `SELECT id,enabled FROM ${schema}.tf_workspace_skills`);
      await inTransaction(db.platform, tx => applyCommonMigrations(tx, previous.id, stream));
      for (const role of [previous.names.migration, previous.names.customOwner]) {
        await client.query(`SET ROLE "${role}"`);
        await client.query(`SELECT id,enabled FROM ${schema}.tf_workspace_skills`);
        await client.query(`SELECT skill_id,revision FROM ${schema}.tf_workspace_skill_reviews`);
        await client.query(`SELECT skill_id,membership_id,permission FROM ${schema}.tf_skill_person_grants`);
        await client.query(`SELECT skill_id,team_id,permission FROM ${schema}.tf_skill_team_grants`);
        await denied(client, `SELECT creator_id FROM ${schema}.tf_workspace_skills`);
        await denied(client, `SELECT reviewer_id FROM ${schema}.tf_workspace_skill_reviews`);
        await denied(client, `UPDATE ${schema}.tf_workspace_skills SET enabled=false`);
        await denied(client, `DELETE FROM ${schema}.tf_skill_person_grants`);
        await client.query('RESET ROLE');
      }
    } finally {
      await client.end();
    }
  });
  await t.test('plain creation applies after approval', async () => {
    await expectCreated(await propose());
  });
  await t.test('a readable enabled workspace skill can inform an approved table', async () => {
    await expectCreated(await propose([skill]));
  });
  await t.test('revoked skill read access blocks execution', async () => {
    const proposal = await propose([skill]);
    await db.platform.query(`DELETE FROM ${s}.tf_skill_person_grants WHERE skill_id=$1`, [skillId]);
    try {
      await expectBlocked(proposal);
    } finally {
      await db.platform.query(
        `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read')`,
        [skillId, actor.membershipId],
      );
    }
  });
  await t.test('team skill read access is honored and its revocation blocks execution', async () => {
    await db.platform.query(`DELETE FROM ${s}.tf_skill_person_grants WHERE skill_id=$1`, [skillId]);
    await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
      actor.membershipId,
      team,
    ]);
    await db.platform.query(`INSERT INTO ${s}.tf_skill_team_grants(skill_id,team_id,permission) VALUES($1,$2,'read')`, [
      skillId,
      team,
    ]);
    try {
      await expectCreated(await propose([skill]));
      const proposal = await propose([skill]);
      await db.platform.query(`DELETE FROM ${s}.tf_skill_team_grants WHERE skill_id=$1`, [skillId]);
      await expectBlocked(proposal);
    } finally {
      await db.platform.query(`DELETE FROM ${s}.tf_skill_team_grants WHERE skill_id=$1`, [skillId]);
      await db.platform.query(`DELETE FROM ${s}.tf_member_teams WHERE membership_id=$1 AND team_id=$2`, [
        actor.membershipId,
        team,
      ]);
      await db.platform.query(
        `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read')`,
        [skillId, actor.membershipId],
      );
    }
  });
  await t.test('a disabled skill blocks execution', async () => {
    const proposal = await propose([skill]);
    await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=false WHERE id=$1`, [skillId]);
    try {
      await expectBlocked(proposal);
    } finally {
      await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=true WHERE id=$1`, [skillId]);
    }
  });
  await t.test('disabled procedures preserve review history and the same pending approval can recover', async () => {
    const completed = await propose([skill]);
    await expectCreated(completed);
    const failed = await propose([skill]);
    const pending = await propose([skill], false);
    const rejected = await propose([skill], false);
    await decisions.decide(ws.id, actor, conversationId, rejected.id, {
      digest: rejected.digest,
      commandId: randomUUID(),
      decision: 'reject',
    });
    const expired = await propose([skill], false);
    await db.platform.query(
      `UPDATE ${s}.tf_table_proposals SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1`,
      [expired.id],
    );
    const superseded = await propose([skill], false);
    await propose([skill], false, superseded.tableId);
    const approved = await propose([skill]);
    const running = await propose([skill]);
    assert.equal(await advance(ws.id, running.id), 'publish');
    const cancelled = await propose([skill]);
    await decisions.control(ws.id, actor, conversationId, cancelled.id, {
      digest: cancelled.digest,
      commandId: randomUUID(),
      operation: 'cancel',
    });
    const history = [
      [completed, 'completed', undefined],
      [failed, 'failed', 'skill-unavailable'],
      [pending, 'pending', 'skill-unavailable'],
      [cancelled, 'cancelled', 'skill-unavailable'],
      [rejected, 'rejected', undefined],
      [expired, 'expired', undefined],
      [superseded, 'superseded', undefined],
      [approved, 'approved', undefined],
      [running, 'running', undefined],
    ];
    await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=false WHERE id=$1`, [skillId]);
    try {
      await expectBlocked(failed);
      for (const [proposal, status, blockedReason] of history) {
        assert.deepEqual(await proposals.outcome(ws.id, actor.userId, conversationId, proposal.id), {
          kind: 'proposal',
        });
        const view = await proposals.read(ws.id, actor.userId, conversationId, proposal.id);
        assert.equal(view.content, 'available');
        assert.equal(view.status, status);
        assert.equal(view.blockedReason, blockedReason, status);
      }
      await db.platform.query(
        `UPDATE ${s}.tf_table_proposals SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1`,
        [cancelled.id],
      );
      const expiredCancellation = await proposals.read(ws.id, actor.userId, conversationId, cancelled.id);
      assert.equal(expiredCancellation.status, 'cancelled');
      assert.equal(expiredCancellation.expired, true);
      assert.equal(expiredCancellation.blockedReason, undefined);
      await assert.rejects(
        decisions.decide(ws.id, actor, conversationId, pending.id, {
          digest: pending.digest,
          commandId: randomUUID(),
          decision: 'approve',
        }),
        error => error.code === 'skill-unavailable',
      );
      await db.platform.query(`DELETE FROM ${s}.tf_skill_person_grants WHERE skill_id=$1`, [skillId]);
      try {
        for (const [proposal] of history)
          await assert.rejects(proposals.read(ws.id, actor.userId, conversationId, proposal.id), AccessDenied);
      } finally {
        await db.platform.query(
          `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read')`,
          [skillId, actor.membershipId],
        );
      }
    } finally {
      await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=true WHERE id=$1`, [skillId]);
    }
    assert.equal((await proposals.read(ws.id, actor.userId, conversationId, pending.id)).blockedReason, undefined);
    await decisions.decide(ws.id, actor, conversationId, pending.id, {
      digest: pending.digest,
      commandId: randomUUID(),
      decision: 'approve',
    });
    await expectCreated(pending);
    await decisions.control(ws.id, actor, conversationId, failed.id, {
      digest: failed.digest,
      commandId: randomUUID(),
      operation: 'resume',
    });
    await expectCreated(failed);
  });
  await t.test('a retained team answer stays readable when its procedure is disabled', async () => {
    const callId = randomUUID(),
      requestId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,sequence,tool,status) VALUES($1,$2,$3,1,'present.choice','completed')`,
      [callId, conversationId, turnId],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_execution_steps(call_id,turn_id,call,sources,output) VALUES($1,$2,'{}',$3,$4)`,
      [
        callId,
        turnId,
        JSON.stringify([skill]),
        JSON.stringify({ result: { requestId, revision: 1 }, sources: [skill] }),
      ],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversation_requests(id,conversation_id,turn_id,producer_id,input_digest,membership_id,prompt,answer_schema,generation,attempt_epoch,status) VALUES($1,$2,$3,$4,$5,$6,'Which team?','{"kind":"text"}',0,0,'answered')`,
      [requestId, conversationId, turnId, callId, 'd'.repeat(64), actor.membershipId],
    );
    const requests = createConversationRequests(runtime);
    try {
      await db.platform.query(`UPDATE ${s}.tf_conversation_turns SET generation=generation+1 WHERE id=$1`, [turnId]);
      await expectCreated(await propose([skill, { kind: 'private-conversation', conversationId }]));
      await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=false WHERE id=$1`, [skillId]);
      assert.equal((await requests.read(ws.id, actor.userId, conversationId, requestId)).status, 'answered');
      await db.platform.query(`DELETE FROM ${s}.tf_skill_person_grants WHERE skill_id=$1`, [skillId]);
      await assert.rejects(requests.read(ws.id, actor.userId, conversationId, requestId), AccessDenied);
    } finally {
      await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=true WHERE id=$1`, [skillId]);
      await db.platform.query(
        `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read') ON CONFLICT DO NOTHING`,
        [skillId, actor.membershipId],
      );
    }
  });
  await t.test('missing storage-role skill grants remain an infrastructure fault', async () => {
    const proposal = await propose([skill]);
    const grant = `SELECT(id,enabled) ON ${s}.tf_workspace_skills`;
    await db.platform.query(`REVOKE ${grant} FROM "${ws.names.migration}","${ws.names.customOwner}"`);
    try {
      await expectBlocked(proposal, 'storage-fault');
    } finally {
      await db.platform.query(`GRANT ${grant} TO "${ws.names.migration}","${ws.names.customOwner}"`);
    }
  });
  await t.test('creation guard refusals stay safe through approval and repeated resume', async t => {
    const query = pg.Client.prototype.query;
    const write = process.stdout.write;
    const errors = [],
      logs = [];
    let mode;
    const otherTeam = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Other')`, [otherTeam]);
    process.stdout.write = function (chunk, ...args) {
      if (String(chunk).startsWith('{')) logs.push(JSON.parse(String(chunk)));
      return write.call(this, chunk, ...args);
    };
    pg.Client.prototype.query = async function (text, ...args) {
      if (
        mode === 'xmin-mismatch' &&
        typeof text === 'string' &&
        text.includes('tf_table_generations') &&
        text.includes("SET state='active'")
      ) {
        await query.call(this, 'SAVEPOINT activation');
        const result = await query.call(this, text, ...args);
        await query.call(this, 'RELEASE SAVEPOINT activation');
        return result;
      }
      if (typeof text !== 'string' || !text.includes('"tf_table_creation_access"('))
        return query.call(this, text, ...args);
      const executionId = args[0][0];
      if (mode === 'definition-changed')
        await query.call(
          this,
          `UPDATE ${s}.tf_table_generations g SET definition=jsonb_set(g.definition,'{fields}',$2) FROM ${s}.tf_table_executions e WHERE e.id=$1 AND g.id=e.target_generation`,
          [executionId, JSON.stringify([{ id: randomUUID(), label: 'Active', kind: 'boolean', required: false }])],
        );
      if (mode === 'generation-superseded')
        await query.call(
          this,
          `INSERT INTO ${s}.tf_table_generations(id,table_id,revision,definition,physical_table,state,activated_at) SELECT $2,g.table_id,$3,g.definition,$4,'retired',clock_timestamp() FROM ${s}.tf_table_generations g JOIN ${s}.tf_table_executions e ON e.target_generation=g.id WHERE e.id=$1`,
          [executionId, randomUUID(), 'e'.repeat(40), 'g_' + randomUUID().replaceAll('-', '')],
        );
      try {
        const result = await query.call(this, text, ...args);
        if (mode === 'same-execution') {
          const before = (await query.call(this, `SELECT lock_version FROM ${s}.tf_authorization_lock WHERE id=1`))
            .rows[0];
          await query.call(this, text, ...args);
          assert.deepEqual(
            (await query.call(this, `SELECT lock_version FROM ${s}.tf_authorization_lock WHERE id=1`)).rows[0],
            before,
          );
        }
        return result;
      } catch (error) {
        errors.push({ code: error.code, reason: error.detail });
        throw error;
      }
    };
    try {
      for (const reason of [
        'receipt-unattributed',
        'owner-changed',
        'definition-changed',
        'generation-superseded',
        'xmin-mismatch',
        'grant-collision',
      ]) {
        await t.test(reason, async () => {
          const proposal = await propose([skill, { kind: 'private-conversation', conversationId }]);
          assert.equal(await advance(ws.id, proposal.id), 'publish');
          await publish(ws.id, proposal.id);
          assert.equal(await advance(ws.id, proposal.id), 'more');
          if (reason === 'receipt-unattributed')
            await db.platform.query(`INSERT INTO ${s}.tf_table_creation_access_receipts(table_id) VALUES($1)`, [
              proposal.tableId,
            ]);
          if (reason === 'owner-changed')
            await db.platform.query(`UPDATE ${s}.tf_table_catalog SET owning_team_id=$2 WHERE id=$1`, [
              proposal.tableId,
              otherTeam,
            ]);
          if (reason === 'grant-collision')
            await db.platform.query(
              `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'agent.read')`,
              [team, proposal.tableId],
            );
          mode = reason;
          const code = ['receipt-unattributed', 'grant-collision'].includes(reason)
            ? 'proposal-conflict'
            : 'proposal-stale';
          for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt && reason === 'receipt-unattributed') {
              await db.platform.query(
                `UPDATE ${s}.tf_table_executions SET error_code='storage-fault' WHERE proposal_id=$1`,
                [proposal.id],
              );
              await db.platform.query(
                `UPDATE ${s}.tf_table_proposal_receipts SET receipt=jsonb_set(receipt,'{code}','"storage-fault"') WHERE proposal_id=$1`,
                [proposal.id],
              );
            }
            if (attempt && reason === 'grant-collision') {
              await assert.rejects(
                decisions.control(ws.id, actor, conversationId, proposal.id, {
                  digest: proposal.digest,
                  commandId: randomUUID(),
                  operation: 'resume',
                }),
                error => error.code === 'proposal-conflict',
              );
              continue;
            }
            if (attempt)
              await decisions.control(ws.id, actor, conversationId, proposal.id, {
                digest: proposal.digest,
                commandId: randomUUID(),
                operation: 'resume',
              });
            assert.equal(await finish(proposal), 'blocked');
            assert.equal(
              (await proposals.status(ws.id, actor.userId, conversationId, proposal.id)).plans[0].receipt.code,
              code,
            );
            if (reason !== 'grant-collision') {
              assert.deepEqual(errors.at(-1), { code: '42501', reason });
              const log = logs.findLast(item => item.operation === 'tables.execution');
              assert.equal(log['error.code'], `table-creation-${reason}`);
              assert.match(log['error.site'], /switchGeneration@execution:/);
            }
          }
          mode = undefined;
          if (reason === 'receipt-unattributed')
            await db.platform.query(`DELETE FROM ${s}.tf_table_creation_access_receipts WHERE table_id=$1`, [
              proposal.tableId,
            ]);
          if (reason === 'owner-changed')
            await db.platform.query(`UPDATE ${s}.tf_table_catalog SET owning_team_id=$2 WHERE id=$1`, [
              proposal.tableId,
              team,
            ]);
          if (reason === 'grant-collision')
            await db.platform.query(`DELETE FROM ${s}.tf_grants WHERE asset_id=$1 AND permission='agent.read'`, [
              proposal.tableId,
            ]);
          await decisions.control(ws.id, actor, conversationId, proposal.id, {
            digest: proposal.digest,
            commandId: randomUUID(),
            operation: 'resume',
          });
          await expectCreated(proposal);
        });
      }
      await t.test('the same execution can repeat the guard without granting twice', async () => {
        mode = 'same-execution';
        await expectCreated(await propose([skill]));
        mode = undefined;
      });
      await t.test('a matching execution marker lets a resumed cutover finish', async () => {
        const proposal = await propose([skill]);
        assert.equal(await advance(ws.id, proposal.id), 'publish');
        await publish(ws.id, proposal.id);
        assert.equal(await advance(ws.id, proposal.id), 'more');
        await db.platform.query(`INSERT INTO ${s}.tf_table_creation_access_receipts(table_id) VALUES($1)`, [
          proposal.tableId,
        ]);
        mode = 'receipt-unattributed';
        assert.equal(await finish(proposal), 'blocked');
        await db.platform.query(
          `UPDATE ${s}.tf_table_executions SET creation_access_granted_at=clock_timestamp() WHERE proposal_id=$1`,
          [proposal.id],
        );
        await db.platform.query(`UPDATE ${s}.tf_table_catalog SET owning_team_id=$2 WHERE id=$1`, [
          proposal.tableId,
          otherTeam,
        ]);
        mode = 'owner-changed';
        await decisions.control(ws.id, actor, conversationId, proposal.id, {
          digest: proposal.digest,
          commandId: randomUUID(),
          operation: 'resume',
        });
        assert.equal(await finish(proposal), 'blocked');
        assert.equal(
          (await proposals.status(ws.id, actor.userId, conversationId, proposal.id)).plans[0].receipt.code,
          'proposal-stale',
        );
        mode = undefined;
        await db.platform.query(`UPDATE ${s}.tf_table_catalog SET owning_team_id=$2 WHERE id=$1`, [
          proposal.tableId,
          team,
        ]);
        await decisions.control(ws.id, actor, conversationId, proposal.id, {
          digest: proposal.digest,
          commandId: randomUUID(),
          operation: 'resume',
        });
        await expectCreated(proposal);
      });
    } finally {
      mode = undefined;
      pg.Client.prototype.query = query;
      process.stdout.write = write;
    }
  });
  await t.test('missing internal provenance grants remain an infrastructure fault', async () => {
    const proposal = await propose([{ kind: 'private-conversation', conversationId }]);
    const grant = `SELECT(turn_id,sources) ON ${s}.tf_conversation_model_sources`;
    await db.platform.query(`REVOKE ${grant} FROM "${ws.names.migration}","${ws.names.customOwner}"`);
    try {
      await expectBlocked(proposal, 'storage-fault');
    } finally {
      await db.platform.query(`GRANT ${grant} TO "${ws.names.migration}","${ws.names.customOwner}"`);
    }
  });
});
