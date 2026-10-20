import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '@tulipfarm/conversations';
import { createWorkspaceMcp } from '@tulipfarm/workspace-mcp';
import {
  authorizeMcpOrigin,
  authorizeMcpSources,
  authorizeMcpSelection,
  taskMcpSources,
} from '@tulipfarm/agents/mcp-authority';
import { workspaceMcpFactory } from '../dist/workspace-mcp-composition.js';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { createTaskProgress } from '@tulipfarm/agents/task-progress';
import { createAgentExecutor } from '@tulipfarm/agents';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { createTaskComposition } from '../dist/task-composition.js';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../../packages/tables/test/fixture.mjs';
import {
  completionReply,
  isCompletionRequest,
  anthropicChat,
  anthropicText,
  isTitleRequest,
} from './native-chat-fixture.mjs';
import { useModelFamilies } from './model-families-fixture.mjs';

const tool = {
  name: 'write',
  description: 'Write exact text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 } },
    required: ['text'],
    additionalProperties: false,
  },
};
const route = {
  provider: 'anthropic',
  endpoint: 'https://api.anthropic.com/',
  model: 'claude-opus-5-5',
  apiKey: 'synthetic-model-key',
};
function response(decision) {
  return Response.json({
    model: route.model,
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'select_action', input: { decision } }],
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const chatResponse = decision => Response.json(anthropicChat(decision, { model: route.model, usage }));
async function setup(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  const workspace = await db.create(stream);
  const table = name => `"${workspace.names.schema}".${name}`;
  const open = () =>
    createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
    });
  runtime = open();
  const members = Array.from({ length: 2 }, () => ({
    kind: 'human',
    userId: randomUUID(),
    membershipId: randomUUID(),
  }));
  for (const member of members)
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
  const calls = [];
  let provider = async () => ({
    content: [{ type: 'text', text: 'Confirmed private receipt' }],
    structuredContent: { ticket: 7 },
  });
  const options = {
    keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
    protocol: {
      discover: async () => ({ tools: [tool] }),
      call: async input => {
        calls.push(input);
        return provider(input);
      },
    },
    admissionEnabled: true,
    dispatchEnabled: true,
    resolveConfirmationCredential: async () => db.login(workspace, 'confirmation'),
  };
  const factory = workspaceMcpFactory(options);
  const domain = () =>
    createWorkspaceMcp({
      ...options,
      runtime,
      authorizeOrigin: authorizeMcpOrigin,
      authorizeSources: authorizeMcpSources,
      authorizeSelection: authorizeMcpSelection,
    });
  async function connect(actor = members[0], ownership = 'personal', credential = { kind: 'none' }) {
    const service = domain();
    const integration = await service.create(workspace.id, actor, {
      ownership,
      name: 'Fixture account',
      endpoint: 'https://mcp.example.com/tools',
      credential,
    });
    const tools = await service.discover(workspace.id, actor, integration.id);
    await service.reviewTools(
      workspace.id,
      actor,
      integration.id,
      tools.map(row => ({ name: row.name, revision: row.discovered_revision, enabled: true, standingException: true })),
    );
    if (ownership === 'personal')
      await service.approveServerDescriptor(workspace.id, actor, integration.id, integration.serverIdentity);
    return { ...integration, revision: tools[0].discovered_revision };
  }
  async function select(actor, origin, integrationIds) {
    return domain().selectFor(workspace.id, actor, {
      origin:
        origin.kind === 'private-chat'
          ? { kind: 'chat', id: origin.conversationId }
          : { kind: 'task', id: origin.taskId },
      requestId: randomUUID(),
      expectedVersion: 0,
      bindings: integrationIds.map(integrationId => ({
        integrationId,
        slotId: origin.kind === 'private-chat' ? null : 'tickets',
      })),
    });
  }
  return {
    db,
    workspace,
    table,
    members,
    calls,
    factory,
    options,
    domain,
    connect,
    select,
    get runtime() {
      return runtime;
    },
    setProvider(value) {
      provider = value;
    },
    async restart() {
      await runtime.close();
      runtime = open();
    },
  };
}

