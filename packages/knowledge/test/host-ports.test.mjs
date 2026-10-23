import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateKnowledgeEmbeddingCost, defaultCallTimeoutMs, knowledgeEmbeddingProfile } from '@tulipfarm/config';
import { recordUsage } from '@tulipfarm/extensions';
import { recordKnowledgeImport } from '@tulipfarm/observability';
import {
  markKnowledgeDispatched,
  recordKnowledgeCreditOutcome,
  reserveKnowledgeCredits,
} from '@tulipfarm/workspace-storage/knowledge-credits';
import { knowledgeHostPolicy, knowledgeTelemetry, knowledgeUsageMeter, systemClock } from '../dist/host-ports.js';
import { createDefaultKnowledgeGate } from '../dist/internal/defaults.js';
import { createKnowledgeAgentTools } from '../dist/internal/agent-tools.js';

const workspaceId = '11111111-1111-4111-a111-111111111111';
const sourceId = '22222222-2222-4222-a222-222222222222';

test('host ports retain the complete fixed profile, pricing, telemetry and transactional credit functions', () => {
  assert.equal(knowledgeHostPolicy.embeddingProfile, knowledgeEmbeddingProfile);
  assert.equal(knowledgeHostPolicy.embeddingProfile.model, 'text-embedding-3-large');
  assert.equal(knowledgeHostPolicy.embeddingProfile.dimensions, 1536);
  assert.equal(knowledgeHostPolicy.callTimeoutMs, defaultCallTimeoutMs);
  assert.equal(knowledgeTelemetry.recordImport, recordKnowledgeImport);
  assert.equal(knowledgeUsageMeter.cost, calculateKnowledgeEmbeddingCost);
  assert.equal(knowledgeUsageMeter.reserve, reserveKnowledgeCredits);
  assert.equal(knowledgeUsageMeter.markDispatched, markKnowledgeDispatched);
  assert.equal(knowledgeUsageMeter.outcome, recordKnowledgeCreditOutcome);
  assert.equal(knowledgeUsageMeter.record, recordUsage);
  assert.deepEqual(
    knowledgeUsageMeter.cost({ inputTokens: 2, date: '2026-10-20' }),
    calculateKnowledgeEmbeddingCost({ inputTokens: 2, date: '2026-10-20' }),
  );
  assert.throws(() => knowledgeUsageMeter.cost({ inputTokens: -1, date: '2026-10-20' }));
});

test('system clock uses wall time and asynchronous sleep', async () => {
  const before = Date.now();
  const now = systemClock.now();
  assert.ok(now >= before && now <= Date.now());
  const sleeping = systemClock.sleep(0);
  assert.ok(sleeping instanceof Promise);
  await sleeping;
});

function gateFixture(featureFlags, enabled) {
  let queries = 0;
  const runtime = {
    transaction: async (workspace, _compatibility, operation) => {
      assert.equal(workspace, workspaceId);
      return operation({
        schema: 'ws_test',
        commonVersion: 1,
        client: {
          query: async (_sql, values) => {
            queries++;
            if (queries === 1) return { rows: [{ user_id: 'test-user' }] };
            assert.deepEqual(values, [['test-user'], ['github']]);
            return { rows: [{ source_id: sourceId }] };
          },
        },
      });
    },
  };
  return createDefaultKnowledgeGate({ runtime, featureFlags, enabled });
}

test('default-source gate passes exact flag, principal and tenant to the injected port', async () => {
  const calls = [];
  const gate = gateFixture({
    enabled: async (...args) => {
      calls.push(args);
      return false;
    },
  });
  assert.deepEqual(await gate(workspaceId), [sourceId]);
  assert.deepEqual(calls, [['default-connection-knowledge', 'test-user', workspaceId]]);
});

test('legacy enabled override takes precedence over the new flag port', async () => {
  const gate = gateFixture(
    { enabled: async () => assert.fail('legacy override must win') },
    async (workspace, user) => {
      assert.equal(workspace, workspaceId);
      assert.equal(user, 'test-user');
      return true;
    },
  );
  assert.deepEqual(await gate(workspaceId), []);
});

test('flag-port errors propagate without defaulting to permission or success', async () => {
  const failure = new Error('flag adapter unavailable');
  const gate = gateFixture({
    enabled: async () => {
      throw failure;
    },
  });
  await assert.rejects(gate(workspaceId), error => error === failure);
});

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
