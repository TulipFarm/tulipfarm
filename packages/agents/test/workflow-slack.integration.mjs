import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkflows } from '../../workflows/src/service.ts';
import { activate } from '../../workflows/test/commands.fixture.mjs';
import { connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { activateGeneration, createGeneration } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { createSlackActions } from '../src/slack-actions.ts';
import { outboundFixture } from './slack-actions.integration.mjs';

test('native Slack workflow: Tickets chat draft, row event, per-send approval, restart and exact sent receipt', async t => {
  const f = await outboundFixture({ channelName: 'tech' });
  t.after(() => f.close());
  const w = f.workspace;
  await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [f.destinationId]);
  f.setDirectoryResponse(() => ({ channels: [{ id: 'CHR', name: 'tech' }], response_metadata: { next_cursor: '' } }));
  const resolved = await f.service.resolve(
    w.id,
    { kind: 'human', ...f.alice },
    { tool: 'slack.resolve', kind: 'channel', name: 'tech' },
  );
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.matches[0].destinationId, f.destinationId);
  assert.deepEqual(await f.service.destination(w.id, w.userId, f.destinationId), {
    id: f.destinationId,
    name: 'tech',
    channel: 'CHR',
    teamId: 'TTEST',
    installationId: f.installationId,
  });
  await assert.rejects(f.service.destination(w.id, w.userId, randomUUID()));
  f.setAudience(['UBOB', 'UBOT']);
  await assert.rejects(
    f.service.destination(w.id, w.userId, f.destinationId),
    'the review label needs current requester membership in Slack, not recipient TulipFarm accounts',
  );
  f.setAudience(['UALICE', 'UBOB']);
  await assert.rejects(
    f.service.destination(w.id, w.userId, f.destinationId),
    'the review label still requires the app in the Slack channel',
  );
  f.setAudience(['UALICE', 'UBOB', 'UGUEST', 'BOTHERBOT', 'UBOT']);
  const migration = await connect(f.db.login(w, 'migration'));
  const title = randomUUID(),
    tableId = randomUUID(),
    revision = '1'.repeat(40);
  try {
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
      const tx = { client, schema: w.names.schema };
      const generation = await createGeneration(tx, {
        revision,
        definition: {
          formatVersion: 2,
          id: tableId,
          owningTeamId: f.teamId,
          label: 'Tickets',
          fields: [{ id: title, label: 'Title', kind: 'text', required: false, maxLength: 200 }],
          uniqueKeys: [],
        },
      });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
    });
  } finally {
    await migration.end();
  }
  const definition = {
    version: 1,
    name: 'Tickets to Slack',
    trigger: { kind: 'row', tableId, event: 'created' },
    steps: [
      {
        id: 'notify',
        kind: 'slack-message',
        destinationId: f.destinationId,
        text: { kind: 'input', path: ['values', title, 'value'] },
      },
    ],
  };
  const chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    messageId: randomUUID(),
    commandId: randomUUID(),
    parts: [{ kind: 'text', text: 'Post the ticket title in Slack whenever a Tickets row is created.' }],
  });
  let proposed;
  const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
    proposed = await executeTool('workflows.draft', false, context =>
      createChatTools(context.runtime).invoke(context, {
        tool: 'workflows.draft',
        definition: JSON.stringify(definition),
        activate: true,
      }),
    );
    return { text: 'Review this workflow. Each message still needs approval.', sources: [] };
  });
  assert.equal(
    await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
    'completed',
  );
  assert.equal(proposed.status, 'review-required');
  const drafts = createAuthoringDrafts(f.runtime);
  const approval = { commandId: randomUUID(), digest: proposed.digest, decision: 'save' };
  const saved = await drafts.decide(w.id, w.userId, chatId, proposed.draftId, approval);
  assert.equal(saved.activation, 'activated');
  assert.equal(f.effects.length, 0);
  const workflows = createWorkflows(f.runtime, { slackActions: f.service });
  const records = createTableService(
    f.runtime,
    { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
    commonCompatibility,
  );
  await records.mutate(w.id, w.userId, {
    kind: 'create',
    tableId,
    revision,
    recordId: randomUUID(),
    values: { [title]: { kind: 'text', value: 'Synthetic ticket' } },
  });
  await f.db.databaseAdmin.query(`UPDATE ${f.table('tf_workflows')} SET next_run_at=clock_timestamp() WHERE id=$1`, [
    saved.workflowId,
  ]);
  const [work] = await workflows.due(w.id);
  assert.ok(work);
  const progress = await workflows.advance(work);
  assert.equal(
    progress.kind,
    'wait',
    JSON.stringify({
      runs: (await workflows.history(w.id, w.userId, saved.workflowId)).runs,
      sources: (
        await f.db.platform.query(`SELECT sources FROM ${f.table('tf_chat_authoring_drafts')} WHERE id=$1`, [
          proposed.draftId,
        ])
      ).rows,
    }),
  );
  let [run] = (await workflows.history(w.id, w.userId, saved.workflowId)).runs;
  const actionId = run.steps[0].output.actionId;
  assert.equal(run.status, 'waiting');
  const action = await f.service.read(w.id, w.userId, actionId);
  assert.equal(action.approvalRequired, true, 'even a direct destination requires per-send workflow approval');
  assert.equal(action.status, 'pending');
  assert.equal(action.action.text, 'Synthetic ticket');
  assert.equal(f.effects.length, 0);
  await workflows.advance(work);
  assert.equal(f.effects.length, 0);
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT count(*)::int AS n FROM ${f.table('tf_slack_workflow_actions')} WHERE run_id=$1`,
        [work.runId],
      )
    ).rows[0].n,
    1,
  );
  const origin = (
    await f.db.platform.query(
      `SELECT workflow_id,revision,step_id FROM ${f.table('tf_slack_workflow_actions')} WHERE run_id=$1`,
      [work.runId],
    )
  ).rows[0];
  assert.deepEqual(origin, { workflow_id: saved.workflowId, revision: saved.revision, step_id: 'notify' });
  assert.equal(
    (await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_agent_runs')} WHERE id=$1`, [work.runId])).rowCount,
    0,
  );
  await assert.rejects(f.decide(w.id, f.bob.userId, actionId, { digest: action.digest, decision: 'approve' }));
  await assert.rejects(f.decide(w.id, w.userId, actionId, { digest: '0'.repeat(64), decision: 'approve' }));
  await f.decide(w.id, w.userId, actionId, { digest: action.digest, decision: 'approve' });
  assert.ok(
    (await workflows.resumable(w.id)).some(item => item.runId === work.runId),
    'a lost decision wake is recovered',
  );
  const restarted = createWorkflows(f.runtime, {
    slackActions: createSlackActions({ ...f.settings, runtime: f.runtime }),
  });
  assert.equal((await restarted.advance(work)).kind, 'continue');
  assert.equal((await restarted.advance(work)).kind, 'done');
  await restarted.advance(work);
  [run] = (await restarted.history(w.id, w.userId, saved.workflowId)).runs;
  assert.equal(run.status, 'completed');
  assert.equal(run.steps[0].output.sentMessageTs, '6.000001');
  assert.equal((await f.service.read(w.id, w.userId, actionId)).sentMessageTs, '6.000001');
  assert.equal(f.effects.length, 1);
  assert.ok(f.cards.length);
  assert.equal(
    (await f.decide(w.id, w.userId, actionId, { digest: action.digest, decision: 'approve' })).status,
    'sent',
  );
  assert.equal((await drafts.read(w.id, w.userId, chatId, proposed.draftId)).status, 'saved');
});

