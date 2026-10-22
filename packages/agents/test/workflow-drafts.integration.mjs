import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { activateGeneration, createGeneration } from '@tulipfarm/tables/store';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createWorkflows } from '@tulipfarm/workflows';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { connect, fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { providerSetupFetch } from '../../workflows/test/provider-fixture.mjs';

const weekdayReview = {
  version: 1,
  name: 'Review open tickets',
  trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/New_York' },
  steps: [{ id: 'review', kind: 'human', prompt: 'Review open tickets.', timeoutSeconds: 86400 }],
};

test(
  'chat edits configured provider workflows without secrets and rechecks retained source access',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const user = randomUUID(),
      member = randomUUID(),
      outsider = randomUUID(),
      outsiderMember = randomUUID();
    await db.platform.query(
      `INSERT INTO "${w.names.schema}".tf_memberships (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
      [member, user, outsiderMember, outsider],
    );
    const service = createWorkflows(runtime, {
      keyring: { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } },
      providerFetch: providerSetupFetch,
    });
    const sheets = randomUUID(),
      forms = randomUUID();
    for (const input of [
      {
        id: sheets,
        name: 'Orders',
        source: { provider: 'sheets', spreadsheetId: 'orders', range: 'Orders!A2:B1000', keyColumn: 0 },
      },
      { id: forms, name: 'Feedback', source: { provider: 'forms', formId: 'feedback' } },
    ]) {
      await service.providers.create(w.id, w.userId, { ...input, token: 'fixture-token-never-in-chat', consent: true });
      await service.providers.share(w.id, w.userId, input.id, {
        principal: { kind: 'person', id: member },
        permissions: ['use'],
      });
    }
    await service.providers.share(w.id, w.userId, sheets, {
      principal: { kind: 'person', id: outsiderMember },
      permissions: ['manage'],
    });
    const chats = createConversations(runtime),
      drafts = createAuthoringDrafts(runtime);
    async function turn(
      calls,
      { actor = user, chatId = randomUUID(), fresh = true, text = 'Configured provider details.' } = {},
    ) {
      if (fresh) await chats.create(w.id, actor, { chatId, commandId: randomUUID() });
      const sent = await chats.send(w.id, actor, chatId, {
        messageId: randomUUID(),
        commandId: randomUUID(),
        parts: [{ kind: 'text', text: 'Help me with this workflow.' }],
      });
      const outputs = [];
      let messages;
      const executor = createConversationExecutor(runtime, async input => {
        messages = input.messages;
        for (const call of calls)
          outputs.push(
            (
              await input.executeTool(
                call.tool,
                false,
                context => createChatTools(context.runtime).invokeWithSources(context, call),
                [],
                call,
              )
            ).result,
          );
        return { text, sources: [] };
      });
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      return { chatId, outputs, messages };
    }
    assert.deepEqual(
      (await turn([{ tool: 'workflows.providers' }], { actor: outsider })).outputs[0].providers,
      [],
      'manage alone does not grant source use',
    );
    const choices = (await turn([{ tool: 'workflows.providers' }])).outputs[0].providers;
    assert.deepEqual(choices.map(source => source.id).sort(), [sheets, forms].sort());
    assert.equal(JSON.stringify(choices).includes('fixture-token-never-in-chat'), false);
    assert.equal(
      choices.every(
        source => source.enabled && source.authorized && source.capabilities.use && !source.capabilities.manage,
      ),
      true,
    );
    const definition = {
      version: 1,
      name: 'Updated orders',
      trigger: { kind: 'provider', integrationId: sheets, event: 'updated', minutes: 1 },
      steps: [{ id: 'copy', kind: 'transform', fields: { order: { kind: 'input', path: [] } } }],
    };
    const invalid = (
      await turn([
        {
          tool: 'workflows.draft',
          definition: JSON.stringify({ ...definition, trigger: { ...definition.trigger, integrationId: forms } }),
          activate: true,
        },
      ])
    ).outputs[0];
    assert.equal(invalid.error, 'provider-source-denied', 'updated events are Sheets-only');
    const proposed = await turn(
      [
        { tool: 'workflows.providers' },
        { tool: 'workflows.draft', definition: JSON.stringify(definition), activate: true },
      ],
      { text: 'Private provider draft details.' },
    );
    const draft = proposed.outputs[1];
    assert.equal(draft.status, 'review-required');
    assert.deepEqual(await service.list(w.id, user), []);
    const outcome = await drafts.decide(w.id, user, proposed.chatId, draft.draftId, {
      commandId: randomUUID(),
      digest: draft.digest,
      decision: 'save',
    });
    assert.equal(outcome.activation, 'activated');
    assert.deepEqual((await service.definition(w.id, user, outcome.workflowId)).definition, definition);
    const { runId: retainedRun } = await service.start(w.id, user, outcome.workflowId, {
      requestId: randomUUID(),
      input: {},
    });
    assert.deepEqual((await service.runDetail(w.id, user, outcome.workflowId, retainedRun)).definition, definition);
    await service.providers.share(w.id, w.userId, forms, {
      principal: { kind: 'person', id: member },
      permissions: [],
    });
    await assert.rejects(
      service.definition(w.id, user, outcome.workflowId),
      AccessDenied,
      'definition reads recheck retained sources beyond structural trigger references',
    );
    await assert.rejects(
      service.runDetail(w.id, user, outcome.workflowId, retainedRun),
      AccessDenied,
      'run-pinned definitions use the same retained-source boundary',
    );
    await service.providers.share(w.id, w.userId, forms, {
      principal: { kind: 'person', id: member },
      permissions: ['use'],
    });
    assert.deepEqual((await service.definition(w.id, user, outcome.workflowId)).definition, definition);
    const reading = await turn([{ tool: 'workflows.read', workflowId: outcome.workflowId }], {
      text: 'Private provider definition details.',
    });
    assert.deepEqual(reading.outputs[0].definition, definition);
    const editing = await turn([
      { tool: 'workflows.providers' },
      {
        tool: 'workflows.draft',
        workflowId: outcome.workflowId,
        revision: outcome.revision,
        definition: JSON.stringify({ ...definition, name: 'Renamed orders' }),
        activate: false,
      },
    ]);
    const edit = editing.outputs[1];
    const approval = { commandId: randomUUID(), digest: edit.digest, decision: 'save' };
    await service.providers.share(w.id, w.userId, sheets, {
      principal: { kind: 'person', id: member },
      permissions: [],
    });
    await assert.rejects(service.definition(w.id, user, outcome.workflowId), AccessDenied);
    await assert.rejects(drafts.read(w.id, user, editing.chatId, edit.draftId), AccessDenied);
    await assert.rejects(drafts.decide(w.id, user, editing.chatId, edit.draftId, approval), AccessDenied);
    const history = await chats.history(w.id, user, reading.chatId, {});
    assert.equal(JSON.stringify(history).includes('Private provider definition details.'), false);
    assert.equal(history.messages.flatMap(message => message.tools).flatMap(tool => tool.workflows ?? []).length, 0);
    const resumed = await turn([], { chatId: reading.chatId, fresh: false, text: 'No private source content.' });
    assert.equal(
      JSON.stringify(resumed.messages).includes('Private provider definition details.'),
      false,
      'revoked definitions do not return to model context',
    );
    await service.providers.share(w.id, w.userId, sheets, {
      principal: { kind: 'person', id: member },
      permissions: ['use'],
    });
    await service.providers.update(w.id, w.userId, sheets, {
      commandId: randomUUID(),
      expectedGeneration: 1,
      enabled: false,
    });
    assert.deepEqual(
      (await turn([{ tool: 'workflows.providers' }])).outputs[0].providers.map(source => source.id),
      [forms],
      'disabled sources are not authoring choices',
    );
    await assert.rejects(drafts.decide(w.id, user, editing.chatId, edit.draftId, approval), AccessDenied);
    await service.providers.update(w.id, w.userId, sheets, {
      commandId: randomUUID(),
      expectedGeneration: 2,
      enabled: true,
    });
    await assert.rejects(
      drafts.decide(w.id, user, editing.chatId, edit.draftId, approval),
      AccessDenied,
      'old source generations require a fresh reviewed draft',
    );

    const sharedId = randomUUID(),
      sharedRevision = randomUUID();
    const sharedDefinition = {
      version: 1,
      name: 'Shared manual review',
      trigger: { kind: 'manual' },
      steps: [{ id: 'copy', kind: 'transform', fields: {} }],
    };
    await service.save(w.id, w.userId, sharedId, {
      revision: sharedRevision,
      expectedRevision: null,
      definition: sharedDefinition,
    });
    await service.activate(w.id, w.userId, sharedId, {
      commandId: randomUUID(),
      expectedGeneration: 1,
      revision: sharedRevision,
      enabled: true,
    });
    await service.share(w.id, w.userId, sharedId, {
      principal: { kind: 'person', id: member },
      permissions: ['manage'],
    });
    const disabling = await turn([{ tool: 'workflows.draft', workflowId: sharedId, activate: false }]);
    const disable = disabling.outputs[0];
    assert.equal(disable.status, 'review-required');
    await drafts.decide(w.id, user, disabling.chatId, disable.draftId, {
      commandId: randomUUID(),
      digest: disable.digest,
      decision: 'save',
    });
    assert.deepEqual(
      (await turn([{ tool: 'workflows.read', workflowId: sharedId }], { actor: w.userId })).outputs[0].definition,
      sharedDefinition,
      "disabling in another manager's private chat does not change definition provenance",
    );
  },
);

test(
  'chat approval saves and activates an eligible agent step without needing a runner in the draft service',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const { agentId } = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId);
    const definition = {
      version: 1,
      name: 'Ask the support agent',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'review',
          kind: 'agent',
          agentId,
          prompt: { kind: 'input', path: ['message'] },
          limits: { toolCalls: 12, activeMilliseconds: 6000, credits: 4 },
        },
      ],
    };
    const chats = createConversations(runtime),
      drafts = createAuthoringDrafts(runtime),
      workflows = createWorkflows(runtime);
    const chatId = randomUUID();
    await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Prepare a workflow that asks my support agent to review the input message.' }],
    });
    let proposed;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      proposed = await executeTool('workflows.draft', false, context =>
        createChatTools(context.runtime).invoke(context, {
          tool: 'workflows.draft',
          definition: JSON.stringify(definition),
          activate: true,
        }),
      );
      return { text: 'Review the workflow card.', sources: [] };
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    assert.equal(proposed.status, 'review-required');
    assert.deepEqual(await workflows.list(w.id, w.userId), []);
    const approval = { commandId: randomUUID(), digest: proposed.digest, decision: 'save' };
    const outcome = await drafts.decide(w.id, w.userId, chatId, proposed.draftId, approval);
    assert.equal(outcome.activation, 'activated');
    assert.deepEqual(await drafts.decide(w.id, w.userId, chatId, proposed.draftId, approval), outcome);
    const [saved] = await workflows.list(w.id, w.userId);
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.definition, definition);
    await assert.rejects(
      workflows.save(w.id, w.userId, randomUUID(), { revision: randomUUID(), expectedRevision: null, definition }),
      /agent-steps-unavailable/,
      'a service without agent execution support still refuses new agent steps',
    );
  },
);

function newYorkTime(iso) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map(part => [part.type, part.value]),
  );
  return { weekday: parts.weekday, time: `${parts.hour}:${parts.minute}` };
}
function assertNextWeekdayNine(iso, before) {
  const local = newYorkTime(iso);
  assert.equal(local.time, '09:00', iso);
  assert.ok(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(local.weekday), iso);
  const at = Date.parse(iso);
  assert.ok(at > before && at - before <= 4 * 86400000, iso);
}

test('chat request for a weekday 9am New York review becomes an approved, active cron workflow', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const member = randomUUID(),
    user = randomUUID(),
    outsiderMember = randomUUID(),
    outsider = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member')`,
    [member, user, outsiderMember, outsider],
  );
  const woken = [];
  const committed = async work =>
    (
      await db.platform.query(
        `SELECT r.status,r.error,w.enabled,w.revision FROM ${table('tf_workflow_runs')} r JOIN ${table('tf_workflows')} w ON w.id=r.workflow_id WHERE r.id=$1`,
        [work.runId],
      )
    ).rows[0];
  const wake = async work => {
    woken.push({ work, seen: await committed(work) });
  };
  const chats = createConversations(runtime),
    drafts = createAuthoringDrafts(runtime, undefined, wake),
    workflows = createWorkflows(runtime),
    chatId = randomUUID();
  await chats.create(w.id, user, { chatId, commandId: randomUUID() });
  async function chatTool(call) {
    const sent = await chats.send(w.id, user, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Every weekday at 9am in New York, ask me to review open tickets.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      output = (
        await executeTool(
          call.tool,
          false,
          context => createChatTools(context.runtime).invokeWithSources(context, call),
          [],
          call,
        )
      ).result;
      return { text: 'Review the workflow card.', sources: [] };
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    return output;
  }

  const invalid = await chatTool({
    tool: 'workflows.draft',
    definition: JSON.stringify({ ...weekdayReview, steps: [] }),
    activate: true,
  });
  assert.equal(invalid.error, 'invalid-arguments');
  assert.deepEqual(
    invalid.issues.map(issue => issue.path),
    [['steps']],
  );

  const before = Date.now();
  const proposed = await chatTool({
    tool: 'workflows.draft',
    definition: JSON.stringify(weekdayReview),
    activate: true,
  });
  assert.equal(proposed.status, 'review-required');
  assert.equal(proposed.change, 'create');
  assert.equal(proposed.activateOnSave, true);
  assertNextWeekdayNine(proposed.nextRunAt, before);
  assert.deepEqual(await workflows.list(w.id, user), [], 'nothing is saved before approval');

  const pending = await drafts.read(w.id, user, chatId, proposed.draftId);
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.proposal, {
    kind: 'workflow',
    targetId: proposed.workflowId,
    input: { expectedRevision: null, definition: weekdayReview, activate: true },
  });
  assertNextWeekdayNine(pending.workflowNextRunAt, before);
  await assert.rejects(drafts.read(w.id, outsider, chatId, proposed.draftId), AccessDenied);
  await assert.rejects(
    drafts.decide(w.id, outsider, chatId, proposed.draftId, {
      commandId: randomUUID(),
      digest: proposed.digest,
      decision: 'save',
    }),
    AccessDenied,
  );

  const approval = { commandId: randomUUID(), digest: proposed.digest, decision: 'save' };
  const outcome = await drafts.decide(w.id, user, chatId, proposed.draftId, approval);
  assert.equal(outcome.kind, 'workflow');
  assert.equal(outcome.activation, 'activated');
  assert.equal(outcome.enabled, true);
  assert.equal(outcome.workflowId, proposed.workflowId);
  assertNextWeekdayNine(outcome.nextRunAt, before);
  assert.deepEqual(
    await drafts.decide(w.id, user, chatId, proposed.draftId, approval),
    outcome,
    'retrying the same approval changes nothing',
  );
  assert.equal((await drafts.read(w.id, user, chatId, proposed.draftId)).status, 'saved');

  const [saved] = await workflows.list(w.id, user);
  assert.equal(saved.id, proposed.workflowId);
  assert.equal(saved.enabled, true);
  assert.equal(saved.activeRevision, saved.revision);
  assert.deepEqual(saved.definition, weekdayReview);
  assert.equal(saved.sponsorMembershipId, member);
  assert.equal(saved.nextRunAt, outcome.nextRunAt);
  assert.deepEqual(await workflows.list(w.id, outsider), [], 'a member without a grant cannot see it');

  const listed = await chatTool({ tool: 'workflows.list' });
  assert.deepEqual(
    listed.workflows.map(item => ({ id: item.id, name: item.name, enabled: item.enabled, canManage: item.canManage })),
    [{ id: saved.id, name: 'Review open tickets', enabled: true, canManage: true }],
  );
  const complete = await chatTool({ tool: 'workflows.read', workflowId: saved.id });
  assert.deepEqual(complete.definition, weekdayReview);
  assert.equal(complete.revision, saved.revision);
  const receipt = (await chats.history(w.id, user, chatId, {})).messages
    .flatMap(message => message.tools)
    .find(tool => tool.tool === 'workflows.read');
  assert.deepEqual(receipt.workflows, [
    { workflowId: saved.id, revision: saved.revision, name: saved.definition.name },
  ]);

  assert.deepEqual(woken, [], 'creating a workflow wakes no runs');
  const { runId } = await workflows.start(w.id, user, saved.id, { requestId: randomUUID(), input: {} });
  assert.deepEqual(await workflows.advance({ workspaceId: w.id, runId }), { kind: 'wait', seconds: 86400 });

  const edited = await chatTool({
    tool: 'workflows.draft',
    workflowId: saved.id,
    revision: saved.revision,
    definition: JSON.stringify({ ...weekdayReview, name: 'Review urgent tickets' }),
    activate: true,
  });
  const reactivated = await drafts.decide(w.id, user, chatId, edited.draftId, {
    commandId: randomUUID(),
    digest: edited.digest,
    decision: 'save',
  });
  assert.equal(reactivated.activation, 'activated');
  assert.notEqual(reactivated.revision, saved.revision);
  assert.deepEqual(
    woken.splice(0),
    [
      {
        work: { workspaceId: w.id, runId },
        seen: { status: 'waiting', error: null, enabled: true, revision: reactivated.revision },
      },
    ],
    'activating a new revision from chat wakes the waiting run after it commits',
  );

  const disable = await chatTool({ tool: 'workflows.draft', workflowId: saved.id, activate: false });
  assert.equal(disable.status, 'review-required');
  assert.equal((await workflows.list(w.id, user))[0].enabled, true, 'disabling also waits for approval');
  assert.deepEqual(woken, [], 'proposing a change wakes nothing');
  const disapproval = { commandId: randomUUID(), digest: disable.digest, decision: 'save' };
  const disabled = await drafts.decide(w.id, user, chatId, disable.draftId, disapproval);
  assert.deepEqual(
    { activation: disabled.activation, enabled: disabled.enabled, nextRunAt: disabled.nextRunAt },
    { activation: 'disabled', enabled: false, nextRunAt: null },
  );
  assert.deepEqual(
    woken.splice(0),
    [
      {
        work: { workspaceId: w.id, runId },
        seen: { status: 'blocked', error: 'workflow-disabled', enabled: false, revision: reactivated.revision },
      },
    ],
    'disabling from chat wakes the waiting run after it commits',
  );
  assert.deepEqual(await drafts.decide(w.id, user, chatId, disable.draftId, disapproval), disabled);
  assert.deepEqual(woken, [], 'a replayed approval changes nothing and wakes nothing');

  assert.equal(
    (await chatTool({ tool: 'workflows.draft', workflowId: saved.id, activate: false })).error,
    'already-disabled',
  );
  const stale = await chatTool({
    tool: 'workflows.draft',
    workflowId: saved.id,
    revision: randomUUID(),
    definition: JSON.stringify(weekdayReview),
    activate: false,
  });
  assert.equal(stale.error, 'draft-stale', 'an edit against an old revision is refused');
});

