import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { knowledgeActivity, knowledgeActivitySchema } from '../src/knowledge-activity.ts';
import { knowledgeActivityForHistory } from '../src/knowledge-activity-history.ts';

const call = { tool: 'knowledge.retrieve', action: 'search', query: 'PRIVATE QUERY' };
const document = {
  title: 'PRIVATE TITLE',
  completeness: 'complete',
  omitted: false,
  passages: [{ text: 'PRIVATE BODY', truncated: false }],
};
const branch = { index: 0, status: 'evidence', reason: null, documents: [document] };
const output = branches => ({ result: { provider: 'knowledge', action: 'search', branches }, sources: [] });

test('knowledge receipts separate loading, evidence, gaps, failures and spent budgets', () => {
  assert.equal(knowledgeActivity(call.tool, call, null, 'running').status, 'running');
  const good = knowledgeActivity(call.tool, call, output([branch]), 'completed');
  knowledgeActivitySchema.parse(good);
  assert.equal(good.status, 'success');
  assert.equal(good.branches[0].documents[0].passages, 1);
  assert.doesNotMatch(JSON.stringify(good), /PRIVATE BODY|PRIVATE QUERY/);
  assert.equal(
    knowledgeActivity(
      call.tool,
      call,
      output([{ ...branch, documents: [{ ...document, omitted: true }] }]),
      'completed',
    ).status,
    'partial',
  );
  assert.equal(
    knowledgeActivity(
      call.tool,
      call,
      output([branch, { ...branch, index: 1, status: 'failed', documents: [] }]),
      'completed',
    ).status,
    'partial',
  );
  for (const [status, expected] of [
    ['no-match', 'empty'],
    ['failed', 'failed'],
    ['unavailable', 'unavailable'],
  ]) {
    assert.equal(
      knowledgeActivity(call.tool, call, output([{ ...branch, status, documents: [] }]), 'completed').status,
      expected,
    );
  }
  for (const [error, expected] of [
    ['knowledge-budget-exhausted', 'exhausted'],
    ['knowledge-round-pending', 'waiting'],
    ['knowledge-operation-conflict', 'failed'],
  ]) {
    assert.equal(
      knowledgeActivity(call.tool, call, { result: { provider: 'knowledge', error } }, 'completed').status,
      expected,
    );
  }
  assert.equal(knowledgeActivity(call.tool, call, { result: {} }, 'completed').status, 'failed');
  assert.equal(knowledgeActivity('knowledge.read', {}, null, 'running'), null);
});

test('history rechecks both source lists and hides every title after revocation', async () => {
  const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  const source = {
    kind: 'knowledge-document',
    workspaceId: randomUUID(),
    documentId: randomUUID(),
    sourceId: randomUUID(),
    revisionId: randomUUID(),
    publicationId: randomUUID(),
    accessEpoch: 1,
  };
  let denied = false;
  let checked = 0;
  const tx = {
    schema: 'test',
    requireKnowledgeSource: async (human, dependency) => {
      checked++;
      assert.deepEqual(human, actor);
      assert.deepEqual(dependency, source);
      if (denied) throw new AccessDenied();
    },
  };
  for (const location of ['retained', 'output']) {
    const row = {
      tool: call.tool,
      call,
      status: 'completed',
      sources: location === 'retained' ? [source] : [],
      output: { ...output([branch]), sources: location === 'output' ? [source] : [] },
    };
    denied = false;
    assert.equal((await knowledgeActivityForHistory(tx, actor, row)).status, 'success');
    denied = true;
    const hidden = await knowledgeActivityForHistory(tx, actor, row);
    assert.deepEqual(hidden, { action: null, status: 'unavailable', branches: [] });
    assert.doesNotMatch(JSON.stringify(hidden), /PRIVATE/);
    const unavailable = {
      ...tx,
      requireKnowledgeSource: async () => {
        throw new SourceAuthorizationUnavailable();
      },
    };
    assert.equal((await knowledgeActivityForHistory(unavailable, actor, row)).status, 'failed');
  }
  assert.equal(checked, 4);
  const unexpected = new Error('unexpected');
  await assert.rejects(
    knowledgeActivityForHistory(
      {
        ...tx,
        requireKnowledgeSource: async () => {
          throw unexpected;
        },
      },
      actor,
      {
        tool: call.tool,
        call,
        output: output([branch]),
        sources: [source],
        status: 'completed',
      },
    ),
    error => error === unexpected,
  );
});
