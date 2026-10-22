import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { serializeAgentDocument } from '@tulipfarm/workspaces/agent-document';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentAuthoring } from '../src/authoring.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools, parseToolCall } from '../src/tools.ts';

const nil = '00000000-0000-0000-0000-000000000000';

test('new agent drafts get fresh identities and update drafts name the agent they change', async t => {
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
    team = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'QA operations')`, [team]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    member,
    team,
  ]);
  await db.platform.query(`INSERT INTO ${table('tf_agent_creation_grants')} (team_id,owning_team_id) VALUES ($1,$1)`, [
    team,
  ]);
  await db.platform.query(`UPDATE ${table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
  const head = async () =>
    (await db.platform.query(`SELECT revision FROM ${table('tf_soul_head')} WHERE id=1`)).rows[0].revision;
  const chats = createConversations(runtime),
    drafts = createAuthoringDrafts(runtime);
  const writer = createAgentAuthoring(runtime).withWriter(async input => {
    const commit = createHash('sha1').update(input.commandId).digest('hex');
    const { formatVersion, id, ...definition } = input.definition;
    return {
      parentCommit: input.expectedParentCommit,
      commit,
      bundle: { key: `bundle-${commit}`, sha256: 'b'.repeat(64) },
      projection: {
        workspaceId: w.id,
        commit,
        kind: 'agent',
        id,
        path: `agents/${id}.json`,
        bucket: 'synthetic',
        key: `projection-${commit}`,
        sha256: createHash('sha256')
          .update(serializeAgentDocument({ formatVersion, id, ...definition }))
          .digest('hex'),
      },
    };
  });

  async function draft(call) {
    const chatId = randomUUID();
    await chats.create(w.id, user, { chatId, commandId: randomUUID() });
    const sent = await chats.send(w.id, user, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Draft a separate new agent. Do not change any existing agent.' }],
    });
    let result;
    await createConversationExecutor(runtime, async ({ executeTool }) => {
      result = await executeTool(call.tool, false, context =>
        createChatTools(context.runtime).invoke(context, parseToolCall(call, { kind: 'chat' })),
      );
      return { text: 'Review the draft card.', sources: [] };
    }).process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return { chatId, result, view: await drafts.read(w.id, user, chatId, result.draftId) };
  }
  async function save({ chatId, result }) {
    const outcome = await drafts.decide(w.id, user, chatId, result.draftId, {
      commandId: randomUUID(),
      digest: result.digest,
      decision: 'save',
    });
    assert.equal((await writer.prepare(w.id, outcome.receipt.commandId)).status, 'accepted');
  }
  const created = name => ({
    tool: 'agents.draft',
    agent: 'new',
    input: { owningTeamId: team, definition: { name, instructions: `${name} instructions.`, tools: [] } },
  });
  const agents = async () =>
    (
      await db.platform.query(
        `SELECT a.id, d.definition->>'name' AS name FROM ${table('tf_agents')} a JOIN ${table('tf_agent_saved_revisions')} s ON s.agent_id=a.id AND s.soul_revision=a.saved_revision JOIN ${table('tf_agent_definitions')} d ON d.agent_id=s.agent_id AND d.revision=s.definition_revision ORDER BY d.definition->>'name'`,
      )
    ).rows;

  for (const [call, rejected] of [
    [
      {
        tool: 'agents.draft',
        agentId: nil,
        input: {
          expectedSoulRevision: await head(),
          expectedSavedRevision: null,
          owningTeamId: team,
          definition: { name: 'Zero helper', instructions: 'Inspect.', tools: [] },
        },
      },
      'agentId',
    ],
    [
      {
        tool: 'agents.draft',
        agent: { id: nil },
        input: {
          expectedSoulRevision: await head(),
          owningTeamId: team,
          definition: { name: 'Zero helper', instructions: 'Inspect.', tools: [] },
        },
      },
      'agent',
    ],
    [
      {
        tool: 'agents.draft',
        agent: 'new',
        agentId: nil,
        input: {
          expectedSoulRevision: await head(),
          owningTeamId: team,
          definition: { name: 'Zero helper', instructions: 'Inspect.', tools: [] },
        },
      },
      'agentId',
    ],
    [
      {
        tool: 'agents.draft',
        agent: 'new',
        input: {
          expectedSoulRevision: await head(),
          expectedSavedRevision: 'a'.repeat(40),
          owningTeamId: team,
          definition: { name: 'Zero helper', instructions: 'Inspect.', tools: [] },
        },
      },
      'expectedSavedRevision',
    ],
  ])
    assert.throws(
      () => parseToolCall(call, { kind: 'chat' }),
      error => error.issues.some(issue => issue.keys?.includes(rejected) || issue.path.at(-1) === rejected),
      `a new-agent request cannot carry ${rejected}`,
    );

  const first = await draft({
    ...created('qa-chat-created-helper'),
    input: { ...created('qa-chat-created-helper').input, expectedSoulRevision: await head() },
  });
  assert.equal(first.result.change, 'create');
  assert.notEqual(first.result.agentId, nil);
  assert.deepEqual(first.view.agentChange, { kind: 'create' });
  await save(first);
  const [original] = await agents();
  assert.deepEqual(original, { id: first.result.agentId, name: 'qa-chat-created-helper' });

  const second = await draft({
    ...created('qa-second-chat-helper'),
    input: { ...created('qa-second-chat-helper').input, expectedSoulRevision: await head() },
  });
  assert.equal(second.result.change, 'create');
  assert.notEqual(second.result.agentId, original.id);
  assert.deepEqual(second.view.agentChange, { kind: 'create' });
  await save(second);
  assert.deepEqual(await agents(), [original, { id: second.result.agentId, name: 'qa-second-chat-helper' }]);

  const savedRevision = (
    await db.platform.query(`SELECT saved_revision FROM ${table('tf_agents')} WHERE id=$1`, [original.id])
  ).rows[0].saved_revision;
  const update = await draft({
    tool: 'agents.draft',
    agent: { id: original.id, savedRevision },
    input: {
      expectedSoulRevision: await head(),
      owningTeamId: team,
      definition: {
        name: 'qa-chat-created-helper',
        instructions: 'Changed instructions.',
        tools: ['rows.list'],
        responseRule: 'tag',
      },
    },
  });
  assert.equal(update.result.change, 'update');
  assert.equal(update.result.agentId, original.id);
  assert.match(update.result.instruction, new RegExp(`updates the existing agent ${original.id}`));
  assert.deepEqual(update.view.agentChange, {
    kind: 'update',
    agentId: original.id,
    current: { name: 'qa-chat-created-helper', changedFields: ['instructions', 'tools'] },
  });
  assert.deepEqual(update.view.proposal.input.expectedSavedRevision, savedRevision);
});
