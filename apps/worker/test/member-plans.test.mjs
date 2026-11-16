import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberPlans } from '../src/member-plans.ts';

test('own tells whether the plan tried last belongs to the caller', async () => {
  process.env.FEATURE_FLAG_CLAUDE_PLAN = 'true';
  const candidate = owner => ({ connectionId: `c-${owner}`, ownerMembershipId: owner, models: [], disabled: [] });
  const plans = await memberPlans({
    provider: 'claude',
    credentials: { accessToken: async (_, owner) => `token-${owner}`, requireReconnect: async () => undefined },
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
