import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { createTableWithRows, tableDefinition, textField } from '../../tables/test/fixture.mjs';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createAgentSetup } from '../src/setup.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { readWorkspaceInventory } from '../src/workspace-inventory.ts';
import { syntheticContinuity } from './continuity-fixture.mjs';

const limits = { toolCalls: 10, activeMilliseconds: 600000, credits: 100 };

async function environment(t) {
  const f = await conversationFixture();
  t.after(() => f.close());
  const { db, runtime, workspace: w, table } = f;
  const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  // Any workspace table the requester can see enters the chat's inventory sources.
  const team = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Operations')`, [team]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    admin.membershipId,
    team,
  ]);
  await createTableWithRows({
    db,
    workspace: w,
    runtime,
    definition: tableDefinition({ id: randomUUID(), owningTeamId: team, label: 'Unrelated', fields: [textField()] }),
  });
  await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
  const head = async () =>
    (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0].revision;
  const writer = createAgentAuthoring(runtime).withWriter(async input => {
    const commit = createHash('sha1').update(input.commandId).digest('hex');
    return {
      parentCommit: input.expectedParentCommit,
      commit,
      bundle: { key: `bundle-${commit}`, sha256: 'b'.repeat(64) },
      projection: {
        workspaceId: w.id,
        commit,
        kind: 'agent',
        id: input.definition.id,
        path: `agents/${input.definition.id}.json`,
        bucket: 'synthetic',
        key: `projection-${commit}`,
        sha256: createHash('sha256').update(serializeAgentDocument(input.definition)).digest('hex'),
      },
    };
  });
  const drafts = createAuthoringDrafts(runtime),
    setup = createAgentSetup(runtime),
    tasks = createAgentTasks(runtime);
  const setupInput = triggers => ({
    policy: {
      grants: [],
      personGrants: [{ membershipId: admin.membershipId, permissions: ['read', 'edit', 'manage', 'invoke', 'delete'] }],
    },
    enrollment: [],
    scope: [],
    limits: [],
    taskLimits: limits,
    slackSender: 'user',
    slackChannels: [],
    ...(triggers.length ? { prompt: 'Check in.' } : {}),
    triggers,
  });
  /** One chat turn as the worker runs it: inventory sources, then each tool's sources feed the next call. */
  async function chatDraft(calls, draftCall) {
    const chatId = randomUUID();
    await f.store.create(w.id, admin.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, admin.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Set up the agent.' }],
    });
    const proposal = await draftCall();
    let draft;
    await createConversationExecutor(runtime, async ({ executeTool }) => {
      const sources = [...(await readWorkspaceInventory(runtime, w.id, admin)).sources];
      const run = async call => {
        const output = await executeTool(
          call.tool,
          false,
          context =>
            createChatTools(context.runtime).invokeWithSources(
              { ...context, origin: { ...context.origin, sources: [...context.origin.sources, ...sources] } },
              call,
            ),
          [...sources],
        );
        sources.push(...output.sources);
        return output.result;
      };
      for (const call of calls) await run(call);
      draft = await run(proposal);
      return { text: 'Review the agent.', sources };
    }).process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    assert.ok(draft?.draftId, JSON.stringify(draft));
    const outcome = await drafts.decide(w.id, admin.userId, chatId, draft.draftId, {
      commandId: randomUUID(),
      digest: draft.digest,
      decision: 'activate',
      consent: { replaceChannels: [] },
    });
    assert.equal((await writer.prepare(w.id, outcome.receipt.commandId)).status, 'accepted');
    const active = await setup.advance(w.id, admin.userId, outcome.setupReceipt.commandId);
    assert.equal(active.status, 'active', active.error);
    return { ...draft, agentId: proposal.agent === 'new' ? draft.agentId : proposal.agent.id };
  }
  const engine = createTaskRuntime(
    runtime,
    syntheticContinuity(() => ({ kind: 'answer', text: 'Done.' })),
  );
  async function runTask(agentId) {
    const task = await tasks.start(w.id, admin.userId, { requestId: randomUUID(), agentId, text: 'Run now.' });
    for (let step = 0; step < 5 && (await tasks.read(w.id, admin.userId, task.id)).status === 'pending'; step++)
      await engine.process(w.id, task.id);
    const read = await tasks.read(w.id, admin.userId, task.id);
    return read.status;
  }
  /** The manual builder path: save a setup draft, publish it with activation, and let Soul accept it. */
  async function builderAgent(name) {
    const agentId = randomUUID();
    const draft = await setup.saveDraft(w.id, admin.userId, agentId, {
      requestId: randomUUID(),
      expectedVersion: 0,
      expectedSoulRevision: await head(),
      expectedSavedRevision: null,
      expectedPolicyVersion: 0,
      expectedActivationIds: [],
      expectedWorkflowRevision: null,
      expectedWorkflowGeneration: null,
      setup: {
        definition: { name, instructions: 'Answer briefly.', tools: [] },
        owningTeamId: null,
        ...setupInput([]),
      },
    });
    const command = await setup.publish(w.id, admin.userId, agentId, {
      requestId: randomUUID(),
      version: draft.version,
      digest: draft.digest,
      decision: 'activate',
      consent: { replaceChannels: [] },
    });
    const definition = await setup.definitionCommand(w.id, admin.userId, command.commandId);
    assert.equal((await writer.prepare(w.id, definition.commandId)).status, 'accepted');
    assert.equal((await setup.advance(w.id, admin.userId, command.commandId)).status, 'active');
    return agentId;
  }
  return { ...f, admin, head, setupInput, chatDraft, runTask, builderAgent };
}