test('native Slack workflow: retry, reject, expiry, revoke, disabled outbound, unknown and auth never replay', async t => {
  const f = await outboundFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const service = createWorkflows(f.runtime, { slackActions: f.service });
  const create = async (runner = service) => {
    const id = randomUUID(),
      revision = randomUUID();
    await service.save(w.id, w.userId, id, {
      revision,
      expectedRevision: null,
      definition: {
        version: 1,
        name: 'Slack safety',
        trigger: { kind: 'manual' },
        steps: [
          {
            id: 'send',
            kind: 'slack-message',
            destinationId: f.destinationId,
            text: { kind: 'literal', value: 'Synthetic message' },
          },
        ],
      },
    });
    await activate(service, w.id, w.userId, id, revision, true);
    const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: {} });
    const work = { workspaceId: w.id, runId };
    await runner.advance(work);
    const [run] = (await service.history(w.id, w.userId, id)).runs;
    const actionId = run.steps[0]?.output?.actionId;
    return { id, work, action: actionId && (await f.service.read(w.id, w.userId, actionId).catch(() => undefined)) };
  };
  const retried = await create();
  assert.equal(retried.action.status, 'pending');
  assert.equal(retried.action.approvalRequired, true);
  assert.equal(f.effects.length, 0);
  await f.decide(w.id, w.userId, retried.action.id, { digest: retried.action.digest, decision: 'approve' });
  f.setMode('retry');
  assert.equal((await service.advance(retried.work)).kind, 'wait');
  assert.equal(f.effects.length, 0);
  await f.db.databaseAdmin.query(
    `UPDATE ${f.table('tf_slack_action_effects')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE action_id=$1`,
    [retried.action.id],
  );
  f.setMode('success');
  await service.advance(retried.work);
  await service.advance(retried.work);
  assert.equal(f.effects.length, 1, 'only a known rejected rate-limit attempt is retried');
  assert.equal((await service.history(w.id, w.userId, retried.id)).runs[0].status, 'completed');
  for (const scenario of ['reject', 'expire', 'revoke', 'disabled', 'lost', 'auth']) {
    f.setMode('success');
    const count = f.effects.length;
    const { id, work, action } = await create();
    assert.equal(action.status, 'pending', scenario);
    assert.equal(action.approvalRequired, true, scenario);
    if (scenario === 'reject') await f.decide(w.id, w.userId, action.id, { digest: action.digest, decision: 'reject' });
    else if (scenario === 'expire')
      await f.db.databaseAdmin.query(
        `UPDATE ${f.table('tf_slack_actions')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [action.id],
      );
    else {
      await f.decide(w.id, w.userId, action.id, { digest: action.digest, decision: 'approve' });
      if (scenario === 'revoke')
        await f.db.databaseAdmin.query(`UPDATE ${f.table('tf_slack_destinations')} SET enabled=false WHERE id=$1`, [
          f.destinationId,
        ]);
      if (scenario === 'auth' || scenario === 'lost') f.setMode(scenario);
    }
    const runner = scenario === 'disabled' ? createWorkflows(f.runtime) : service;
    await runner.advance(work);
    await runner.advance(work);
    const [run] = (await service.history(w.id, w.userId, id)).runs;
    assert.equal(run.status, 'failed', scenario);
    assert.equal(f.effects.length, count + (scenario === 'lost' ? 1 : 0), scenario);
    assert.equal(
      run.error,
      {
        reject: 'slack-action-rejected',
        expire: 'slack-action-expired',
        revoke: 'slack-action-revoked',
        disabled: 'slack-action-unavailable',
        lost: 'slack-action-unknown',
        auth: 'slack-action-reauthorization-required',
      }[scenario],
    );
    if (scenario === 'revoke')
      await f.db.databaseAdmin.query(`UPDATE ${f.table('tf_slack_destinations')} SET enabled=true WHERE id=$1`, [
        f.destinationId,
      ]);
  }
  await assert.rejects(
    f.service.prepare(w.id, randomUUID(), randomUUID(), {
      tool: 'slack.message.send',
      destinationId: f.destinationId,
      text: 'No real origin',
    }),
  );
});

test('native Slack workflow recovery follows only its current waiting step and resumes preparation crashes', async t => {
  const f = await outboundFixture();
  t.after(() => f.close());
  const w = f.workspace,
    id = randomUUID(),
    revision = randomUUID();
  const service = createWorkflows(f.runtime, { slackActions: f.service });
  await service.save(w.id, w.userId, id, {
    revision,
    expectedRevision: null,
    definition: {
      version: 1,
      name: 'Two approvals',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'first',
          kind: 'slack-message',
          destinationId: f.destinationId,
          text: { kind: 'literal', value: 'First' },
        },
        {
          id: 'second',
          kind: 'slack-message',
          destinationId: f.destinationId,
          text: { kind: 'literal', value: 'Second' },
        },
        { id: 'pause', kind: 'delay', seconds: 3600 },
      ],
    },
  });
  await activate(service, w.id, w.userId, id, revision, true);
  const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: {} });
  const work = { workspaceId: w.id, runId };
  const interrupted = createWorkflows(f.runtime, {
    slackActions: {
      workflow: async () => {
        throw new Error('synthetic-preparation-crash');
      },
    },
  });
  await assert.rejects(interrupted.advance(work), /synthetic-preparation-crash/);
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT count(*)::int AS n FROM ${f.table('tf_slack_workflow_actions')} WHERE run_id=$1`,
        [runId],
      )
    ).rows[0].n,
    0,
  );
  assert.ok(
    (await service.resumable(w.id)).some(item => item.runId === runId),
    'a committed preparing step with no provider origin is recoverable',
  );
  const firstId = (await service.history(w.id, w.userId, id)).runs[0].steps[0].output.actionId;
  await service.advance(work);
  let action = await f.service.read(w.id, w.userId, firstId);
  assert.equal(action.status, 'pending');
  assert.equal(
    (await service.resumable(w.id)).some(item => item.runId === runId),
    false,
  );
  await f.decide(w.id, w.userId, firstId, { digest: action.digest, decision: 'approve' });
  assert.ok((await service.resumable(w.id)).some(item => item.runId === runId));
  await service.advance(work);
  await service.advance(work);
  const secondId = (await service.history(w.id, w.userId, id)).runs[0].steps[1].output.actionId;
  assert.notEqual(secondId, firstId);
  assert.equal(
    (await service.resumable(w.id)).some(item => item.runId === runId),
    false,
    'the first approval must not wake a second pending Slack step',
  );
  action = await f.service.read(w.id, w.userId, secondId);
  await f.decide(w.id, w.userId, secondId, { digest: action.digest, decision: 'approve' });
  await service.advance(work);
  await service.advance(work);
  assert.equal(
    (await service.resumable(w.id)).some(item => item.runId === runId),
    false,
    'past approvals must not wake an unrelated delay',
  );
  assert.equal(f.effects.length, 2);
});

