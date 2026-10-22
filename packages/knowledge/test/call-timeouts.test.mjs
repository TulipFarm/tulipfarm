import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { defaultCallTimeoutMs } from '@tulipfarm/config/timeouts';
import { createKnowledgeAgentTools, createKnowledgeSearch } from '../dist/index.js';

test('search and knowledge tools share one-minute deadlines and preserve shorter caller limits', async t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const entered = new Error('transaction reached');
  const deadlines = [];
  const runtime = {
    transaction: async (_workspace, range) => {
      deadlines.push(range.deadlineAt);
      throw entered;
    },
  };
  const search = createKnowledgeSearch({ runtime, embeddings: {} });
  const tools = createKnowledgeAgentTools({ runtime, search });
  const workspace = randomUUID();
  const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  const commandId = randomUUID();
  const citationId = `${randomUUID()}:0`;
  const submitted = { kind: 'submitted', commandId, query: 'supplier' };
  for (const deadlineAt of [undefined, now + 500, now + 120_000]) {
    const expected = Math.min(deadlineAt ?? Infinity, now + defaultCallTimeoutMs);
    await assert.rejects(search.search(workspace, actor.userId, submitted, deadlineAt), error => error === entered);
    await assert.rejects(
      tools.search(workspace, actor, { query: 'supplier' }, { commandId, deadlineAt }),
      error => error === entered,
    );
    await assert.rejects(tools.read(workspace, actor, citationId, { deadlineAt }), error => error === entered);
    await assert.rejects(
      tools.retrieve(workspace, actor, { action: 'search', query: 'supplier' }, { commandId, deadlineAt }),
      error => error === entered,
    );
    assert.deepEqual(deadlines.splice(0), [expected, expected, expected, expected]);
  }
  const controller = new AbortController();
  const cancelled = new Error('caller cancelled');
  controller.abort(cancelled);
  await assert.rejects(
    search.search(workspace, actor.userId, submitted, undefined, controller.signal),
    error => error === cancelled,
  );
  await assert.rejects(
    tools.search(workspace, actor, { query: 'supplier' }, { commandId, signal: controller.signal }),
    error => error === cancelled,
  );
  await assert.rejects(
    tools.read(workspace, actor, citationId, { signal: controller.signal }),
    error => error === cancelled,
  );
  await assert.rejects(
    tools.retrieve(
      workspace,
      actor,
      { action: 'expand', branches: [{ citationIds: [citationId], reason: 'Read more.' }] },
      { commandId, signal: controller.signal },
    ),
    error => error === cancelled,
  );
  assert.deepEqual(deadlines, []);
});
