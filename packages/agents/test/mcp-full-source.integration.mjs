import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AccessDenied, lockAuthorization, protectedSourceClosure, requireMcpSource } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { rolloutCommonMigrations, withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '@tulipfarm/conversations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { requireDraftSources } from '../src/draft-sources.ts';
import { savedTaskAgent } from './task-fixture.mjs';

async function setup(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  const w = await db.create(stream);
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const table = name => `"${w.names.schema}".${name}`;
  const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    actor.membershipId,
    actor.userId,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, actor.userId, actor.membershipId);
  stream.sort((a, b) => a.name.localeCompare(b.name));
  const rollout = await rolloutCommonMigrations({
    connectionString: db.connectionString,
    migrations: stream,
    listWorkspaceIds: async () => [w.id],
  });
  assert.equal(rollout.results[0].status, 'applied');
  const resource = { kind: 'table', tableId: randomUUID() };
  await db.platform.query(
    `INSERT INTO ${table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision,applied_revision) VALUES ($1,$2,'protected_source','Protected source','revision','revision')`,
    [resource.tableId, agent.teamId],
  );
  const grant = () =>
    db.platform.query(
      `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [agent.teamId, resource.tableId],
    );
  const revoke = () => db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE asset_id=$1`, [resource.tableId]);
  await grant();
  const tx = operation =>
    runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx);
    });
  const confirmation = operation =>
    withMaintenanceTransaction({
      workspaceId: w.id,
      connectionString: db.login(w, 'confirmation'),
      capability: 'confirmation',
      operation: async tx => {
        await lockAuthorization(tx);
        return operation(tx);
      },
    });
  async function chat() {
    const chats = createConversations(runtime),
      id = randomUUID();
    await chats.create(w.id, actor.userId, { chatId: id, commandId: randomUUID() });
    const sent = await chats.send(w.id, actor.userId, id, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Protected history title' }],
    });
    return { id, ...sent };
  }
  return { db, w, runtime, table, actor, agent, resource, grant, revoke, tx, confirmation, chat };
}

