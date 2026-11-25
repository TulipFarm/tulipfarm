import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeAgentTools } from '../dist/internal/agent-tools.js';

const workspaceId = '11111111-1111-4111-a111-111111111111';
const sourceId = '22222222-2222-4222-a222-222222222222';

test('agent search and nested retrieval share injected clock and bounded deadlines', async () => {
  const failure = new Error('stop before the database');
  const deadlines = [];
  const clock = {
    value: 1_000,
    now() {
      return this.value;
    },
    sleep: async () => {},
  };
  const tools = createKnowledgeAgentTools({
    runtime: {
      transaction: async (_workspace, compatibility) => {
        deadlines.push(compatibility.deadlineAt);
        throw failure;
      },
    },
    search: { search: async () => assert.fail('must admit before searching') },
    clock,
    callTimeoutMs: 250,
  });
  const actor = { kind: 'human', userId: 'test-user', membershipId: sourceId };
  const context = { commandId: 'test-command' };
  await assert.rejects(tools.search(workspaceId, actor, { query: 'hello' }, context), error => error === failure);
  clock.value = 2_000;
  await assert.rejects(
    tools.retrieve(workspaceId, actor, { action: 'search', query: 'hello' }, context),
    error => error === failure,
  );
  await assert.rejects(
    tools.retrieve(workspaceId, actor, { action: 'search', query: 'hello' }, { ...context, deadlineAt: 2_100 }),
    error => error === failure,
  );
  await assert.rejects(
    tools.retrieve(workspaceId, actor, { action: 'search', query: 'hello' }, { ...context, deadlineAt: 5_000 }),
    error => error === failure,
  );
  assert.deepEqual(deadlines, [1_250, 2_250, 2_100, 2_250]);
});