test('native Slack workflow retains in-app approval and retries a missing notification after storage failure', async t => {
  const f = await outboundFixture();
  t.after(() => f.close());
  let failed = false;
  const interrupted = {
    transaction: (workspaceId, compatibility, operation) =>
      f.runtime.transaction(workspaceId, compatibility, tx =>
        operation({
          ...tx,
          client: {
            query: (sql, params) => {
              if (!failed && sql.startsWith('SELECT channel,message_ts,presented_status')) {
                failed = true;
                throw new Error('synthetic-notification-storage-failure');
              }
              return tx.client.query(sql, params);
            },
          },
        }),
      ),
  };
  const actions = createSlackActions({ ...f.settings, runtime: interrupted });
  const service = createWorkflows(f.runtime, { slackActions: actions });
  const w = f.workspace,
    id = randomUUID(),
    revision = randomUUID();
  await service.save(w.id, w.userId, id, {
    revision,
    expectedRevision: null,
    definition: {
      version: 1,
      name: 'Notification recovery',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'send',
          kind: 'slack-message',
          destinationId: f.destinationId,
          text: { kind: 'literal', value: 'Notice recovery' },
        },
      ],
    },
  });
  await activate(service, w.id, w.userId, id, revision, true);
  const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: {} });
  const work = { workspaceId: w.id, runId };
  assert.equal((await service.advance(work)).kind, 'wait');
  assert.equal(failed, true);
  assert.equal(f.effects.length, 0);
  const actionId = (await service.history(w.id, w.userId, id)).runs[0].steps[0].output.actionId;
  let action = await f.service.read(w.id, w.userId, actionId);
  assert.equal(action.status, 'pending');
  assert.equal(action.notificationStatus, null);
  assert.ok((await service.resumable(w.id)).some(item => item.runId === runId));
  await service.advance(work);
  action = await f.service.read(w.id, w.userId, actionId);
  assert.equal(action.notificationStatus, 'sent');
  assert.equal(
    (await service.resumable(w.id)).some(item => item.runId === runId),
    false,
  );
  assert.equal(f.cards.length, 1);
  assert.equal(f.effects.length, 0);
});

