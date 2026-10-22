import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createAuthoringDrafts } from '@tulipfarm/agents/drafts';
import { parseToolCall, discoverTools } from '@tulipfarm/agents/tools';
import { requireDraftSources } from '../../../packages/agents/src/draft-sources.ts';
import { requireTableSources } from '@tulipfarm/agents/table-sources';
import { requireResultSources } from '@tulipfarm/conversations/source-access';
import { recordConversationResultProvenance } from '@tulipfarm/conversations/provenance';
import { githubChatFixture } from './github-read-fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const call = {
  tool: 'github.personal.read',
  operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
};
test('ordinary worker requires human selection, persists provenance, isolates switched context and stops revoked reads', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const first = await f.connect(123),
    second = await f.connect(456),
    chatId = await f.chat();
  f.decide([call], 'No account yet.');
  const missing = await f.send(chatId);
  assert.equal(missing.status, 'completed');
  assert.equal(f.providerCalls.length, 0);
  assert.deepEqual(await f.reads.selection(f.one.id, f.member.userId, chatId), {
    accountId: null,
    generation: null,
    version: 0,
  });
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId: first, expectedVersion: 0 });
  f.decide([call]);
  const kept = f.modelRequests.length;
  const read = await f.send(chatId);
  assert.equal(read.status, 'completed');
  assert.equal(JSON.stringify(f.modelRequests[kept]).includes('No account yet.'), true);
  assert.ok(f.providerCalls.length > 1);
  const sources = (
    await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
      read.turnId,
    ])
  ).rows[0].sources;
  const source = sources.find(source => source.kind === 'github-personal');
  assert.deepEqual(source, {
    kind: 'github-personal',
    accountId: first,
    generation: 1,
    membershipId: f.member.membershipId,
    conversationId: chatId,
    selectionVersion: 1,
    proof: source.proof,
  });
  assert.deepEqual(source.proof.operation, call.operation);
  assert.equal(source.proof.transport, 'rest');
  assert.match(
    JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)),
    /selected GitHub account returned/,
  );
  const actor = { kind: 'human', ...f.member };
  const check = action => f.runtime.transaction(f.one.id, commonCompatibility, action);
  await check(tx => requireDraftSources(tx, actor, [source]));
  await assert.rejects(
    check(tx => requireTableSources(tx, actor, [source])),
    AccessDenied,
  );
  await assert.rejects(check(tx => requireDraftSources(tx, actor, [source], new Set(), randomUUID())));
  await assert.rejects(check(tx => requireDraftSources(tx, actor, [source], new Set(), undefined, true)));
  await assert.rejects(check(tx => requireResultSources(tx, actor, chatId, sources)));
  await assert.rejects(check(tx => recordConversationResultProvenance(tx, read.turnId)));
  await assert.rejects(f.reads.select(f.one.id, f.one.userId, chatId, { accountId: first, expectedVersion: 1 }));
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId: second, expectedVersion: 1 });
  const hidden = await f.store.history(f.one.id, f.member.userId, chatId);
  assert.match(JSON.stringify(hidden), /reply is unavailable/);
  f.decide([call], 'Second account result.');
  const before = f.modelRequests.length;
  const switched = await f.send(chatId, 'Read with second account.');
  assert.equal(switched.status, 'completed');
  assert.equal(JSON.stringify(f.modelRequests[before]).includes('selected GitHub account returned'), false);
  assert.equal(JSON.stringify(f.modelRequests[before]).includes('No account yet.'), false);
  const nextSources = (
    await f.db.platform.query(`SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`, [
      switched.turnId,
    ])
  ).rows[0].sources;
  assert.equal(nextSources.find(source => source.kind === 'github-personal').accountId, second);
  await f.service.disconnect(f.one.id, f.member.userId, second);
  assert.match(JSON.stringify(await f.store.history(f.one.id, f.member.userId, chatId)), /reply is unavailable/);
  const count = f.providerCalls.length,
    models = f.modelRequests.length;
  f.decide([call]);
  await f.send(chatId);
  assert.equal(f.providerCalls.length, count);
  assert.equal(f.modelRequests.length, models);
  assert.equal(JSON.stringify(f.modelRequests).includes('synthetic-access-token'), false);
  assert.throws(() => parseToolCall({ ...call, accountId: first }, { kind: 'chat' }));
  assert.throws(() => parseToolCall(call, { kind: 'agent', tools: ['github.personal.read'] }));
  assert.equal(discoverTools({ kind: 'agent', tools: ['github.personal.read'] }).length, 0);
});
test('derived drafts lose visibility and save authority on disconnect; provider 401 invalidates credentials', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const accountId = await f.connect(),
    chatId = await f.chat();
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId, expectedVersion: 0 });
  const skillId = randomUUID();
  f.decide([
    call,
    {
      tool: 'skills.draft',
      skillId,
      input: {
        expectedVersion: 0,
        definition: {
          name: 'Private skill',
          description: 'Use authorized private account content.',
          instructions: 'Private account content',
        },
      },
    },
  ]);
  const result = await f.send(chatId);
  assert.equal(result.status, 'completed');
  const row = (
    await f.db.platform.query(`SELECT id FROM ${f.table('tf_chat_authoring_drafts')} WHERE conversation_id=$1`, [
      chatId,
    ])
  ).rows[0];
  const drafts = createAuthoringDrafts(f.runtime);
  const draft = await drafts.read(f.one.id, f.member.userId, chatId, row.id);
  assert.equal(draft.proposal.input.definition.instructions, 'Private account content');
  await f.service.disconnect(f.one.id, f.member.userId, accountId);
  await assert.rejects(drafts.read(f.one.id, f.member.userId, chatId, row.id));
  await assert.rejects(
    drafts.decide(f.one.id, f.member.userId, chatId, row.id, {
      commandId: randomUUID(),
      digest: draft.digest,
      decision: 'save',
    }),
  );
  const rejected = await f.connect(456),
    otherChat = await f.chat();
  await f.reads.select(f.one.id, f.member.userId, otherChat, { accountId: rejected, expectedVersion: 0 });
  f.setProvider(async () => Response.json({ message: 'Bad credentials' }, { status: 401 }));
  f.decide([call]);
  await f.send(otherChat);
  assert.equal((await f.service.status(f.one.id, f.member.userId, rejected)).state, 'reconnect-required');
  const count = f.providerCalls.length;
  f.decide([call]);
  await f.send(otherChat);
  assert.equal(f.providerCalls.length, count);
});

