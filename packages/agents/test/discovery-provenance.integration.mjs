import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { requireDraftSources } from '../src/draft-sources.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { syntheticContinuity } from './continuity-fixture.mjs';

for (const role of ['member', 'admin'])
  for (const tool of ['agents.context', 'agents.list', 'agents.read']) {
    test(`${role} discovery through ${tool} retains metadata and executes a reviewed procedure`, async t => {
      const db = await fixture();
      let runtime;
      t.after(async () => {
        await runtime?.close();
        await db.close();
      });
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const stream = await workspaceTableMigrations(),
        w = await db.create(stream);
      const table = name => `"${w.names.schema}".${name}`;
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
      const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,$3)`, [
        actor.membershipId,
        actor.userId,
        role,
      ]);
      const source = await savedTaskAgent(db, w, runtime, actor.userId, actor.membershipId, [], []);
      await db.platform.query(`UPDATE ${table('tf_teams')} SET name='Discovery authors' WHERE id=$1`, [source.teamId]);
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_creation_grants')} (team_id,owning_team_id) VALUES ($1,$1)`,
        [source.teamId],
      );
      await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
      const chats = createConversations(runtime),
        drafts = createAuthoringDrafts(runtime),
        skills = createWorkspaceSkills(runtime);
      const chatId = randomUUID(),
        skillId = randomUUID();
      await chats.create(w.id, actor.userId, { chatId, commandId: randomUUID() });
      const sent = await chats.send(w.id, actor.userId, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'Discover before drafting.' }],
      });
      let discovered, draft;
      const driver = createConversationExecutor(runtime, async ({ executeTool }) => {
        discovered = await executeTool(tool, false, context =>
          createChatTools(context.runtime).invokeWithSources(
            context,
            tool === 'agents.read' ? { tool, agentId: source.agentId } : { tool },
          ),
        );
        draft = await executeTool(
          'skills.draft',
          false,
          context =>
            createChatTools(context.runtime).invokeWithSources(
              {
                ...context,
                origin: { ...context.origin, sources: [...context.origin.sources, ...discovered.sources] },
              },
              {
                tool: 'skills.draft',
                skillId,
                input: {
                  expectedVersion: 0,
                  definition: { name: 'Discovery procedure', instructions: 'Inspect before proposing.' },
                },
              },
            ),
          discovered.sources,
        );
        return { text: 'Review the procedure.', sources: discovered.sources };
      });
      assert.equal(
        await driver.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      assert.equal(discovered.sources.length, 1);
      assert.equal(discovered.sources[0].kind, tool === 'agents.context' ? 'creation-team' : 'agent-definition');
      const outcome = await drafts.decide(w.id, actor.userId, chatId, draft.result.draftId, {
        commandId: randomUUID(),
        digest: draft.result.digest,
        decision: 'save',
      });
      await skills.review(w.id, actor.userId, skillId, {
        requestId: randomUUID(),
        expectedVersion: 1,
        revision: outcome.receipt.savedRevision,
      });
      const retained = (
        await db.platform.query(`SELECT sources FROM ${table('tf_chat_authoring_drafts')} WHERE id=$1`, [
          draft.result.draftId,
        ])
      ).rows[0].sources;
      assert.ok(retained.some(item => JSON.stringify(item) === JSON.stringify(discovered.sources[0])));
      const consumer = await savedTaskAgent(
        db,
        w,
        runtime,
        actor.userId,
        actor.membershipId,
        [{ id: skillId, revision: outcome.receipt.savedRevision }],
        [],
      );
      await createAgentExecutor({ runtime }).configure(w.id, admin, {
        agentId: consumer.agentId,
        version: 0,
        enabled: true,
        teamIds: [consumer.teamId],
        limits: [],
      });
      const tasks = createAgentTasks(runtime);
      let received = 0;
      const engine = createTaskRuntime(
        runtime,
        syntheticContinuity(input => {
          assert.deepEqual(input.procedures, [
            {
              id: skillId,
              revision: outcome.receipt.savedRevision,
              name: 'Discovery procedure',
              instructions: 'Inspect before proposing.',
            },
          ]);
          assert.deepEqual(input.scope, []);
          assert.deepEqual(input.definition.tools, []);
          received++;
          return { kind: 'answer', text: 'Reviewed discovery procedure completed.' };
        }),
      );
      const task = await tasks.start(w.id, actor.userId, {
        requestId: randomUUID(),
        agentId: consumer.agentId,
        text: 'Run reviewed procedure.',
      });
      await engine.process(w.id, task.id);
      assert.equal((await tasks.read(w.id, actor.userId, task.id)).status, 'completed');
      assert.equal(received, 1);
      assert.equal(
        (await tasks.history(w.id, actor.userId, task.id)).messages.at(-1).text,
        'Reviewed discovery procedure completed.',
      );
      const disabling = await tasks.start(w.id, actor.userId, {
        requestId: randomUUID(),
        agentId: consumer.agentId,
        text: 'Disable the discovered procedure during inference.',
      });
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const processing = createTaskRuntime(
        runtime,
        syntheticContinuity(async () => {
          entered.resolve();
          await release.promise;
          return { kind: 'answer', text: 'Disabled procedure must not publish.' };
        }),
      ).process(w.id, disabling.id);
      await entered.promise;
      const disabled = await skills.setEnabled(w.id, actor.userId, skillId, {
        requestId: randomUUID(),
        expectedVersion: 2,
        enabled: false,
      });
      release.resolve();
      await processing;
      assert.equal((await tasks.read(w.id, actor.userId, disabling.id)).status, 'failed');
      await assert.rejects(tasks.history(w.id, actor.userId, task.id), AccessDenied);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('tf_agent_task_messages')} WHERE task_id=$1 AND text='Disabled procedure must not publish.'`,
            [disabling.id],
          )
        ).rows[0].n,
        0,
      );
      await skills.setEnabled(w.id, actor.userId, skillId, {
        requestId: randomUUID(),
        expectedVersion: disabled.version,
        enabled: true,
      });
      const runId = (
        await db.platform.query(`SELECT run_id FROM ${table('tf_agent_task_runs')} WHERE task_id=$1`, [task.id])
      ).rows[0].run_id;
      const check = sources =>
        runtime.transaction(w.id, { minimum: stream.length, maximum: stream.length }, async tx => {
          await lockAuthorization(tx);
          await requireDraftSources(tx, actor, sources, new Set(), runId);
        });
      await assert.rejects(check([{ kind: 'unknown' }]), AccessDenied);
      await assert.rejects(check([{ kind: 'unavailable' }]), AccessDenied);
      const pending = await tasks.start(w.id, actor.userId, {
        requestId: randomUUID(),
        agentId: consumer.agentId,
        text: 'Recheck metadata.',
      });
      // Team placement is visible to current team members. Admin status no longer retains revoked discovery.
      if (tool === 'agents.context')
        await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE team_id=$1 AND membership_id=$2`, [
          source.teamId,
          actor.membershipId,
        ]);
      else
        await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='read'`, [
          source.agentId,
        ]);
      await assert.rejects(check(discovered.sources), AccessDenied);
      await assert.rejects(tasks.history(w.id, actor.userId, task.id), AccessDenied);
      await assert.rejects(
        tasks.checkSources(w.id, actor.userId, [{ kind: 'task', taskId: task.id, throughSequence: 1 }], runId),
        AccessDenied,
      );
      await engine.process(w.id, pending.id);
      assert.equal((await tasks.read(w.id, actor.userId, pending.id)).status, 'failed');
      assert.equal(received, 1);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT sources FROM ${table('tf_chat_authoring_drafts')} WHERE id=$1`, [
            draft.result.draftId,
          ])
        ).rows[0].sources,
        retained,
      );
      if (tool === 'agents.context')
        await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (team_id,membership_id) VALUES ($1,$2)`, [
          source.teamId,
          actor.membershipId,
        ]);
      else
        await db.platform.query(
          `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read')`,
          [source.agentId, source.teamId],
        );
      assert.equal(
        (await tasks.history(w.id, actor.userId, task.id)).messages.at(-1).text,
        'Reviewed discovery procedure completed.',
      );
      const orphan = await tasks.start(w.id, actor.userId, {
        requestId: randomUUID(),
        agentId: consumer.agentId,
        text: 'Original owner incarnation only.',
      });
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
        actor.membershipId,
      ]);
      const replacement = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        replacement,
        actor.userId,
      ]);
      for (const teamId of [source.teamId, consumer.teamId])
        await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
          replacement,
          teamId,
        ]);
      await engine.process(w.id, orphan.id);
      assert.equal(received, 1);
      await assert.rejects(tasks.read(w.id, actor.userId, orphan.id), AccessDenied);
      await assert.rejects(tasks.history(w.id, actor.userId, task.id), AccessDenied);
    });
  }