test('native Slack workflow does not export private history through authored literal text', async t => {
  const f = await outboundFixture();
  t.after(() => f.close());
  const w = f.workspace,
    chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const send = text =>
    f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text }],
    });
  const first = await send('Synthetic private context');
  const context = createConversationExecutor(f.runtime, async () => ({
    text: 'Private history recorded.',
    sources: [],
  }));
  await context.process({ workspaceId: w.id, conversationId: chatId, turnId: first.turnId, generation: 0 });
  const next = await send('Make a Slack workflow using that private context.');
  const definition = {
    version: 1,
    name: 'Private literal guard',
    trigger: { kind: 'manual' },
    steps: [
      {
        id: 'send',
        kind: 'slack-message',
        destinationId: f.destinationId,
        text: { kind: 'literal', value: 'Synthetic private context' },
      },
    ],
  };
  let proposed;
  const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
    proposed = await executeTool('workflows.draft', false, context =>
      createChatTools(context.runtime).invoke(context, {
        tool: 'workflows.draft',
        definition: JSON.stringify(definition),
        activate: true,
      }),
    );
    return { text: 'Review the definition.', sources: [] };
  });
  await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: next.turnId, generation: 0 });
  const saved = await createAuthoringDrafts(f.runtime).decide(w.id, w.userId, chatId, proposed.draftId, {
    commandId: randomUUID(),
    digest: proposed.digest,
    decision: 'save',
  });
  const service = createWorkflows(f.runtime, { slackActions: f.service });
  const { runId } = await service.start(w.id, w.userId, saved.workflowId, { requestId: randomUUID(), input: {} });
  assert.equal((await service.advance({ workspaceId: w.id, runId })).kind, 'done');
  assert.equal((await service.history(w.id, w.userId, saved.workflowId)).runs[0].error, 'slack-action-revoked');
  assert.equal(f.effects.length, 0);
});

