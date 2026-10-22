import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied, mcpSourceClosure, requireNoMcpDerived, withMcpSourceContext } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { requireDraftSources } from '../src/draft-sources.ts';
import { requireTableSources } from '../src/table-sources.ts';
import { fetchPublicText } from '../src/web-fetch.ts';
import { createConversations } from '@tulipfarm/conversations';
import { requireResultSources } from '@tulipfarm/conversations/source-access';
import { recordConversationResultProvenance } from '@tulipfarm/conversations/provenance';
import { createFiles } from '../../files/dist/index.js';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createAtlassianOperations } from '@tulipfarm/atlassian/operations';
import { savedTaskAgent } from './task-fixture.mjs';
import { createTableService } from '@tulipfarm/tables/service';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { commonCompatibility } from '@tulipfarm/workspaces/storage';
import { createAgentAuthoring } from '../src/authoring.ts';
import { agentDefinitionSchema } from '../src/contracts.ts';
import { startTaskSchema } from '../src/task-contracts.ts';

test('retained MCP history, transitive definitions and save/egress boundaries fail closed', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create();
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const s = `"${w.names.schema}"`;
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const source = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
  await db.platform.query(
    `INSERT INTO ${s}.tf_mcp_integrations (id,ownership,owner_membership_id,name,endpoint,server_identity,auth_method,lifecycle,authorization_epoch,credential) VALUES ($1,'personal',$2,'Provenance fixture','https://example.com/mcp','fixture','none','active',1,'{}')`,
    [source.integrationId, actor.membershipId],
  );
  const tx = operation => runtime.transaction(w.id, commonCompatibility, operation);
  const agent = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId, []);
  const tasks = createAgentTasks(runtime);
  const first = await tasks.start(w.id, w.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Private MCP task',
    sources: [source],
  });
  const reference = { kind: 'task', taskId: first.id, throughSequence: 0 };
  const linked = await tasks.start(w.id, w.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Derived task',
    sources: [reference],
  });
  await tx(tx => requireDraftSources(tx, actor, [{ kind: 'private-task', taskId: first.id }]));
  await assert.rejects(
    tx(tx =>
      requireDraftSources(tx, { ...actor, membershipId: randomUUID() }, [{ kind: 'private-task', taskId: first.id }]),
    ),
    AccessDenied,
  );
  const selectedInput = {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Selected task',
    mcpSelection: { selectionId: randomUUID(), version: 1 },
  };
  await assert.rejects(tasks.start(w.id, w.userId, selectedInput), AccessDenied);
  let claims = 0;
  const selectedTasks = createAgentTasks(runtime, async (transaction, owner, claim) => {
    claims++;
    assert.equal(owner.membershipId, actor.membershipId);
    assert.equal(claim.selectionId, selectedInput.mcpSelection.selectionId);
    assert.equal(
      (
        await transaction.client.query(
          `SELECT count(*)::integer AS count FROM ${s}.tf_agent_task_messages WHERE task_id=$1`,
          [claim.taskId],
        )
      ).rows[0].count,
      1,
    );
  });
  const selectedTask = await selectedTasks.start(w.id, w.userId, selectedInput);
  assert.deepEqual(await selectedTasks.start(w.id, w.userId, selectedInput), selectedTask);
  assert.equal(claims, 1);
  const runId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_agent_runs (id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope,task_id,task_generation)
    SELECT $1,agent_id,activation_id,definition_revision,'delegated',owner_user_id,owner_membership_id,scope,id,generation FROM ${s}.tf_agent_tasks WHERE id=$2`,
    [runId, selectedTask.id],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_agent_task_steps (task_id,generation,run_id,step,mcp_sources) VALUES ($1,0,$2,0,$3)`,
    [selectedTask.id, runId, JSON.stringify([source])],
  );
  assert.deepEqual(
    await tx(tx => mcpSourceClosure(tx, [{ kind: 'task', taskId: selectedTask.id, throughSequence: 0 }])),
    [source],
  );
  await assert.rejects(
    tx(tx => requireNoMcpDerived(tx, [], { kind: 'agent', runId })),
    AccessDenied,
  );
  await db.platform.query(`UPDATE ${s}.tf_agent_task_steps SET mcp_sources='[]' WHERE run_id=$1`, [runId]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_agent_tool_calls (id,run_id,sequence,call,status,result) VALUES ($1,$2,0,'{"tool":"mcp.call"}','completed',$3)`,
    [randomUUID(), runId, JSON.stringify({ kind: 'receipt', provider: 'workspace-mcp', sources: [source] })],
  );
  assert.deepEqual(
    await tx(tx => mcpSourceClosure(tx, [{ kind: 'task', taskId: selectedTask.id, throughSequence: 0 }])),
    [source],
  );
  await assert.rejects(
    tx(tx => requireNoMcpDerived(tx, [], { kind: 'agent', runId })),
    AccessDenied,
  );
  assert.equal((await tasks.history(w.id, w.userId, linked.id)).messages[0].text, 'Derived task');
  assert.deepEqual(await tx(tx => mcpSourceClosure(tx, [reference])), [source]);
  await assert.rejects(
    tx(tx => requireNoMcpDerived(tx, [reference])),
    AccessDenied,
  );
  await tx(tx => requireDraftSources(tx, actor, [source]));
  await assert.rejects(
    tx(tx => requireDraftSources(tx, actor, [source], new Set(), undefined, true)),
    AccessDenied,
  );
  await assert.rejects(
    tx(tx => requireDraftSources(tx, actor, [source], new Set(), randomUUID())),
    AccessDenied,
  );
  await assert.rejects(
    tx(tx => requireTableSources(tx, actor, [source])),
    AccessDenied,
  );
  await assert.rejects(
    tx(tx => requireResultSources(tx, actor, randomUUID(), [source])),
    AccessDenied,
  );

  const skills = createWorkspaceSkills(runtime),
    skillId = randomUUID();
  const skillInput = {
    requestId: randomUUID(),
    expectedVersion: 0,
    definition: {
      name: 'Derived procedure',
      description: 'Handle derived records safely.',
      instructions: 'MCP content',
    },
  };
  await assert.rejects(skills.save(w.id, w.userId, skillId, skillInput, [source]), AccessDenied);
  const saved = await skills.save(w.id, w.userId, skillId, skillInput);
  await db.platform.query(
    `UPDATE ${s}.tf_workspace_skill_revisions SET definition=definition || $3::jsonb WHERE skill_id=$1 AND revision=$2`,
    [skillId, saved.savedRevision, JSON.stringify({ sources: [source] })],
  );
  const skillSource = { kind: 'workspace-skill', skillId, revision: saved.savedRevision };
  assert.deepEqual(await tx(tx => mcpSourceClosure(tx, [skillSource])), [source]);
  await assert.rejects(
    tx(tx => requireTableSources(tx, actor, [skillSource])),
    AccessDenied,
  );
  await assert.rejects(
    skills.save(w.id, w.userId, randomUUID(), { ...skillInput, requestId: randomUUID() }, [skillSource]),
    AccessDenied,
  );
  await db.platform.query(
    `UPDATE ${s}.tf_agent_definitions SET definition=jsonb_set(definition,'{skills}',$3::jsonb) WHERE agent_id=$1 AND revision=$2`,
    [agent.agentId, agent.revision, JSON.stringify([{ id: skillId, revision: saved.savedRevision }])],
  );
  const soul = (await db.platform.query(`SELECT saved_revision FROM ${s}.tf_agents WHERE id=$1`, [agent.agentId]))
    .rows[0].saved_revision;
  const definitionSource = { kind: 'agent-definition', agentId: agent.agentId, revision: soul };
  assert.deepEqual(await tx(tx => mcpSourceClosure(tx, [definitionSource])), [source]);
  await assert.rejects(
    tx(tx => requireTableSources(tx, actor, [definitionSource])),
    AccessDenied,
  );
  await assert.rejects(
    tx(tx => requireNoMcpDerived(tx, [definitionSource])),
    AccessDenied,
  );

  const chats = createConversations(runtime),
    chatId = randomUUID(),
    messageId = randomUUID(),
    turnId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversations (id,owner_user_id,owner_membership_id,title) VALUES ($1,$2,$3,'MCP-derived title')`,
    [chatId, w.userId, w.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages (id,conversation_id,sequence,author_kind) VALUES ($1,$2,1,'assistant')`,
    [messageId, chatId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_parts (conversation_id,message_id,ordinal,kind,text) VALUES ($1,$2,0,'text','MCP private result')`,
    [chatId, messageId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns (id,conversation_id,source_message_id,response_message_id,accepted_sequence,responder,status) VALUES ($1,$2,$3,$3,1,'reverse-text-v1','completed')`,
    [turnId, chatId, messageId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_results (conversation_id,turn_id,message_id,sources) VALUES ($1,$2,$3,$4)`,
    [chatId, turnId, messageId, JSON.stringify([source])],
  );
  assert.equal((await chats.read(w.id, w.userId, chatId)).title, 'MCP-derived title');
  assert.equal((await chats.history(w.id, w.userId, chatId)).messages[0].parts[0].text, 'MCP private result');
  await assert.rejects(
    tx(tx => withMcpSourceContext(tx, [source], () => recordConversationResultProvenance(tx, turnId))),
    AccessDenied,
  );

  let writes = 0;
  const files = createFiles(runtime, {
    putIfAbsent: async () => {
      writes++;
    },
    read: async () => new Uint8Array(),
  });
  const google = createGoogleOperations({
    runtime,
    integrations: {},
    fetcher: async () => {
      writes++;
      throw new Error('unexpected network');
    },
  });
  const atlassian = createAtlassianOperations({
    runtime,
    accounts: {},
    fetcher: async () => {
      writes++;
      throw new Error('unexpected network');
    },
  });
  await tx(tx =>
    withMcpSourceContext(tx, [reference], async () => {
      await assert.rejects(files.upload(w.id, w.userId, randomUUID(), {}, new Uint8Array([1])), AccessDenied);
      await assert.rejects(fetchPublicText('https://example.com/leak'), AccessDenied);
      await assert.rejects(google.read(w.id, w.userId, {}), AccessDenied);
      await assert.rejects(google.propose(w.id, w.userId, {}), AccessDenied);
      await assert.rejects(atlassian.read(w.id, actor, {}), AccessDenied);
      await assert.rejects(atlassian.propose(w.id, actor, {}), AccessDenied);
      const tableId = randomUUID(),
        recordId = randomUUID();
      await assert.rejects(
        createTableService(
          runtime,
          { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
          executionCompatibility,
        ).mutate(w.id, actor, { kind: 'create', tableId, revision: 'a'.repeat(40), recordId, values: {} }),
        AccessDenied,
      );
      await assert.rejects(
        createAgentAuthoring(runtime).save(w.id, actor, randomUUID(), {
          requestId: randomUUID(),
          owningTeamId: agent.teamId,
          expectedSoulRevision: soul,
          expectedSavedRevision: null,
          definition: { name: 'Derived agent', instructions: 'MCP result', tools: [] },
        }),
        AccessDenied,
      );
      await assert.rejects(
        withMcpSourceContext(tx, [], () => files.createFolder(w.id, w.userId, randomUUID(), {})),
        AccessDenied,
      );
    }),
  );
  assert.equal(writes, 0);
  await assert.rejects(
    tx(tx => requireNoMcpDerived(tx, [{ kind: 'private-task', taskId: first.id }])),
    AccessDenied,
  );
  await assert.rejects(
    tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Missing selection claimant',
      mcpSelection: { selectionId: randomUUID(), version: 1 },
    }),
    AccessDenied,
  );
  const oldDefinition = { name: 'Existing agent', instructions: 'Keep existing bytes.', tools: [] };
  assert.equal(JSON.stringify(agentDefinitionSchema.parse(oldDefinition)), JSON.stringify(oldDefinition));
  assert.deepEqual(
    startTaskSchema.parse({ requestId: randomUUID(), agentId: agent.agentId, text: 'Ordinary task' }).sources,
    [],
  );

  await db.platform.query(`UPDATE ${s}.tf_conversation_results SET sources='[]' WHERE turn_id=$1`, [turnId]);
  await db.platform.query(`INSERT INTO ${s}.tf_conversation_model_sources VALUES ($1,1,1,$2)`, [
    turnId,
    JSON.stringify([source]),
  ]);
  assert.deepEqual(await tx(tx => mcpSourceClosure(tx, [{ kind: 'private-conversation', conversationId: chatId }])), [
    source,
  ]);
  await assert.rejects(
    tx(tx => requireNoMcpDerived(tx, [{ kind: 'private-conversation', conversationId: chatId }])),
    AccessDenied,
  );
  await db.platform.query(`DELETE FROM ${s}.tf_conversation_model_sources WHERE turn_id=$1`, [turnId]);
  const callId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_tool_calls (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'mcp.call','completed')`,
    [callId, chatId, turnId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_execution_steps (call_id,turn_id,call,sources,output) VALUES ($1,$2,'{}','[]',$3)`,
    [callId, turnId, JSON.stringify({ result: 'retained', sources: [source] })],
  );
  assert.deepEqual(await tx(tx => mcpSourceClosure(tx, [{ kind: 'private-conversation', conversationId: chatId }])), [
    source,
  ]);
  await db.platform.query(`UPDATE ${s}.tf_mcp_integrations SET authorization_epoch=2 WHERE id=$1`, [
    source.integrationId,
  ]);
  await assert.rejects(tasks.history(w.id, w.userId, first.id), AccessDenied);
  await assert.rejects(tasks.history(w.id, w.userId, linked.id), AccessDenied);
  await assert.rejects(tasks.read(w.id, w.userId, linked.id), AccessDenied);
  assert.deepEqual((await tasks.list(w.id, w.userId)).tasks, []);
  await assert.rejects(chats.history(w.id, w.userId, chatId), AccessDenied);
  await assert.rejects(chats.read(w.id, w.userId, chatId), AccessDenied);
  assert.deepEqual((await chats.list(w.id, w.userId, { query: 'MCP-derived' })).chats, []);
  await assert.rejects(
    tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Retained reference',
      sources: [reference],
    }),
    AccessDenied,
  );
});