const cron = () => ({
  id: randomUUID(),
  trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Kolkata' },
});

test('an agent created through chat setup runs a manual task', async t => {
  const f = await environment(t);
  const triggers = [cron()];
  const input = await f.head().then(head => ({
    expectedSoulRevision: head,
    definition: { name: 'Chat-made agent', instructions: 'Answer briefly.', tools: [] },
    owningTeamId: null,
    setup: f.setupInput(triggers),
    expectedPolicyVersion: 0,
    expectedActivationIds: [],
    expectedWorkflowRevision: null,
    expectedWorkflowGeneration: null,
  }));
  const draft = await f.chatDraft(
    [{ tool: 'skills.read', skillId: 'agent-authoring' }, { tool: 'agents.context' }],
    async () => ({ tool: 'agents.draft', agent: 'new', input }),
  );
  assert.equal(await f.runTask(draft.agentId), 'completed');
});

test('a builder agent edited through chat to add a trigger keeps running tasks', async t => {
  const f = await environment(t);
  const name = 'Builder agent';
  const agentId = await f.builderAgent(name);
  assert.equal(await f.runTask(agentId), 'completed');
  const edit = async () => {
    const state = (
      await f.db.platform.query(`SELECT saved_revision,policy_version FROM ${f.table('tf_agents')} WHERE id=$1`, [
        agentId,
      ])
    ).rows[0];
    const activations = (
      await f.db.platform.query(
        `SELECT id FROM ${f.table('tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL ORDER BY id`,
        [agentId],
      )
    ).rows.map(row => row.id);
    return {
      tool: 'agents.draft',
      agent: { id: agentId, savedRevision: state.saved_revision },
      input: {
        expectedSoulRevision: await f.head(),
        definition: { name, instructions: 'Answer briefly.', tools: [] },
        owningTeamId: null,
        setup: f.setupInput(edited),
        expectedPolicyVersion: state.policy_version,
        expectedActivationIds: activations,
        expectedWorkflowRevision: null,
        expectedWorkflowGeneration: null,
      },
    };
  };
  const edited = [cron()];
  await f.chatDraft(
    [
      { tool: 'skills.read', skillId: 'agent-authoring' },
      { tool: 'agents.read', agentId },
      { tool: 'agents.context', agentId },
    ],
    edit,
  );
  assert.equal(await f.runTask(agentId), 'completed');
});
