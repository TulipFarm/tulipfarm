import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { initializeSoul, soulStorageConfig } from '@tulipfarm/workspaces/soul';
import { prepareSoulRevision } from '@tulipfarm/workspaces/soul-revisions';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../tables/test/fixture.mjs';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createAgentRecordTools } from '../src/record-tools.ts';
import { createChatTools } from '../src/tools.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskApprovals, createTaskApprovalDecision } from '../src/task-approvals.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { syntheticContinuity } from './continuity-fixture.mjs';
import { soulStorageSkip } from './soul-fixture.mjs';

for (const target of ['agent', 'skill'])
  test(
    `discovered source agent keeps resource restrictions in task ${target} definitions`,
    { skip: soulStorageSkip },
    async t => {
      const f = await conversationFixture(),
        soul = soulStorageConfig();
      t.after(async () => {
        soul.client.destroy();
        await f.close();
      });
      const { db, runtime, workspace: w, table, store: chats } = f;
      const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
      const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
      const team = randomUUID(),
        tableId = randomUUID(),
        recordId = randomUUID(),
        revision = 'a'.repeat(40);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        actor.membershipId,
        actor.userId,
      ]);
      await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Source authors')`, [team]);
      await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        actor.membershipId,
        team,
      ]);
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_creation_grants')} (team_id,owning_team_id) VALUES ($1,$1)`,
        [team],
      );
      const fact = textField();
      await createTableWithRows({
        db,
        workspace: w,
        runtime,
        revision,
        definition: tableDefinition({ id: tableId, owningTeamId: team, label: 'Source facts', fields: [fact] }),
        records: [{ id: recordId, values: textValues(fact, 'Restricted source fact') }],
      });
      for (const permission of ['table.row.read', 'table.row.update'])
        await db.platform.query(`INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
          team,
          tableId,
          permission,
        ]);
      const seed = { workspaceId: w.id, createdBy: actor.userId, createdAt: new Date().toISOString() },
        initial = await initializeSoul(soul, seed);
      await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, [initial.commit]);
      const writer = createAgentAuthoring(runtime).withWriter(input =>
        prepareSoulRevision(
          soul,
          seed,
          input.parent ? { commit: input.expectedParentCommit, bucket: soul.bucket, ...input.parent } : initial,
          {
            kind: 'agent',
            commandId: input.commandId,
            expectedParentCommit: input.expectedParentCommit,
            createdAt: input.createdAt,
            definition: input.definition,
          },
        ),
      );
      const drafts = createAuthoringDrafts(runtime),
        skills = createWorkspaceSkills(runtime);
      async function author(discovery, kind) {
        let id = randomUUID();
        const chatId = randomUUID();
        await chats.create(w.id, actor.userId, { chatId, commandId: randomUUID() });
        const sent = await chats.send(w.id, actor.userId, chatId, {
          messageId: randomUUID(),
          commandId: randomUUID(),
          parts: [{ kind: 'text', text: 'Inspect then draft a source-derived procedure.' }],
        });
        let draft, sources;
        const head = (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0]
          .revision;
        const definition = { name: 'Source-derived procedure', instructions: 'Restricted source fact' };
        const call =
          kind === 'agent'
            ? {
                tool: 'agents.draft',
                agent: 'new',
                input: {
                  expectedSoulRevision: head,
                  owningTeamId: team,
                  definition: { ...definition, tools: ['rows.update'] },
                },
              }
            : { tool: 'skills.draft', skillId: id, input: { expectedVersion: 0, definition } };
        const driver = createConversationExecutor(runtime, async ({ executeTool }) => {
          const result = await executeTool(discovery.tool, false, context =>
            createChatTools(context.runtime).invokeWithSources(context, discovery),
          );
          sources = result.sources;
          if (discovery.tool === 'rows.get')
            assert.equal(result.result.values[fact.id].value, 'Restricted source fact');
          else assert.equal(result.result.definition.instructions, 'Restricted source fact');
          draft = await executeTool(
            call.tool,
            false,
            context =>
              createChatTools(context.runtime).invokeWithSources(
                { ...context, origin: { ...context.origin, sources: [...context.origin.sources, ...sources] } },
                call,
              ),
            sources,
          );
          return { text: 'Review the source-derived draft.', sources };
        });
        assert.equal(
          await driver.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
          'completed',
        );
        const outcome = await drafts.decide(w.id, actor.userId, chatId, draft.result.draftId, {
          commandId: randomUUID(),
          digest: draft.result.digest,
          decision: 'save',
        });
        if (kind === 'agent') {
          id = draft.result.agentId;
          assert.equal((await writer.prepare(w.id, outcome.receipt.commandId)).status, 'accepted');
          await db.platform.query(
            `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read'),($1,$2,'invoke')`,
            [id, team],
          );
        } else
          await skills.review(w.id, actor.userId, id, {
            requestId: randomUUID(),
            expectedVersion: 1,
            revision: outcome.receipt.savedRevision,
          });
        const retained = (
          await db.platform.query(`SELECT sources FROM ${table('tf_chat_authoring_drafts')} WHERE id=$1`, [
            draft.result.draftId,
          ])
        ).rows[0].sources;
        return { id, outcome, sources, retained, draftId: draft.result.draftId };
      }
      const source = await author({ tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId }, 'agent'),
        sourceId = source.id;
      assert.deepEqual(source.sources, [{ kind: 'table-rows', tableId, revision }]);
      const derived = await author({ tool: 'agents.read', agentId: sourceId }, target),
        targetId = derived.id;
      assert.equal(derived.sources[0].kind, 'agent-definition');
      const selection = target === 'skill' ? [{ id: targetId, revision: derived.outcome.receipt.savedRevision }] : [];
      let consumer;
      const executor = createAgentExecutor({ runtime });
      if (target === 'skill')
        consumer = await savedTaskAgent(db, w, runtime, actor.userId, actor.membershipId, selection, ['rows.update']);
      else {
        const saved = (
          await db.platform.query(
            `SELECT definition_revision FROM ${table('tf_agent_saved_revisions')} WHERE agent_id=$1`,
            [targetId],
          )
        ).rows[0];
        // The administrator manages this agent only through an explicit manager grant.
        await db.platform.query(
          `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage')`,
          [targetId, admin.membershipId],
        );
        const activation = await executor.activate(w.id, admin, {
          agentId: targetId,
          revision: saved.definition_revision,
          scope: [],
        });
        consumer = { agentId: targetId, ...activation };
      }
      const scope = [{ assetId: tableId, permissions: ['table.row.read', 'table.row.update'] }];
      await db.platform.query(
        `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager') ON CONFLICT (team_id,membership_id) DO UPDATE SET role='manager'`,
        [admin.membershipId, team],
      );
      await executor.configure(w.id, admin, {
        agentId: consumer.agentId,
        version: 0,
        enabled: true,
        teamIds: [team],
        limits: scope,
      });
      const tasks = createAgentTasks(runtime),
        approvals = createTaskApprovals(runtime);
      let dispatches = 0;
      const engine = createTaskRuntime(
        runtime,
        syntheticContinuity(input => {
          assert.equal(
            target === 'agent' ? input.definition.instructions : input.procedures[0].instructions,
            'Restricted source fact',
          );
          dispatches++;
          return { kind: 'answer', text: 'Authorized source-derived answer.' };
        }),
      );
      const unbounded = await tasks.start(w.id, actor.userId, {
        requestId: randomUUID(),
        agentId: consumer.agentId,
        text: 'No agent source scope.',
      });
      await engine.process(w.id, unbounded.id);
      assert.equal((await tasks.read(w.id, actor.userId, unbounded.id)).status, 'failed');
      assert.equal(dispatches, 0);
      await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
        consumer.activationId,
        JSON.stringify(scope),
      ]);
      const start = text =>
        tasks.start(w.id, actor.userId, { requestId: randomUUID(), agentId: consumer.agentId, scope, text });
      const allowed = await start('Current owner and agent can read.');
      await engine.process(w.id, allowed.id);
      assert.equal(
        (await tasks.history(w.id, actor.userId, allowed.id)).messages.at(-1).text,
        'Authorized source-derived answer.',
      );
      assert.equal(dispatches, 1);
      const actionTask = await start('Approve before source revocation.');
      const proposal = await approvals.propose(w.id, actor.userId, actionTask.id, {
        requestId: randomUUID(),
        generation: 0,
        calls: [
          {
            tool: 'rows.update',
            tableId,
            recordId,
            expectedAppliedRevision: revision,
            expectedToken: (
              await createAgentRecordTools(runtime).getRecord(w.id, actor.userId, tableId, revision, recordId)
            ).token,
            values: { [fact.id]: { kind: 'text', value: 'Must not execute' } },
          },
        ],
      });
      await createTaskApprovalDecision({
        runtime,
        resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
      })(w.id, actor.userId, actionTask.id, proposal.id, { digest: proposal.digest, decision: 'approve' });
      const pending = await start('Revoke while inference is in flight.');
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const publishing = createTaskRuntime(
        runtime,
        syntheticContinuity(async () => {
          entered.resolve();
          await release.promise;
          return { kind: 'answer', text: 'Must not publish' };
        }),
      );
      const processing = publishing.process(w.id, pending.id);
      await entered.promise;
      await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE asset_id=$1 AND permission='table.row.read'`, [
        tableId,
      ]);
      release.resolve();
      await processing;
      assert.equal((await tasks.read(w.id, actor.userId, pending.id)).status, 'failed');
      await assert.rejects(tasks.history(w.id, actor.userId, allowed.id), AccessDenied);
      await assert.rejects(
        tasks.checkSources(
          w.id,
          actor.userId,
          [{ kind: 'task', taskId: allowed.id, throughSequence: 1 }],
          proposal.runId,
        ),
        AccessDenied,
      );
      assert.equal(
        await executor.execute({ workspaceId: w.id, runId: proposal.runId, callId: proposal.actions[0].id }),
        'blocked',
      );
      assert.equal(
        (await createAgentRecordTools(runtime).getRecord(w.id, admin.userId, tableId, revision, recordId)).values[
          fact.id
        ].value,
        'Restricted source fact',
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('tf_agent_task_messages')} WHERE text='Must not publish'`,
          )
        ).rows[0].n,
        0,
      );
      await assert.rejects(
        createChatTools(runtime).invokeWithSources(
          { workspaceId: w.id, actor, callId: randomUUID() },
          { tool: 'agents.read', agentId: sourceId },
        ),
        AccessDenied,
      );
      assert.deepEqual(
        (
          await db.platform.query(`SELECT sources FROM ${table('tf_chat_authoring_drafts')} WHERE id=$1`, [
            derived.draftId,
          ])
        ).rows[0].sources,
        derived.retained,
      );
    },
  );