test('real confirmation authorization and reconstructed chat readers deny revoked action sources while MCP stays active', async t => {
  const f = await setup(t);
  const { createWorkspaceMcp } = await import(
    process.env.MCP_DOMAIN_MODULE
      ? pathToFileURL(process.env.MCP_DOMAIN_MODULE).href
      : new URL('../../workspace-mcp/dist/index.js', import.meta.url).href
  );
  const chat = await f.chat();
  let calls = 0,
    confirmations = 0;
  const options = {
    runtime: f.runtime,
    keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
    admissionEnabled: true,
    dispatchEnabled: true,
    resolveConfirmationCredential: async () => f.db.login(f.w, 'confirmation'),
    protocol: {
      discover: async () => ({
        tools: [
          {
            name: 'write',
            description: 'Write protected text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        ],
      }),
      call: async () => {
        calls++;
        return { content: [{ type: 'text', text: 'Protected receipt' }] };
      },
    },
    authorizeOrigin: async () => ({ sources: [f.resource], allowedTools: null }),
    authorizeSources: async ({ transaction, actor, sources }) => {
      const login = (await transaction.client.query('SELECT current_user AS login')).rows[0].login;
      if (login === f.w.names.confirmation) confirmations++;
      await requireDraftSources(transaction, actor, sources);
    },
    authorizeSelection: async () => ({ sources: [f.resource], slots: null }),
  };
  let service = createWorkspaceMcp(options);
  const integration = await service.create(f.w.id, f.actor, {
    name: 'Retained source test',
    ownership: 'personal',
    endpoint: 'https://example.com/mcp',
    credential: { kind: 'bearer', token: 'synthetic-fixture-token' },
  });
  const tools = await service.discover(f.w.id, f.actor, integration.id);
  await service.reviewTools(
    f.w.id,
    f.actor,
    integration.id,
    tools.map(tool => ({
      name: tool.name,
      revision: tool.discovered_revision,
      enabled: true,
      standingException: false,
    })),
  );
  const origin = { kind: 'private-chat', conversationId: chat.id, turnId: chat.turnId, stepId: randomUUID() };
  await service.setSelection(f.w.id, f.actor, { origin, expectedVersion: 0, integrationIds: [integration.id] });
  const catalog = await service.catalog(f.w.id, f.actor, origin);
  const action = await service.propose(f.w.id, f.actor, {
    id: randomUUID(),
    origin,
    handle: catalog.tools[0].handle,
    arguments: { text: 'Protected payload' },
  });
  assert.ok(action.sources.some(source => source.kind === 'table' && source.tableId === f.resource.tableId));
  await service.decide(f.w.id, f.actor, action.id, { digest: action.digest, decision: 'approve' });
  assert.ok(confirmations > 0);
  await service.dispatch(f.w.id, action.id);
  assert.equal(calls, 1);
  assert.equal((await service.action(f.w.id, f.actor, action.id)).receipt.status, 'succeeded');
  assert.equal(
    (await createConversations(f.runtime).read(f.w.id, f.actor.userId, chat.id)).title,
    'Protected history title',
  );
  assert.equal((await createConversations(f.runtime).history(f.w.id, f.actor.userId, chat.id)).messages.length, 1);
  await f.revoke();
  service = createWorkspaceMcp(options);
  await f.tx(tx =>
    requireMcpSource(
      tx,
      f.actor,
      action.sources.find(source => source.kind === 'mcp-integration'),
    ),
  );
  await assert.rejects(service.action(f.w.id, f.actor, action.id), /Resource not found/);
  await assert.rejects(
    service.decide(f.w.id, f.actor, action.id, { digest: action.digest, decision: 'approve' }),
    /Resource not found/,
  );
  const chats = createConversations(f.runtime);
  await assert.rejects(chats.read(f.w.id, f.actor.userId, chat.id), AccessDenied);
  await assert.rejects(chats.history(f.w.id, f.actor.userId, chat.id), AccessDenied);
  assert.deepEqual((await chats.list(f.w.id, f.actor.userId, { query: 'Protected' })).chats, []);
});

test('retained task and chat closures authorize native evidence, linked model sources and complete generated messages', async t => {
  const f = await setup(t);
  const source = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_mcp_integrations')} (id,ownership,owner_membership_id,name,endpoint,server_identity,auth_method,lifecycle,credential) VALUES ($1,'personal',$2,'Fixture','https://example.com/mcp','fixture','none','active','{}')`,
    [source.integrationId, f.actor.membershipId],
  );
  const sources = [source, f.resource];
  for (const mode of [
    'model',
    'receipt',
    'native-read',
    'admitted-resource',
    'generated-message',
    'linked-model',
    'private-task-model',
    'private-conversation-model',
  ])
    await t.test(mode, async () => {
      const tasks = createAgentTasks(f.runtime);
      const root = await tasks.start(f.w.id, f.actor.userId, {
        requestId: randomUUID(),
        agentId: f.agent.agentId,
        text: `Protected ${mode}`,
        sources: [source],
      });
      let evidenceTask = root;
      if (mode === 'linked-model' || mode === 'private-task-model') {
        evidenceTask = await tasks.start(f.w.id, f.actor.userId, {
          requestId: randomUUID(),
          agentId: f.agent.agentId,
          text: 'Linked evidence',
        });
        const reference =
          mode === 'linked-model'
            ? { kind: 'task', taskId: evidenceTask.id, throughSequence: 0 }
            : { kind: 'private-task', taskId: evidenceTask.id };
        await f.db.platform.query(`UPDATE ${f.table('tf_agent_task_messages')} SET sources=$2 WHERE task_id=$1`, [
          root.id,
          JSON.stringify([source, reference]),
        ]);
      }
      const runId = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope,task_id,task_generation) SELECT $1,agent_id,activation_id,definition_revision,'delegated',owner_user_id,owner_membership_id,scope,id,generation FROM ${f.table('tf_agent_tasks')} WHERE id=$2`,
        [runId, evidenceTask.id],
      );
      if (['model', 'linked-model', 'private-task-model'].includes(mode))
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_agent_task_steps')} (task_id,generation,run_id,step,mcp_sources) VALUES ($1,0,$2,0,$3)`,
          [evidenceTask.id, runId, JSON.stringify(sources)],
        );
      if (mode === 'admitted-resource')
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_agent_task_steps')} (task_id,generation,run_id,step,source_tables) VALUES ($1,0,$2,0,$3)`,
          [root.id, runId, [f.resource.tableId]],
        );
      if (mode === 'receipt' || mode === 'native-read')
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_agent_tool_calls')} (id,run_id,sequence,call,status,result) VALUES ($1,$2,0,$3,'completed',$4)`,
          [
            randomUUID(),
            runId,
            mode === 'receipt' ? { tool: 'mcp.call' } : { tool: 'rows.get', tableId: f.resource.tableId },
            mode === 'receipt' ? { kind: 'receipt', provider: 'workspace-mcp', sources } : { records: [] },
          ],
        );
      if (mode === 'generated-message')
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,1,0,'agent','Protected generated answer',$2)`,
          [
            root.id,
            JSON.stringify([
              ...sources,
              { kind: 'table-schema', tableId: f.resource.tableId, revision: 'revision' },
              ...Array.from({ length: 21 }, (_, i) => ({ kind: 'public-web', url: `https://example.com/${i}` })),
            ]),
          ],
        );
      let chat;
      if (mode === 'private-conversation-model') {
        chat = await f.chat();
        await f.db.platform.query(`INSERT INTO ${f.table('tf_conversation_model_sources')} VALUES ($1,1,1,$2)`, [
          chat.turnId,
          JSON.stringify(sources),
        ]);
        await f.db.platform.query(`UPDATE ${f.table('tf_agent_task_messages')} SET sources=$2 WHERE task_id=$1`, [
          root.id,
          JSON.stringify([source, { kind: 'private-conversation', conversationId: chat.id }]),
        ]);
      }
      const reference = [{ kind: 'private-task', taskId: root.id }];
      const closure = await f.tx(tx => protectedSourceClosure(tx, reference));
      assert.ok(closure.some(item => item.kind === 'table' && item.tableId === f.resource.tableId));
      await f.confirmation(tx => requireDraftSources(tx, f.actor, reference));
      assert.equal((await tasks.read(f.w.id, f.actor.userId, root.id)).id, root.id);
      assert.ok((await tasks.history(f.w.id, f.actor.userId, root.id)).messages.length);
      await f.revoke();
      await f.tx(tx => requireMcpSource(tx, f.actor, source));
      await assert.rejects(
        f.confirmation(tx => requireDraftSources(tx, f.actor, reference)),
        AccessDenied,
      );
      const rebuilt = createAgentTasks(f.runtime);
      await assert.rejects(rebuilt.read(f.w.id, f.actor.userId, root.id), AccessDenied);
      await assert.rejects(rebuilt.history(f.w.id, f.actor.userId, root.id), AccessDenied);
      assert.deepEqual((await rebuilt.list(f.w.id, f.actor.userId, { search: `Protected ${mode}` })).tasks, []);
      if (chat) {
        const rebuiltChats = createConversations(f.runtime);
        await assert.rejects(rebuiltChats.read(f.w.id, f.actor.userId, chat.id), AccessDenied);
        await assert.rejects(rebuiltChats.history(f.w.id, f.actor.userId, chat.id), AccessDenied);
        assert.deepEqual((await rebuiltChats.list(f.w.id, f.actor.userId, { query: 'Protected' })).chats, []);
      }
      await f.grant();
    });
});

