import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberPlans } from '../src/member-plans.ts';

test('own tells whether the plan tried last belongs to the caller', async () => {
  const candidate = owner => ({ connectionId: `c-${owner}`, ownerMembershipId: owner, models: [], disabled: [] });
  const plans = await memberPlans({
    provider: 'claude',
    credentials: {
      accessToken: async (_, connectionId) => `token-${connectionId.slice(2)}`,
      requireReconnect: async () => undefined,
    },
    subscriptions: {
      eligible: async () => [candidate('me'), candidate('teammate')],
      markUsed: async () => undefined,
      coolDown: async () => undefined,
    },
    workspaceId: 'w',
    caller: 'me',
    model: 'claude-sonnet-5',
  });
  assert.equal(plans.token, 'token-me');
  assert.equal(plans.own(), true);
  assert.deepEqual(await plans.next('usage-limit'), {
    token: 'token-teammate',
    endpoint: null,
    model: 'claude-sonnet-5',
  });
  assert.equal(plans.own(), false);
});

test('BYOK custom endpoints preserve exact model casing, scope by connectionPrefix, and pass generation on reconnect', async () => {
  const reconnects = [];
  const candidateA = {
    connectionId: 'aaaaaaaa-1111-4222-8333-444444444444',
    ownerMembershipId: 'me',
    models: ['Meta-Llama-3-70B'],
    modelDetails: [{ slug: 'Meta-Llama-3-70B', maxInputTokens: 64000, maxOutputTokens: 4096, imageInput: false }],
    disabled: [],
  };
  const candidateB = {
    connectionId: 'bbbbbbbb-1111-4222-8333-444444444444',
    ownerMembershipId: 'me',
    models: ['Meta-Llama-3-70B'],
    modelDetails: [{ slug: 'Meta-Llama-3-70B', maxInputTokens: 128000, maxOutputTokens: 8192, imageInput: true }],
    disabled: [],
  };
  const plans = await memberPlans({
    provider: 'byok-openai-compatible',
    credentials: {
      accessToken: async () => {
        throw new Error('unused');
      },
      accessCredential: async (_, connectionId) => ({
        token: `key-${connectionId.slice(0, 8)}`,
        endpoint: `https://${connectionId.slice(0, 8)}.example.com/v1/`,
        generation: 7,
      }),
      requireReconnect: async (_, connectionId, generation) => reconnects.push([connectionId, generation]),
    },
    subscriptions: {
      eligible: async () => [candidateA, candidateB],
      markUsed: async () => undefined,
      coolDown: async () => undefined,
    },
    workspaceId: 'w',
    caller: 'me',
    model: 'meta-llama-3-70b',
    familyId: 'byok-compat-bbbbbbbb-meta-llama-3-70b',
  });
  assert.equal(plans.token, 'key-bbbbbbbb');
  assert.equal(plans.endpoint, 'https://bbbbbbbb.example.com/v1/');
  assert.equal(plans.model, 'Meta-Llama-3-70B');
  assert.equal(plans.maxInputTokens, 128000);
  assert.equal(await plans.next('reconnect'), null);
  assert.deepEqual(reconnects, [[candidateB.connectionId, 7]]);
});

test('a usage-limit refusal marks the plan limited and the plan that answers clears its own limit', async () => {
  const calls = [];
  const candidate = owner => ({ connectionId: `c-${owner}`, ownerMembershipId: owner, models: [], disabled: [] });
  const plans = await memberPlans({
    provider: 'claude',
    credentials: {
      accessToken: async (_, connectionId) => `token-${connectionId.slice(2)}`,
      requireReconnect: async () => undefined,
    },
    subscriptions: {
      eligible: async () => [candidate('me'), candidate('teammate'), candidate('team')],
      markUsed: async () => undefined,
      coolDown: async (_, connectionId, _retry, usageLimit) => calls.push(['coolDown', connectionId, usageLimit]),
      answered: async (_, connectionId) => calls.push(['answered', connectionId]),
    },
    workspaceId: 'w',
    caller: 'me',
    model: 'claude-sonnet-5',
  });
  await plans.next('usage-limit');
  await plans.next('rate-limit');
  await plans.answered();
  assert.deepEqual(calls, [
    ['coolDown', 'c-me', true],
    ['coolDown', 'c-teammate', false],
    ['answered', 'c-team'],
  ]);
});

test('a turn asks for plans on for chats, with the plan its member picked first', async () => {
  const asked = [];
  await memberPlans({
    provider: 'claude',
    credentials: { accessToken: async () => 'token', requireReconnect: async () => undefined },
    subscriptions: {
      eligible: async (...args) => (asked.push(args.slice(1)), []),
      markUsed: async () => undefined,
    },
    workspaceId: 'w',
    caller: 'me',
    model: 'claude-sonnet-5',
    preferredConnectionId: 'picked',
  });
  assert.deepEqual(asked, [['claude', 'me', 'chat', 'picked']]);
});
