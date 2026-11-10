import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activateRevision, needsActivationReview } from '../src/features/agents/revision-activation.ts';
import type { agentApi, AgentDetail } from '../src/features/agents/api.ts';

const id = '33333333-3333-4333-8333-333333333333';
const scope = [{ assetId: '55555555-5555-4555-8555-555555555555', permissions: ['table.row.read' as const] }];
const definition = { name: 'Handbook helper', instructions: 'Answer handbook questions.', tools: [] };
const input = {
  requestId: '44444444-4444-4444-8444-444444444444',
  savedRevision: 'a'.repeat(40),
  policyVersion: 4,
  activationIds: [],
  scope,
};

function fixture() {
  const detail: AgentDetail = {
    id,
    name: definition.name,
    definition,
    owningTeamId: null,
    savedRevision: input.savedRevision,
    definitionRevision: 'b'.repeat(64),
    capabilities: ['read', 'edit', 'manage'],
    activations: [],
  };
  const policy = {
    version: 4,
    owningTeamId: null,
    grants: [],
    personGrants: [],
    enrollment: [],
    enabled: true,
    limits: [...scope, { ...scope[0]!, permissions: ['table.row.update' as const] }],
    taskLimits: { toolCalls: 25, activeMilliseconds: 60000, credits: 20 },
    slackSender: 'user' as const,
  };
  const calls: unknown[] = [];
  const api: Pick<ReturnType<typeof agentApi>, 'detail' | 'policy' | 'replaceActivation'> = {
    detail: async () => detail,
    policy: async () => policy,
    replaceActivation: async (agentId, activation) => {
      calls.push({ agentId, activation });
      return { activationId: activation.requestId };
    },
  };
  return { api, detail, policy, calls };
}

test('instruction and name changes activate without an extra review, including implicit defaults', () => {
  assert.equal(
    needsActivationReview(definition, {
      ...definition,
      name: 'Updated helper',
      instructions: 'Use the latest handbook.',
      responseRule: 'tag',
      skills: [],
      mcp: [],
    }),
    false,
  );
  assert.equal(needsActivationReview(definition, { ...definition, tools: ['web.fetch'] }), true);
  assert.equal(
    needsActivationReview(definition, { ...definition, skills: [{ id: 'example', revision: 'latest' }] }),
    true,
  );
  assert.equal(needsActivationReview(definition, { ...definition, modelFamilyId: 'grok-fast' }), true);
  assert.equal(needsActivationReview(definition, { ...definition, responseRule: 'every-message' }), true);
  assert.equal(
    needsActivationReview(definition, {
      ...definition,
      mcp: [{ id: 'example', serverIdentity: 'a'.repeat(64), tools: [{ name: 'read', revision: 'b'.repeat(64) }] }],
    }),
    true,
  );
});

test('activation uses the exact accepted definition and preserves scope instead of widening to policy limits', async () => {
  const { api, calls, detail } = fixture();
  assert.deepEqual(await activateRevision(api, id, input), {
    name: detail.name,
    savedRevision: input.savedRevision,
    revision: detail.definitionRevision,
  });
  assert.deepEqual(calls, [
    {
      agentId: id,
      activation: {
        requestId: input.requestId,
        revision: detail.definitionRevision,
        scope,
        expectedSavedRevision: input.savedRevision,
        expectedPolicyVersion: input.policyVersion,
        expectedActivationIds: [],
      },
    },
  ]);
});

test('a concurrent save cannot activate a different definition', async () => {
  const { api, calls, detail } = fixture();
  detail.savedRevision = 'c'.repeat(40);
  await assert.rejects(activateRevision(api, id, input), { code: 'definition-changed' });
  assert.deepEqual(calls, []);
});

test('changed access, execution off and lost manager access stop activation', async () => {
  for (const reason of ['policy-version-conflict', 'execution-disabled', 'activation-not-allowed']) {
    const { api, calls, detail, policy } = fixture();
    if (reason === 'policy-version-conflict') policy.version++;
    if (reason === 'execution-disabled') policy.enabled = false;
    if (reason === 'activation-not-allowed') detail.capabilities = ['read', 'edit'];
    await assert.rejects(activateRevision(api, id, input), { code: reason });
    assert.deepEqual(calls, []);
  }
});

test('an uncertain retry keeps the same activation request and revision', async () => {
  const { api, calls } = fixture();
  const activate = api.replaceActivation;
  let first = true;
  api.replaceActivation = async (...args) => {
    const receipt = await activate(...args);
    if (first) {
      first = false;
      throw new TypeError('Connection closed after commit');
    }
    return receipt;
  };
  await assert.rejects(activateRevision(api, id, input));
  await activateRevision(api, id, input);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});
