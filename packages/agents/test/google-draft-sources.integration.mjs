import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createGoogleApproval } from '@tulipfarm/google-workspace/operation-approval';
import { googleFixture } from '../../google-workspace/test/fixture.mjs';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { respondToConversation } from '../../../apps/worker/src/conversation-responder.ts';
import { anthropicChat } from '../../../apps/worker/test/native-chat-fixture.mjs';
import { createChatTools } from '../src/tools.ts';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { syntheticContinuity } from './continuity-fixture.mjs';

for (const variant of ['read', 'propose', 'status', 'execute'])
  test(`Google ${variant} retains the exact integration for derived drafts`, async t => {
    const f = await googleFixture();
    t.after(() => f.close());
    const connected = await f.connect();
    const factory = runtime =>
      createGoogleOperations({
        runtime,
        integrations: f.service,
        fetcher: async () => Response.json({ documentId: 'document-1', title: 'Private source title' }),
      });
    const service = factory(f.runtime),
      operation = { kind: 'docs.documents.create', title: 'Private source title' };
    const proposal =
      variant === 'status' || variant === 'execute'
        ? await service.propose(f.workspace.id, f.member.userId, { commandId: randomUUID(), operation })
        : null;
    if (variant === 'execute')
      await createGoogleApproval({
        runtime: f.runtime,
        resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
      })(f.workspace.id, f.member.userId, proposal.id, { digest: proposal.digest, decision: 'approve' });
    const call =
      variant === 'read'
        ? { tool: 'google.read', operation: { kind: 'docs.documents.get', documentId: 'document-1' } }
        : variant === 'propose'
          ? { tool: 'google.propose', operation }
          : { tool: `google.${variant}`, proposalId: proposal.id };
    const calls = [
      call,
      {
        tool: 'skills.draft',
        skillId: randomUUID(),
        input: {
          expectedVersion: 0,
          definition: { name: 'Google-derived procedure', instructions: 'Private source title' },
        },
      },
    ];
    let step = 0;
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json(
        anthropicChat(
          step < calls.length ? { kind: 'tool', call: calls[step++] } : { kind: 'answer', text: 'Review the draft' },
        ),
      ),
    );
    const chats = createConversations(f.runtime),
      chatId = randomUUID();
    await chats.create(f.workspace.id, f.member.userId, { chatId, commandId: randomUUID() });
    const sent = await chats.send(f.workspace.id, f.member.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Read then draft' }],
    });
    const executor = createConversationExecutor(f.runtime, ({ messages, executeTool }) =>
      respondToConversation(
        { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
        messages,
        (call, sources) =>
          executeTool(call.tool, call.tool.startsWith('google.'), context =>
            createChatTools(context.runtime, { google: factory }).invokeWithSources(
              { ...context, origin: { ...context.origin, sources: [...context.origin.sources, ...sources] } },
              call,
            ),
          ),
      ),
    );
    assert.equal(
      await executor.process({
        workspaceId: f.workspace.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      }),
      'completed',
    );
    const row = (
      await f.db.platform.query(
        `SELECT id,digest,sources FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`,
        [chatId],
      )
    ).rows[0];
    assert.ok(row);
    const source = row.sources.find(source => source.kind === 'google-integration');
    assert.equal(source.integrationId, connected.integrationId);
    assert.equal(source.generation, connected.generation);
    assert.equal(source.membershipId, f.member.membershipId);
    assert.deepEqual(source.requiredScopes, ['https://www.googleapis.com/auth/documents']);
    const drafts = createAuthoringDrafts(f.runtime);
    assert.equal(
      (await drafts.read(f.workspace.id, f.member.userId, chatId, row.id)).proposal.input.definition.instructions,
      'Private source title',
    );
    const saved = await drafts.decide(f.workspace.id, f.member.userId, chatId, row.id, {
      commandId: randomUUID(),
      digest: row.digest,
      decision: 'save',
    });
    await createWorkspaceSkills(f.runtime).review(f.workspace.id, f.member.userId, saved.receipt.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      revision: saved.receipt.savedRevision,
    });
    const agent = await savedTaskAgent(
      f.db,
      f.workspace,
      f.runtime,
      f.member.userId,
      f.member.membershipId,
      [{ id: saved.receipt.id, revision: saved.receipt.savedRevision }],
      [],
    );
    await createAgentExecutor({ runtime: f.runtime }).configure(f.workspace.id, f.admin, {
      agentId: agent.agentId,
      version: 0,
      enabled: true,
      teamIds: [agent.teamId],
      limits: [],
    });
    const tasks = createAgentTasks(f.runtime),
      task = await tasks.start(f.workspace.id, f.member.userId, {
        requestId: randomUUID(),
        agentId: agent.agentId,
        text: 'Do not impersonate my connected account.',
      });
    let dispatches = 0;
    await createTaskRuntime(
      f.runtime,
      syntheticContinuity(() => {
        dispatches++;
        return { kind: 'answer', text: 'Must not infer from personal source' };
      }),
    ).process(f.workspace.id, task.id);
    assert.equal((await tasks.read(f.workspace.id, f.member.userId, task.id)).status, 'failed');
    assert.equal(dispatches, 0);
    assert.equal(
      (await tasks.history(f.workspace.id, f.member.userId, task.id)).messages[0].text,
      'Do not impersonate my connected account.',
    );
    await f.service.disconnect(f.workspace.id, f.member.userId);
    await assert.rejects(drafts.read(f.workspace.id, f.member.userId, chatId, row.id));
    await assert.rejects(tasks.history(f.workspace.id, f.member.userId, task.id));
    await assert.rejects(
      drafts.decide(f.workspace.id, f.member.userId, chatId, row.id, {
        commandId: randomUUID(),
        digest: row.digest,
        decision: 'save',
      }),
    );
    f.behavior({ account: 'different-google-account' });
    const replacement = await f.connect();
    assert.notEqual(replacement.accountId, source.accountId);
    await assert.rejects(drafts.read(f.workspace.id, f.member.userId, chatId, row.id));
    await assert.rejects(tasks.history(f.workspace.id, f.member.userId, task.id));
    assert.deepEqual(
      (await f.db.platform.query(`SELECT sources FROM ${f.table('tf_chat_authoring_drafts')} WHERE id=$1`, [row.id]))
        .rows[0].sources,
      row.sources,
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_workspace_skill_revisions')}`))
        .rows[0].count,
      1,
    );
  });