test('pinned definitions and reviewed skills retain resource dependencies without explicit task resource references', async t => {
  const f = await setup(t);
  const source = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_mcp_integrations')} (id,ownership,owner_membership_id,name,endpoint,server_identity,auth_method,lifecycle,credential) VALUES ($1,'personal',$2,'Fixture','https://example.com/mcp','fixture','none','active','{}')`,
    [source.integrationId, f.actor.membershipId],
  );
  const tasks = createAgentTasks(f.runtime);
  for (const kind of ['definition-draft', 'workspace-skill'])
    await t.test(kind, async () => {
      const task = await tasks.start(f.w.id, f.actor.userId, {
        requestId: randomUUID(),
        agentId: f.agent.agentId,
        text: `Protected ${kind}`,
        sources: [source],
      });
      if (kind === 'definition-draft') {
        const chat = await f.chat(),
          callId = randomUUID();
        const command = (
          await f.db.platform.query(
            `SELECT c.id,s.revision AS soul_revision FROM ${f.table('tf_agent_commands')} c JOIN ${f.table('tf_soul_revisions')} s ON s.agent_command_id=c.id WHERE c.agent_id=$1`,
            [f.agent.agentId],
          )
        ).rows[0];
        await f.db.platform.query(`UPDATE ${f.table('tf_agent_commands')} SET accepted_revision=$2 WHERE id=$1`, [
          command.id,
          command.soul_revision,
        ]);
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'agent.draft','completed')`,
          [callId, chat.id, chat.turnId],
        );
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_chat_authoring_drafts')} (id,conversation_id,turn_id,membership_id,user_id,proposal,digest,sources) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            callId,
            chat.id,
            chat.turnId,
            f.actor.membershipId,
            f.actor.userId,
            { kind: 'agent', targetId: f.agent.agentId },
            'a'.repeat(64),
            JSON.stringify([f.resource]),
          ],
        );
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_chat_authoring_decisions')} (draft_id,membership_id,command_id,input,outcome) VALUES ($1,$2,$3,'{}',$4)`,
          [callId, f.actor.membershipId, randomUUID(), { kind: 'agent', receipt: { commandId: command.id } }],
        );
      } else {
        const skillId = randomUUID(),
          revision = 'b'.repeat(64);
        await f.db.platform.query('BEGIN');
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_workspace_skills')} (id,creator_id,saved_revision,active_revision,enabled) VALUES ($1,$2,$3,$3,true)`,
          [skillId, f.actor.membershipId, revision],
        );
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_workspace_skill_revisions')} (skill_id,revision,definition,author_id) VALUES ($1,$2,$3,$4)`,
          [
            skillId,
            revision,
            { name: 'Protected procedure', instructions: 'Use protected facts', sources: [f.resource] },
            f.actor.membershipId,
          ],
        );
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_workspace_skill_reviews')} (skill_id,revision,reviewer_id) VALUES ($1,$2,$3)`,
          [skillId, revision, f.w.membershipId],
        );
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_skill_person_grants')} (skill_id,membership_id,permission) SELECT $1,$2,unnest(ARRAY['read','use','manage'])`,
          [skillId, f.actor.membershipId],
        );
        await f.db.platform.query('COMMIT');
        await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET skills=$2 WHERE id=$1`, [
          task.id,
          JSON.stringify([{ id: skillId, revision }]),
        ]);
      }
      const reference = [{ kind: 'private-task', taskId: task.id }];
      assert.ok(
        (await f.tx(tx => protectedSourceClosure(tx, reference))).some(
          item => item.kind === 'table' && item.tableId === f.resource.tableId,
        ),
      );
      await f.confirmation(tx => requireDraftSources(tx, f.actor, reference));
      assert.ok((await tasks.history(f.w.id, f.actor.userId, task.id)).messages.length);
      await f.revoke();
      await f.tx(tx => requireMcpSource(tx, f.actor, source));
      const rebuilt = createAgentTasks(f.runtime);
      await assert.rejects(rebuilt.read(f.w.id, f.actor.userId, task.id), AccessDenied);
      await assert.rejects(rebuilt.history(f.w.id, f.actor.userId, task.id), AccessDenied);
      assert.deepEqual((await rebuilt.list(f.w.id, f.actor.userId, { search: `Protected ${kind}` })).tasks, []);
      await f.grant();
      if (kind === 'definition-draft')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_agent_commands')} SET accepted_revision=NULL WHERE agent_id=$1`,
          [f.agent.agentId],
        );
    });
});