test('one active account is used without asking; several accounts make the model show the picker', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const accountId = await f.connect(123),
    chatId = await f.chat();
  f.decide([call]);
  assert.equal((await f.send(chatId)).status, 'completed');
  assert.ok(f.providerCalls.length > 0);
  assert.deepEqual(await f.reads.selection(f.one.id, f.member.userId, chatId), {
    accountId,
    generation: 1,
    version: 1,
  });
  f.decide([{ tool: 'github.personal.account' }]);
  assert.equal((await f.send(chatId)).status, 'completed');
  assert.match(
    JSON.stringify(f.modelRequests.at(-1)),
    /already selected for this chat/,
    'The picker tool reports the selected account instead of asking again',
  );
  await f.connect(456);
  const otherChat = await f.chat(),
    calls = f.providerCalls.length;
  f.decide([call, { tool: 'github.personal.account' }], 'Pick an account.');
  const asked = await f.send(otherChat);
  assert.equal(asked.status, 'completed');
  assert.equal(f.providerCalls.length, calls);
  assert.deepEqual(await f.reads.selection(f.one.id, f.member.userId, otherChat), {
    accountId: null,
    generation: null,
    version: 0,
  });
  const tools = (
    await f.db.platform.query(`SELECT tool,status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1`, [
      asked.turnId,
    ])
  ).rows;
  assert.deepEqual(tools.map(row => `${row.tool}:${row.status}`).sort(), [
    'github.personal.account:completed',
    'github.personal.read:completed',
  ]);
  assert.match(JSON.stringify(f.modelRequests.at(-1)), /github\.personal\.account/);
});