test('native Slack workflow step saved to post as the TulipFarm app sends with the bot token', async t => {
  const f = await outboundFixture();
  t.after(() => f.close());
  const w = f.workspace,
    chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    messageId: randomUUID(),
    commandId: randomUUID(),
    parts: [{ kind: 'text', text: 'Make a manual Slack workflow that posts as the TulipFarm app.' }],
  });
  const definition = {
    version: 1,
    name: 'App announcement',
    trigger: { kind: 'manual' },
    steps: [
      {
        id: 'announce',
        kind: 'slack-message',
        destinationId: f.destinationId,
        sender: 'app',
        text: { kind: 'literal', value: 'Release notes are ready' },
      },
    ],
  };
  let proposed;
  const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
    proposed = await executeTool('workflows.draft', false, context =>
      createChatTools(context.runtime).invoke(context, {
        tool: 'workflows.draft',
        definition: JSON.stringify(definition),
        activate: true,
      }),
    );
    return { text: 'Review the definition.', sources: [] };
  });
  await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
  const saved = await createAuthoringDrafts(f.runtime).decide(w.id, w.userId, chatId, proposed.draftId, {
    commandId: randomUUID(),
    digest: proposed.digest,
    decision: 'save',
  });
  const service = createWorkflows(f.runtime, { slackActions: f.service });
  const { runId } = await service.start(w.id, w.userId, saved.workflowId, { requestId: randomUUID(), input: {} });
  assert.equal((await service.advance({ workspaceId: w.id, runId })).kind, 'wait');
  const [step] = (await service.history(w.id, w.userId, saved.workflowId)).runs[0].steps;
  assert.equal(step.status, 'waiting');
  const actionId = step.output.actionId;
  const action = await f.service.read(w.id, w.userId, actionId);
  assert.equal(action.sender, 'app');
  assert.equal(action.approvalRequired, true);
  assert.equal(action.status, 'pending');
  assert.equal(f.effects.length, 0);
  await f.decide(w.id, w.userId, actionId, { digest: action.digest, decision: 'approve' });
  assert.equal((await service.advance({ workspaceId: w.id, runId })).kind, 'continue');
  assert.deepEqual(f.effects, [
    { token: 'Bearer xoxb-fixture', name: 'send', channel: 'CHR', text: 'Release notes are ready' },
  ]);
  assert.equal((await f.service.read(w.id, w.userId, actionId)).sentMessageTs, '7.000001');
});