test('chat drafts a record-date reminder that names its table and field on the card, and refuses sources the human cannot use', async t => {
  const db = await fixture();
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations());
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  cleanup.push(() => runtime.close());
  const migration = await connect(db.login(w, 'migration'));
  cleanup.push(() => migration.end());
  const table = name => `"${w.names.schema}".${name}`;
  const team = randomUUID(),
    outsider = { userId: randomUUID(), membershipId: randomUUID() };
  await db.platform.query(`INSERT INTO ${table('tf_teams')}(id,name) VALUES($1,'Support')`, [team]);
  await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
    outsider.membershipId,
    outsider.userId,
  ]);
  const field = (label, kind, extra = {}) => ({ id: randomUUID(), label, required: false, kind, ...extra });
  const due = field('Due date', 'date'),
    meeting = field('Meeting', 'timestamp', { timezone: 'UTC' });
  const open = { id: randomUUID(), label: 'Open', retired: false },
    stage = field('Stage', 'single-select', { options: [open, { id: randomUUID(), label: 'Closed', retired: false }] });
  const tickets = {
    formatVersion: 2,
    id: randomUUID(),
    owningTeamId: team,
    label: 'Tickets',
    fields: [field('Title', 'text', { maxLength: 200 }), due, meeting, stage],
    uniqueKeys: [],
  };
  await inTransaction(migration, async client => {
    await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
    const tx = { client, schema: w.names.schema };
    const generation = await createGeneration(tx, { definition: tickets, revision: '1'.repeat(40) });
    await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
  });

  const chats = createConversations(runtime),
    drafts = createAuthoringDrafts(runtime),
    workflows = createWorkflows(runtime);
  async function chatTool(user, call) {
    const chatId = randomUUID();
    await chats.create(w.id, user, { chatId, commandId: randomUUID() });
    const sent = await chats.send(w.id, user, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'The day before each ticket is due, at 9am New York time, note the ticket.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      output = await executeTool(call.tool, false, context => createChatTools(context.runtime).invoke(context, call));
      return { text: 'Review the workflow card.', sources: [] };
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    return { chatId, output };
  }
  const trigger = {
    kind: 'record',
    tableId: tickets.id,
    field: {
      kind: 'date',
      fieldId: due.id,
      offset: { direction: 'before', amount: 1, unit: 'days' },
      time: '09:00',
      timezone: 'America/New_York',
    },
    filter: { fieldId: stage.id, match: 'is', value: { kind: 'single-select', optionId: open.id } },
  };
  const reminder = {
    version: 1,
    name: 'Ticket due reminder',
    trigger,
    steps: [{ id: 'note', kind: 'transform', fields: { record: { kind: 'input', path: ['recordId'] } } }],
  };
  const draft = async (user, definition) =>
    (await chatTool(user, { tool: 'workflows.draft', definition: JSON.stringify(definition), activate: true })).output;

  assert.equal(
    (await draft(w.userId, { ...reminder, trigger: { ...trigger, field: { ...trigger.field, fieldId: meeting.id } } }))
      .error,
    'record-field-unavailable',
    'a date trigger on a timestamp field is refused',
  );
  assert.equal(
    (
      await draft(w.userId, {
        ...reminder,
        trigger: { ...trigger, field: { ...trigger.field, timezone: 'Mars/Olympus_Mons' } },
      })
    ).error,
    'invalid-schedule',
  );
  assert.equal(
    (
      await draft(w.userId, {
        ...reminder,
        trigger: {
          ...trigger,
          filter: { ...trigger.filter, value: { kind: 'single-select', optionId: randomUUID() } },
        },
      })
    ).error,
    'record-field-unavailable',
    'a filter on an option the field lacks is refused',
  );
  assert.equal(
    (await draft(outsider.userId, reminder)).error,
    'record-source-denied',
    'a member who cannot read the table cannot draft on it',
  );

  const { chatId, output: proposed } = await chatTool(w.userId, {
    tool: 'workflows.draft',
    definition: JSON.stringify(reminder),
    activate: true,
  });
  assert.equal(proposed.status, 'review-required');
  assert.equal(proposed.nextRunAt, null);
  assert.deepEqual(await workflows.list(w.id, w.userId), [], 'nothing is saved before approval');
  const pending = await drafts.read(w.id, w.userId, chatId, proposed.draftId);
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.workflowRecordSource, {
    table: 'Tickets',
    field: 'Due date',
    filter: { field: 'Stage', match: 'is', value: 'Open' },
  });

  const outcome = await drafts.decide(w.id, w.userId, chatId, proposed.draftId, {
    commandId: randomUUID(),
    digest: proposed.digest,
    decision: 'save',
  });
  assert.deepEqual(
    { activation: outcome.activation, enabled: outcome.enabled },
    { activation: 'activated', enabled: true },
  );
  const [saved] = await workflows.list(w.id, w.userId);
  assert.deepEqual(saved.definition.trigger, trigger);
  assert.equal(saved.sponsorMembershipId, w.membershipId);
  assert.deepEqual(saved.upcomingRecords, [], 'record dates appear after the first sweep');

  await workflows.share(w.id, w.userId, saved.id, {
    principal: { kind: 'person', id: outsider.membershipId },
    permissions: ['read', 'invoke', 'manage'],
  });
  const disable = await chatTool(w.userId, { tool: 'workflows.draft', workflowId: saved.id, activate: false });
  await drafts.decide(w.id, w.userId, disable.chatId, disable.output.draftId, {
    commandId: randomUUID(),
    digest: disable.output.digest,
    decision: 'save',
  });
  assert.equal(
    (await chatTool(outsider.userId, { tool: 'workflows.draft', workflowId: saved.id, activate: true })).output.error,
    'record-source-denied',
    'a manager who cannot read the table cannot draft activating it',
  );

  const review = {
    version: 1,
    name: 'Weekly review',
    trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'America/New_York' },
    steps: reminder.steps,
  };
  const shared = randomUUID(),
    first = randomUUID();
  await workflows.save(w.id, w.userId, shared, { revision: first, expectedRevision: null, definition: review });
  await workflows.share(w.id, w.userId, shared, {
    principal: { kind: 'person', id: outsider.membershipId },
    permissions: ['read'],
  });
  await workflows.sponsorship(w.id, w.userId, shared, {
    sponsorMembershipId: w.membershipId,
    historyAudience: [w.membershipId, outsider.membershipId],
  });
  const edit = await chatTool(w.userId, {
    tool: 'workflows.draft',
    workflowId: shared,
    revision: first,
    definition: JSON.stringify({ ...reminder, name: 'Weekly review' }),
    activate: true,
  });
  const kept = await drafts.decide(w.id, w.userId, edit.chatId, edit.output.draftId, {
    commandId: randomUUID(),
    digest: edit.output.digest,
    decision: 'save',
  });
  assert.deepEqual(
    { activation: kept.activation, enabled: kept.enabled },
    { activation: 'audience-required', enabled: false },
    'a history reader without table access stops activation but keeps the saved revision',
  );
  assert.deepEqual((await workflows.list(w.id, w.userId)).find(item => item.id === shared).definition.trigger, trigger);

  const title = tickets.fields[0];
  const logTicket = {
    version: 1,
    name: 'Log ticket',
    trigger: { kind: 'manual' },
    steps: [
      {
        id: 'add',
        kind: 'create-row',
        tableId: tickets.id,
        fields: { [title.id]: { kind: 'input', path: ['title'] } },
      },
    ],
  };
  assert.equal(
    (
      await draft(w.userId, {
        ...logTicket,
        steps: [{ ...logTicket.steps[0], fields: { [randomUUID()]: { kind: 'input', path: ['title'] } } }],
      })
    ).error,
    'table-step-field-unavailable',
    'a table step naming a field the table lacks is refused before review',
  );
  assert.equal(
    (await draft(outsider.userId, logTicket)).error,
    'table-step-access-denied',
    'a member who cannot read the table cannot draft a step on it',
  );
  assert.equal((await draft(w.userId, logTicket)).status, 'review-required');
  const tableDraft = await chatTool(w.userId, {
    tool: 'workflows.draft',
    definition: JSON.stringify(logTicket),
    activate: false,
  });
  const tablePending = await drafts.read(w.id, w.userId, tableDraft.chatId, tableDraft.output.draftId);
  assert.deepEqual(
    tablePending.workflowTableStepSources,
    [{ id: 'add', table: 'Tickets', fields: { [title.id]: title.label } }],
    'the chat card receives table and field names for table steps',
  );

  const rowTrigger = {
    kind: 'row',
    tableId: tickets.id,
    event: 'updated',
    fieldIds: [stage.id],
    filter: { fieldId: due.id, match: 'is-not-empty' },
  };
  const stageChange = {
    version: 1,
    name: 'Stage change note',
    trigger: rowTrigger,
    steps: [
      { id: 'note', kind: 'transform', fields: { stage: { kind: 'input', path: ['values', stage.id, 'value'] } } },
    ],
  };
  assert.equal(
    (await draft(w.userId, { ...stageChange, trigger: { ...rowTrigger, fieldIds: [randomUUID()] } })).error,
    'record-field-unavailable',
    'a row trigger watching a field the table lacks is refused before review',
  );
  assert.equal(
    (await draft(outsider.userId, stageChange)).error,
    'record-source-denied',
    'a member who cannot read the table cannot draft a row trigger on it',
  );
  const row = await chatTool(w.userId, {
    tool: 'workflows.draft',
    definition: JSON.stringify(stageChange),
    activate: false,
  });
  assert.equal(row.output.status, 'review-required');
  assert.equal(row.output.nextRunAt, null);
  const rowPending = await drafts.read(w.id, w.userId, row.chatId, row.output.draftId);
  assert.deepEqual(
    { record: rowPending.workflowRecordSource, row: rowPending.workflowRowSource },
    {
      record: null,
      row: { table: 'Tickets', fields: ['Stage'], filter: { field: 'Due date', match: 'is-not-empty', value: null } },
    },
  );
});
