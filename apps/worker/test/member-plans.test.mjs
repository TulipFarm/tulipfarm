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
  assert.equal(await plans.next('usage-limit'), 'token-teammate');
  assert.equal(plans.own(), false);
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
