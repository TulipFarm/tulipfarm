import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { TokenPlanError } from '@tulipfarm/integrations/token-plans';
import { codingRunServices } from '../src/coding-runs.ts';

function withFlags(t, flags) {
  for (const [name, value] of Object.entries(flags)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

function services(candidates, tokens) {
  const used = [];
  const asked = [];
  return {
    used,
    asked,
    value: codingRunServices({}, async () => 'approved', {
      subscriptions: {
        eligible: async (_workspaceId, provider, membershipId) => (asked.push([provider, membershipId]), candidates),
        markUsed: async (_workspaceId, connectionId) => void used.push(connectionId),
      },
      credentials: () => ({
        accessToken: async (_workspaceId, owner) => {
          const token = tokens[owner];
          if (token instanceof Error) throw token;
          return token;
        },
        requireReconnect: async () => undefined,
      }),
      github: async () => null,
    }),
  };
}

test('a coding run uses the first eligible plan that gives a token, in the resolver order', async t => {
  withFlags(t, { FEATURE_FLAG_CLAUDE_PLAN: 'true', FEATURE_FLAG_CODING_RUNS: 'true' });
  const [own, shared] = [randomUUID(), randomUUID()];
  const candidates = [
    { connectionId: 'own', ownerMembershipId: own, models: [], disabled: [] },
    { connectionId: 'shared', ownerMembershipId: shared, models: [], disabled: [] },
  ];
  const member = randomUUID();
  const { value, used, asked } = services(candidates, {
    [own]: new TokenPlanError('claude', 'reconnect-required'),
    [shared]: 'token',
  });
  assert.equal(await value.enabled(randomUUID()), true);
  assert.deepEqual(await value.plan(randomUUID(), member, 'claude'), {
    connectionId: 'shared',
    ownerMembershipId: shared,
    token: 'token',
  });
  assert.deepEqual(used, ['shared']);
  assert.deepEqual(asked, [['claude', member]]);
  assert.equal(await value.hasPlan(randomUUID(), member, 'claude'), true);
});

test('a coding run has no plan while the provider plan flag is off or no plan gives a token', async t => {
  withFlags(t, { FEATURE_FLAG_CHATGPT_PLAN: 'false', FEATURE_FLAG_CODING_RUNS: 'false' });
  const owner = randomUUID();
  const candidate = { connectionId: 'c', ownerMembershipId: owner, models: [], disabled: [] };
  const off = services([candidate], { [owner]: 'token' });
  assert.equal(await off.value.enabled(randomUUID()), false);
  assert.equal(await off.value.plan(randomUUID(), randomUUID(), 'chatgpt'), null);
  assert.equal(await off.value.hasPlan(randomUUID(), randomUUID(), 'chatgpt'), false);
  assert.deepEqual(off.asked, []);

  withFlags(t, { FEATURE_FLAG_COPILOT_PLAN: 'true' });
  const signedOut = services([candidate], { [owner]: new TokenPlanError('copilot', 'reconnect-required') });
  assert.equal(await signedOut.value.plan(randomUUID(), randomUUID(), 'copilot'), null);
  assert.deepEqual(signedOut.used, []);
});