for (const orphaned of [false, true])
  test(
    `compiled chat activity ${orphaned ? 'recovers an orphan with revoked requester and dispatch disabled' : 'waits for exact consent and resumes inference after restart once'}`,
    { timeout: 180000 },
    async t => {
      const f = await setup(t),
        w = f.workspace,
        actor = f.members[0];
      const oldKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'synthetic-model-key';
      t.after(() => {
        if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = oldKey;
      });
      t.after(useModelFamilies('claude-haiku,claude-sonnet,claude-opus'));
      const integration = await f.connect(actor),
        chatId = randomUUID();
      const chats = () => createConversations(f.runtime);
      await chats().create(w.id, actor.userId, { chatId, commandId: randomUUID() });
      const sent = await chats().send(w.id, actor.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-opus',
        parts: [{ kind: 'text', text: 'Private instructions to create ticket' }],
      });
      const origin = { kind: 'private-chat', conversationId: chatId, turnId: sent.turnId, stepId: sent.turnId };
      const handle = (await f.domain().catalog(w.id, actor, origin)).tools[0].handle;
      let modelCalls = 0;
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const body = JSON.parse(init.body);
        if (isTitleRequest(body))
          return Response.json(anthropicText('Secret derived title', { model: route.model, usage }));
        if (isCompletionRequest(body))
          return Response.json({ ...completionReply('anthropic'), model: route.model, usage });
        modelCalls++;
        if (modelCalls === 1) {
          assert.match(JSON.stringify(body), new RegExp(`Account: ${integration.name}`));
          return chatResponse({
            kind: 'tool',
            call: { tool: 'mcp.call', handle, arguments: { text: 'Exact private payload' } },
          });
        }
        assert.match(JSON.stringify(body), /Confirmed private receipt/);
        assert.match(JSON.stringify(body), /Do not repeat/);
        return chatResponse({ kind: 'answer', text: 'The provider returned ticket 7.' });
      });
      const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
      const run = () =>
        createConversationActivities(f.runtime, undefined, undefined, f.factory).processConversationReply(work);
      assert.equal(await run(), 'idle');
      assert.equal(f.calls.length, 0);
      assert.equal(modelCalls, 1);
      const actionId = (await f.db.platform.query(`SELECT id FROM ${f.table('tf_mcp_actions')}`)).rows[0].id;
      let action = await f.domain().action(w.id, actor, actionId);
      assert.equal(action.requiresConsent, true);
      assert.equal(action.status, 'awaiting-approval');
      assert.deepEqual(action.arguments, { text: 'Exact private payload' });
      await assert.rejects(
        f.domain().decide(w.id, f.members[1], actionId, { digest: action.digest, decision: 'approve' }),
      );
      await f.restart();
      assert.equal(await run(), 'idle');
      assert.equal(modelCalls, 1);
      action = await f.domain().action(w.id, actor, actionId);
      await f.domain().decide(w.id, actor, actionId, { digest: action.digest, decision: 'approve' });
      if (orphaned) {
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_mcp_claims')} (action_id,integration_id,token,deadline) VALUES ($1,$2,$3,clock_timestamp()-interval '1 second')`,
          [actionId, integration.id, randomUUID()],
        );
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          actor.membershipId,
        ]);
        await f.restart();
        const disabled = workspaceMcpFactory({ ...f.options, admissionEnabled: false, dispatchEnabled: false });
        for (let i = 0; i < 2; i++)
          await createConversationActivities(f.runtime, undefined, undefined, disabled).processConversationReply(work);
        const receipts = (
          await f.db.platform.query(`SELECT status,result FROM ${f.table('tf_mcp_receipts')} WHERE action_id=$1`, [
            actionId,
          ])
        ).rows;
        assert.deepEqual(receipts, [{ status: 'outcome-unknown', result: null }]);
        assert.equal(f.calls.length, 0);
        assert.equal(modelCalls, 1);
        await assert.rejects(f.domain().action(w.id, actor, actionId));
        return;
      }
      assert.equal(await run(), 'completed');
      assert.equal(f.calls.length, 1);
      assert.equal(modelCalls, 2);
      assert.equal(await run(), 'idle');
      const history = await chats().history(w.id, actor.userId, chatId);
      assert.equal(history.messages.at(-1).parts[0].text, 'The provider returned ticket 7.');
      assert.notEqual((await chats().read(w.id, actor.userId, chatId)).title, 'Secret derived title');
      assert.equal(
        (
          await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1`, [
            chatId,
          ])
        ).rows[0].n,
        4,
        'two tool-loop steps, the completion check and the metered title request',
      );
      const charged = (
        await f.db.platform.query(
          `SELECT model_id FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1 ORDER BY created_at, id`,
          [chatId],
        )
      ).rows.map(row => row.model_id);
      assert.deepEqual(
        charged.map(model => model === 'claude-haiku-4-5'),
        [false, false, false, true],
        'the title request is charged at the title model rates',
      );
      await f.domain().setLifecycle(w.id, actor, integration.id, 'disabled');
      await assert.rejects(chats().history(w.id, actor.userId, chatId));
    },
  );

test(
  'native task reads enter immutable MCP consent and revocation blocks read, approval and dispatch',
  { timeout: 180000 },
  async t => {
    const f = await setup(t),
      w = f.workspace,
      actor = f.members[0];
    const environment = {
      MODEL_FAMILIES: 'claude-opus',
      MODEL_DEFAULT_FAMILY: 'claude-opus',
      ANTHROPIC_API_KEY: 'synthetic-model-key',
    };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const integration = await f.connect(actor);
    const agent = await savedTaskAgent(f.db, w, f.runtime, actor.userId, actor.membershipId, [], ['rows.list']);
    const definition = {
      name: 'Native source task',
      instructions: 'Read the record and send the exact text.',
      tools: ['rows.list'],
      mcp: [
        {
          id: 'tickets',
          serverIdentity: integration.serverIdentity,
          tools: [{ name: tool.name, revision: integration.revision }],
        },
      ],
    };
    const revision = createHash('sha256').update(canonicalJson(definition)).digest('hex');
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
      [agent.agentId, revision, definition],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_agent_saved_revisions')} SET definition_revision=$2 WHERE agent_id=$1`,
      [agent.agentId, revision],
    );
    const recordId = randomUUID(),
      appliedRevision = 'a'.repeat(40),
      name = textField();
    const { tableId } = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      revision: appliedRevision,
      definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Private contacts', fields: [name] }),
      records: [{ id: recordId, values: textValues(name, 'Native secret') }],
    });
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read'),($1,$2,'table.row.create')`,
      [agent.teamId, tableId],
    );
    const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
    await f.db.platform.query(
      `UPDATE ${f.table('tf_agent_activations')} SET definition_revision=$2,scope=$3 WHERE id=$1`,
      [agent.activationId, revision, JSON.stringify(scope)],
    );
    await createAgentExecutor({ runtime: f.runtime }).configure(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: scope },
    );
    const selectionId = randomUUID();
    const selected = await f.domain().selectFor(w.id, actor, {
      origin: { kind: 'task-draft', id: selectionId, agentId: agent.agentId },
      requestId: randomUUID(),
      expectedVersion: 0,
      bindings: [{ integrationId: integration.id, slotId: 'tickets' }],
    });
    const task = await createAgentTasks(f.runtime, (tx, member, input) =>
      f.domain().claimTaskSelection(tx, member, input),
    ).start(w.id, actor.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope,
      text: 'Use the private contact',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
      mcpSelection: { selectionId, version: selected.version },
    });
    let modelCalls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body),
        context = JSON.parse(body.messages.at(-1).content);
      modelCalls++;
      if (!context.results.length)
        return response({
          kind: 'tool',
          text: 'Read contact',
          call: { tool: 'rows.list', tableId, expectedAppliedRevision: appliedRevision, query: { limit: 10 } },
        });
      assert.match(JSON.stringify(context), /Native secret/);
      const handle = JSON.stringify(body).match(/"handle":\{"const":"([a-f0-9]+)"\}/)?.[1];
      return response({
        kind: 'tool',
        text: 'Request consent',
        call: { tool: 'mcp.call', handle, arguments: { text: 'Native secret' } },
      });
    });
    const step = async () => {
      const composition = createTaskComposition(f.runtime, f.factory);
      try {
        return await composition.activities.processAgentTaskStep(w.id, task.id);
      } finally {
        await composition.close();
      }
    };
    for (let i = 0; i < 4; i++) await step();
    const stored = (
      await f.db.platform.query(`SELECT id,sources FROM ${f.table('tf_mcp_actions')} WHERE origin->>'taskId'=$1`, [
        task.id,
      ])
    ).rows[0];
    assert.ok(stored.sources.some(source => source.kind === 'table' && source.tableId === tableId));
    assert.ok(stored.sources.some(source => source.kind === 'agent-definition' && source.agentId === agent.agentId));
    const action = await f.domain().action(w.id, actor, stored.id);
    const revoke = () =>
      f.db.platform.query(
        `DELETE FROM ${f.table('tf_grants')} WHERE team_id=$1 AND asset_id=$2 AND permission='table.row.read'`,
        [agent.teamId, tableId],
      );
    const restore = () =>
      f.db.platform.query(
        `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [agent.teamId, tableId],
      );
    await revoke();
    await assert.rejects(f.domain().action(w.id, actor, stored.id));
    await assert.rejects(f.domain().decide(w.id, actor, stored.id, { digest: action.digest, decision: 'approve' }));
    await restore();
    await f.domain().decide(w.id, actor, stored.id, { digest: action.digest, decision: 'approve' });
    await revoke();
    await assert.rejects(f.domain().dispatch(w.id, stored.id));
    await f.restart();
    await step();
    assert.equal(
      (await f.db.platform.query(`SELECT status FROM ${f.table('tf_agent_tasks')} WHERE id=$1`, [task.id])).rows[0]
        .status,
      'failed',
    );
    assert.equal(f.calls.length, 0);
    assert.equal(modelCalls, 2);
    await restore();
    const retainedOnly = { kind: 'public-web', url: 'https://example.com/retained-model-evidence' };
    await f.db.platform.query(
      `UPDATE ${f.table('tf_agent_task_steps')} SET mcp_sources=mcp_sources || $2::jsonb WHERE task_id=$1`,
      [task.id, JSON.stringify([retainedOnly])],
    );
    const throughSequence = (
      await f.db.platform.query(
        `SELECT max(sequence) AS sequence FROM ${f.table('tf_agent_task_messages')} WHERE task_id=$1`,
        [task.id],
      )
    ).rows[0].sequence;
    const linked = await createAgentTasks(f.runtime).start(w.id, actor.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope,
      text: 'Continue retained context',
      sources: [{ kind: 'task', taskId: task.id, throughSequence }],
    });
    const closure = await f.runtime.transaction(w.id, commonCompatibility, tx => taskMcpSources(tx, actor, linked.id));
    assert.ok(
      closure.some(source => canonicalJson(source) === canonicalJson(retainedOnly)),
      'linked task retains a dependency present only in saved model evidence',
    );
  },
);

for (const orphaned of [false, true])
  test(
    `named task activities ${orphaned ? 'recover orphan claims with revoked requesters and dispatch disabled' : 'bind separate personal accounts and resume the model with accounted receipts'}`,
    { timeout: 180000 },
    async t => {
      const f = await setup(t),
        w = f.workspace;
      const environment = {
        MODEL_FAMILIES: 'claude-opus',
        MODEL_DEFAULT_FAMILY: 'claude-opus',
        ANTHROPIC_API_KEY: 'synthetic-model-key',
      };
      const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
      Object.assign(process.env, environment);
      t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      const integrations = await Promise.all(f.members.map(actor => f.connect(actor)));
      const agent = await savedTaskAgent(f.db, w, f.runtime, f.members[0].userId, f.members[0].membershipId, [], []);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        f.members[1].membershipId,
        agent.teamId,
      ]);
      const definition = {
        name: 'Shared named agent',
        instructions: 'Complete the private request.',
        tools: [],
        mcp: [
          {
            id: 'tickets',
            serverIdentity: integrations[0].serverIdentity,
            tools: [{ name: tool.name, revision: integrations[0].revision }],
          },
        ],
      };
      const revision = createHash('sha256').update(canonicalJson(definition)).digest('hex');
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [agent.agentId, revision, definition],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_agent_saved_revisions')} SET definition_revision=$2 WHERE agent_id=$1`,
        [agent.agentId, revision],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET definition_revision=$2 WHERE id=$1`, [
        agent.activationId,
        revision,
      ]);
      await createAgentExecutor({ runtime: f.runtime }).configure(
        w.id,
        { kind: 'human', userId: w.userId, membershipId: w.membershipId },
        { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
      );
      let modelCalls = 0;
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const body = JSON.parse(init.body),
          context = JSON.parse(body.messages.at(-1).content);
        modelCalls++;
        if (context.results.length) {
          assert.match(JSON.stringify(context), /Confirmed private receipt/);
          return response({ kind: 'answer', text: 'Completed with provider receipt.' });
        }
        const encoded = JSON.stringify(body);
        const handle = encoded.match(/"handle":\{"const":"([a-f0-9]+)"\}/)?.[1];
        assert.ok(handle, 'exact selected handle is exposed');
        return response({
          kind: 'tool',
          text: 'Request exact consent.',
          call: { tool: 'mcp.call', handle, arguments: { text: 'Private task payload' } },
        });
      });
      for (const [i, actor] of f.members.entries()) {
        const tasks = createAgentTasks(f.runtime, (tx, member, input) =>
          f.domain().claimTaskSelection(tx, member, input),
        );
        const selectionId = randomUUID();
        const selected = await f.domain().selectFor(w.id, actor, {
          origin: { kind: 'task-draft', id: selectionId, agentId: agent.agentId },
          requestId: randomUUID(),
          expectedVersion: 0,
          bindings: [{ integrationId: integrations[i].id, slotId: 'tickets' }],
        });
        const request = {
          requestId: randomUUID(),
          agentId: agent.agentId,
          scope: [],
          text: 'Private task instructions',
          limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
          mcpSelection: { selectionId, version: selected.version },
        };
        await assert.rejects(createAgentTasks(f.runtime).start(w.id, actor.userId, request));
        const task = await tasks.start(w.id, actor.userId, request);
        assert.deepEqual(await tasks.start(w.id, actor.userId, request), task);
        await assert.rejects(tasks.start(w.id, actor.userId, { ...request, requestId: randomUUID() }));
        const origin = { kind: 'named-task', taskId: task.id, stepId: task.id };
        assert.equal((await f.domain().selection(w.id, actor, origin)).bindings[0].integrationId, integrations[i].id);
        const processStep = async () => {
          const composition = createTaskComposition(f.runtime, f.factory);
          try {
            return await composition.activities.processAgentTaskStep(w.id, task.id);
          } finally {
            await composition.close();
          }
        };
        await processStep();
        await processStep();
        assert.equal(
          (await tasks.read(w.id, actor.userId, task.id)).status,
          'waiting-approval',
          JSON.stringify(
            (
              await f.db.platform.query(
                `SELECT g.failure,c.status,c.result FROM ${f.table('tf_agent_task_runs')} b LEFT JOIN ${f.table('tf_model_generations')} g ON g.run_id=b.run_id LEFT JOIN ${f.table('tf_agent_tool_calls')} c ON c.run_id=b.run_id WHERE b.task_id=$1`,
                [task.id],
              )
            ).rows,
          ),
        );
        assert.deepEqual(await createTaskProgress(f.runtime)(w.id, task.id), { kind: 'waiting' });
        const row = (
          await f.db.platform.query(`SELECT id FROM ${f.table('tf_mcp_actions')} WHERE origin->>'taskId'=$1`, [task.id])
        ).rows[0];
        const action = await f.domain().action(w.id, actor, row.id);
        assert.equal(action.integrationId, integrations[i].id);
        assert.equal(action.requiresConsent, true);
        assert.ok(action.sources.some(source => source.kind === 'private-task' && source.taskId === task.id));
        await f.db.databaseAdmin.query('BEGIN');
        await f.db.databaseAdmin.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 648291))', [
          `${w.names.schema}:${task.id}`,
        ]);
        const approval = f.domain().decide(w.id, actor, row.id, { digest: action.digest, decision: 'approve' });
        try {
          let waiting = [];
          for (let attempt = 0; attempt < 100 && !waiting.length; attempt++) {
            waiting = (
              await f.db.admin.query(
                `SELECT a.wait_event_type,a.wait_event,l.locktype,l.mode,l.granted,pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.usename=$1 AND a.wait_event_type='Lock' AND NOT l.granted`,
                [w.names.confirmation],
              )
            ).rows;
            if (!waiting.length) await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal(waiting.length, 1);
          assert.equal(waiting[0].wait_event_type, 'Lock');
          assert.equal(waiting[0].locktype, 'advisory');
          assert.equal(waiting[0].granted, false);
          assert.equal(waiting[0].blockers.length, 1);
          t.diagnostic(`Restricted confirmation waits on the held task advisory lock: ${JSON.stringify(waiting[0])}`);
        } finally {
          await f.db.databaseAdmin.query('ROLLBACK');
        }
        await approval;
        await f.restart();
        if (orphaned) {
          await f.db.platform.query(
            `INSERT INTO ${f.table('tf_mcp_claims')} (action_id,integration_id,token,deadline) VALUES ($1,$2,$3,clock_timestamp()-interval '1 second')`,
            [row.id, integrations[i].id, randomUUID()],
          );
          await f.db.platform.query(
            `UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`,
            [actor.membershipId],
          );
          const disabled = workspaceMcpFactory({ ...f.options, admissionEnabled: false, dispatchEnabled: false });
          const composition = createTaskComposition(f.runtime, disabled);
          try {
            for (let n = 0; n < 2; n++) await composition.activities.processAgentTaskStep(w.id, task.id);
          } finally {
            await composition.close();
          }
          assert.deepEqual(
            (
              await f.db.platform.query(`SELECT status,result FROM ${f.table('tf_mcp_receipts')} WHERE action_id=$1`, [
                row.id,
              ])
            ).rows,
            [{ status: 'outcome-unknown', result: null }],
          );
          await assert.rejects(f.domain().action(w.id, actor, row.id));
          continue;
        }
        await processStep();
        await processStep();
        const completed = await createAgentTasks(f.runtime).read(w.id, actor.userId, task.id);
        assert.equal(completed.status, 'completed');
        assert.equal(completed.toolCalls, 1);
        assert.ok(BigInt(completed.activeMilliseconds) > 0n);
        assert.equal(completed.cost.heldCreditUnits, '0');
        const retainedHistory = await createAgentTasks(f.runtime).history(w.id, actor.userId, task.id);
        assert.ok(
          retainedHistory.messages
            .at(-1)
            .sources.some(source => source.kind === 'agent-definition' && source.agentId === agent.agentId),
          'generated message retains the full admitted definition source',
        );
        const grants = (
          await f.db.databaseAdmin.query(
            `SELECT has_table_privilege($1,$2,'SELECT') AS readable,has_table_privilege($1,$2,'UPDATE') AS writable`,
            [w.names.confirmation, f.table('tf_conversation_execution_steps')],
          )
        ).rows[0];
        assert.deepEqual(grants, { readable: true, writable: false });
        if (i === 1) {
          await f.domain().setLifecycle(w.id, actor, integrations[i].id, 'disabled');
          await assert.rejects(createAgentTasks(f.runtime).history(w.id, actor.userId, task.id));
          await assert.rejects(
            createAgentTasks(f.runtime).reopen(w.id, actor.userId, task.id, {
              requestId: randomUUID(),
              expectedGeneration: 0,
              text: 'Continue revoked context',
            }),
          );
        }
      }
      assert.equal(f.calls.length, orphaned ? 0 : 2);
      assert.equal(modelCalls, orphaned ? 2 : 4);
      assert.equal(JSON.stringify(definition).includes(integrations[0].id), false);
      assert.equal(JSON.stringify(definition).includes(integrations[1].id), false);
    },
  );

test(
  'an expired unapproved task action resumes the model with an expired receipt and never dispatches',
  { timeout: 180000 },
  async t => {
    const f = await setup(t),
      w = f.workspace,
      actor = f.members[0];
    const environment = {
      MODEL_FAMILIES: 'claude-opus',
      MODEL_DEFAULT_FAMILY: 'claude-opus',
      ANTHROPIC_API_KEY: 'synthetic-model-key',
    };
    const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const integration = await f.connect(actor);
    const agent = await savedTaskAgent(f.db, w, f.runtime, actor.userId, actor.membershipId, [], []);
    const definition = {
      name: 'Expiring agent',
      instructions: 'Complete the private request.',
      tools: [],
      mcp: [
        {
          id: 'tickets',
          serverIdentity: integration.serverIdentity,
          tools: [{ name: tool.name, revision: integration.revision }],
        },
      ],
    };
    const revision = createHash('sha256').update(canonicalJson(definition)).digest('hex');
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
      [agent.agentId, revision, definition],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_agent_saved_revisions')} SET definition_revision=$2 WHERE agent_id=$1`,
      [agent.agentId, revision],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_agent_activations')} SET definition_revision=$2 WHERE id=$1`, [
      agent.activationId,
      revision,
    ]);
    await createAgentExecutor({ runtime: f.runtime }).configure(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
    );
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body),
        context = JSON.parse(body.messages.at(-1).content);
      if (context.results.length) {
        assert.match(JSON.stringify(context), /"status":"expired"/);
        return response({ kind: 'answer', text: 'The review expired; I will propose again if needed.' });
      }
      const handle = JSON.stringify(body).match(/"handle":\{"const":"([a-f0-9]+)"\}/)?.[1];
      assert.ok(handle, 'exact selected handle is exposed');
      return response({
        kind: 'tool',
        text: 'Request exact consent.',
        call: { tool: 'mcp.call', handle, arguments: { text: 'Private task payload' } },
      });
    });
    const tasks = createAgentTasks(f.runtime, (tx, member, input) => f.domain().claimTaskSelection(tx, member, input));
    const selectionId = randomUUID();
    const selected = await f.domain().selectFor(w.id, actor, {
      origin: { kind: 'task-draft', id: selectionId, agentId: agent.agentId },
      requestId: randomUUID(),
      expectedVersion: 0,
      bindings: [{ integrationId: integration.id, slotId: 'tickets' }],
    });
    const task = await tasks.start(w.id, actor.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope: [],
      text: 'Private task instructions',
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
      mcpSelection: { selectionId, version: selected.version },
    });
    const processStep = async () => {
      const composition = createTaskComposition(f.runtime, f.factory);
      try {
        return await composition.activities.processAgentTaskStep(w.id, task.id);
      } finally {
        await composition.close();
      }
    };
    await processStep();
    await processStep();
    assert.equal((await tasks.read(w.id, actor.userId, task.id)).status, 'waiting-approval');
    assert.deepEqual(await createTaskProgress(f.runtime)(w.id, task.id), { kind: 'waiting' });
    const row = (
      await f.db.platform.query(`SELECT id FROM ${f.table('tf_mcp_actions')} WHERE origin->>'taskId'=$1`, [task.id])
    ).rows[0];
    await f.db.platform.query(
      `UPDATE ${f.table('tf_mcp_actions')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [row.id],
    );
    assert.equal((await f.domain().action(w.id, actor, row.id)).status, 'expired');
    assert.deepEqual(await createTaskProgress(f.runtime)(w.id, task.id), { kind: 'runnable' });
    await processStep();
    await processStep();
    assert.equal((await tasks.read(w.id, actor.userId, task.id)).status, 'completed');
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT result->>'kind' AS kind,result->>'status' AS status FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`,
          [row.id],
        )
      ).rows,
      [{ kind: 'receipt', status: 'expired' }],
    );
    assert.equal(f.calls.length, 0);
  },
);
